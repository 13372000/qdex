param(
  [Parameter(Mandatory = $true)]
  [string]$TextPath,

  [string]$ProcessNames = "Codex",
  [string]$WindowTitlePattern = "Codex",
  [int]$FocusDelayMs = 350,
  [int]$AfterPasteDelayMs = 150,
  [string]$SubmitKeys = "{ENTER}",
  [string]$AutoSubmit = "1",
  [string]$ClickInput = "1",
  [double]$ClickXRatio = 0.5,
  [string]$ClickYMode = "bottom-offset",
  [int]$ClickBottomOffsetPx = 105,
  [double]$ClickYRatio = 0.925,
  [string]$RestoreClipboard = "1"
)

$ErrorActionPreference = "Stop"

function Test-Enabled([string]$Value) {
  return $Value -match '^(1|true|yes|on)$'
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class QLinkNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr SetActiveWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool BringWindowToTop(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("kernel32.dll")]
  public static extern uint GetCurrentThreadId();

  [DllImport("user32.dll")]
  public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);

  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@

function Bring-QLinkWindowToFront([IntPtr]$Handle, [int]$DelayMs) {
  $SW_RESTORE = 9
  $HWND_TOPMOST = [IntPtr]::new(-1)
  $HWND_NOTOPMOST = [IntPtr]::new(-2)
  $SWP_NOSIZE = 0x0001
  $SWP_NOMOVE = 0x0002
  $SWP_SHOWWINDOW = 0x0040
  $SWP_FLAGS = $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_SHOWWINDOW

  [QLinkNative]::ShowWindowAsync($Handle, $SW_RESTORE) | Out-Null
  Start-Sleep -Milliseconds $DelayMs

  $currentThread = [QLinkNative]::GetCurrentThreadId()
  $targetPid = 0
  $targetThread = [QLinkNative]::GetWindowThreadProcessId($Handle, [ref]$targetPid)
  $foreground = [QLinkNative]::GetForegroundWindow()
  $foregroundPid = 0
  $foregroundThread = if ($foreground -ne [IntPtr]::Zero) {
    [QLinkNative]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
  } else {
    0
  }

  $attachedTarget = $false
  $attachedForeground = $false
  try {
    if ($targetThread -ne 0 -and $targetThread -ne $currentThread) {
      $attachedTarget = [QLinkNative]::AttachThreadInput($currentThread, $targetThread, $true)
    }
    if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread -and $foregroundThread -ne $targetThread) {
      $attachedForeground = [QLinkNative]::AttachThreadInput($currentThread, $foregroundThread, $true)
    }

    [QLinkNative]::BringWindowToTop($Handle) | Out-Null
    [QLinkNative]::SetForegroundWindow($Handle) | Out-Null
    [QLinkNative]::SetActiveWindow($Handle) | Out-Null
    [QLinkNative]::SetWindowPos($Handle, $HWND_TOPMOST, 0, 0, 0, 0, $SWP_FLAGS) | Out-Null
    Start-Sleep -Milliseconds 80
    [QLinkNative]::SetWindowPos($Handle, $HWND_NOTOPMOST, 0, 0, 0, 0, $SWP_FLAGS) | Out-Null
    [QLinkNative]::SetForegroundWindow($Handle) | Out-Null
  } finally {
    if ($attachedForeground) {
      [QLinkNative]::AttachThreadInput($currentThread, $foregroundThread, $false) | Out-Null
    }
    if ($attachedTarget) {
      [QLinkNative]::AttachThreadInput($currentThread, $targetThread, $false) | Out-Null
    }
  }

  Start-Sleep -Milliseconds $DelayMs
}

$text = [System.IO.File]::ReadAllText($TextPath, [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($text)) {
  throw "Prompt text is empty."
}

$names = $ProcessNames.Split(",") |
  ForEach-Object { $_.Trim() } |
  Where-Object { $_ }

$candidates = Get-Process | Where-Object {
  $_.MainWindowHandle -ne 0 -and (
    ($names -contains $_.ProcessName) -or
    ($_.MainWindowTitle -match $WindowTitlePattern)
  )
}

$target = $candidates |
  Sort-Object `
    @{ Expression = { $_.MainWindowTitle -eq "Codex" }; Descending = $true },
    @{ Expression = { $_.StartTime }; Descending = $true } |
  Select-Object -First 1

if (-not $target) {
  throw "No Codex Desktop window found. Open Codex Desktop first, or adjust QLINK_TARGET_PROCESS_NAMES / QLINK_WINDOW_TITLE_PATTERN."
}

$handle = $target.MainWindowHandle
Bring-QLinkWindowToFront -Handle $handle -DelayMs $FocusDelayMs
[System.Windows.Forms.SendKeys]::SendWait("{ESC}")
Start-Sleep -Milliseconds 80

if (Test-Enabled $ClickInput) {
  $rect = New-Object QLinkNative+RECT
  if ([QLinkNative]::GetWindowRect($handle, [ref]$rect)) {
    $width = [Math]::Max(1, $rect.Right - $rect.Left)
    $height = [Math]::Max(1, $rect.Bottom - $rect.Top)
    $x = [int]($rect.Left + ($width * $ClickXRatio))
    if ($ClickYMode -match '^(bottom|bottom-offset|offset)$') {
      $y = [int]($rect.Bottom - $ClickBottomOffsetPx)
    } else {
      $y = [int]($rect.Top + ($height * $ClickYRatio))
    }
    $y = [Math]::Max($rect.Top + 1, [Math]::Min($rect.Bottom - 1, $y))
    [QLinkNative]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 80
    [QLinkNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [QLinkNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds $FocusDelayMs
    [System.Windows.Forms.SendKeys]::SendWait("{END}")
    Start-Sleep -Milliseconds 80
  }
}

$previousClipboard = $null
$hadTextClipboard = $false
if (Test-Enabled $RestoreClipboard) {
  try {
    $previousClipboard = Get-Clipboard -Raw
    $hadTextClipboard = $true
  } catch {
    $hadTextClipboard = $false
  }
}

Set-Clipboard -Value $text
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds $AfterPasteDelayMs
if ((Test-Enabled $AutoSubmit) -and -not [string]::IsNullOrWhiteSpace($SubmitKeys)) {
  [System.Windows.Forms.SendKeys]::SendWait($SubmitKeys)
  Start-Sleep -Milliseconds 100
}

if ((Test-Enabled $RestoreClipboard) -and $hadTextClipboard) {
  try {
    Set-Clipboard -Value $previousClipboard
  } catch {
  }
}

[PSCustomObject]@{
  ok = $true
  processId = $target.Id
  processName = $target.ProcessName
  windowTitle = $target.MainWindowTitle
  autoSubmit = (Test-Enabled $AutoSubmit)
  clickYMode = $ClickYMode
  clickBottomOffsetPx = $ClickBottomOffsetPx
} | ConvertTo-Json -Compress
