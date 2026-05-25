param(
  [Parameter(Mandatory = $true)]
  [string]$Source,

  [Parameter(Mandatory = $true)]
  [string]$OutIco,

  [string]$OutPng = "",
  [int]$Size = 256,
  [int]$Margin = 6
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class QLinkCropIconNative {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool DestroyIcon(IntPtr hIcon);
}
"@

$sourceIcon = New-Object System.Drawing.Icon($Source)
$input = $sourceIcon.ToBitmap()
$sourceIcon.Dispose()

$width = $input.Width
$height = $input.Height
$minX = $width
$minY = $height
$maxX = -1
$maxY = -1

for ($y = 0; $y -lt $height; $y++) {
  for ($x = 0; $x -lt $width; $x++) {
    $pixel = $input.GetPixel($x, $y)
    $isContent = $pixel.A -gt 20 -and ($pixel.R -lt 245 -or $pixel.G -lt 245 -or $pixel.B -lt 245)
    if ($isContent) {
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}

if ($maxX -lt $minX -or $maxY -lt $minY) {
  throw "No non-white icon content found in $Source."
}

$cropWidth = $maxX - $minX + 1
$cropHeight = $maxY - $minY + 1
$target = $Size - ($Margin * 2)
$scale = [Math]::Min($target / $cropWidth, $target / $cropHeight)
$drawWidth = [int][Math]::Round($cropWidth * $scale)
$drawHeight = [int][Math]::Round($cropHeight * $scale)
$drawX = [int][Math]::Round(($Size - $drawWidth) / 2)
$drawY = [int][Math]::Round(($Size - $drawHeight) / 2)

$output = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($output)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.Clear([System.Drawing.Color]::Transparent)

$sourceRect = New-Object System.Drawing.Rectangle($minX, $minY, $cropWidth, $cropHeight)
$targetRect = New-Object System.Drawing.Rectangle($drawX, $drawY, $drawWidth, $drawHeight)
$graphics.DrawImage($input, $targetRect, $sourceRect, [System.Drawing.GraphicsUnit]::Pixel)
$graphics.Dispose()

if ($OutPng) {
  $pngParent = Split-Path -Parent $OutPng
  if ($pngParent) {
    New-Item -ItemType Directory -Force -Path $pngParent | Out-Null
  }
  $output.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
}

$icoParent = Split-Path -Parent $OutIco
if ($icoParent) {
  New-Item -ItemType Directory -Force -Path $icoParent | Out-Null
}

$iconHandle = $output.GetHicon()
try {
  $icon = [System.Drawing.Icon]::FromHandle($iconHandle)
  $stream = [System.IO.File]::Open($OutIco, [System.IO.FileMode]::Create)
  try {
    $icon.Save($stream)
  } finally {
    $stream.Dispose()
    $icon.Dispose()
  }
} finally {
  [QLinkCropIconNative]::DestroyIcon($iconHandle) | Out-Null
}

$input.Dispose()
$output.Dispose()

[PSCustomObject]@{
  source = $Source
  sourceSize = "${width}x${height}"
  crop = "$minX,$minY,$maxX,$maxY"
  output = $OutIco
  preview = $OutPng
} | ConvertTo-Json -Compress
