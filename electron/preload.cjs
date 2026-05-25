const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, listener) {
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("codexReader", {
  getState: () => ipcRenderer.invoke("reader:get-state"),
  attachActive: () => ipcRenderer.invoke("reader:attach-active"),
  downloadAssets: () => ipcRenderer.invoke("reader:download-assets"),
  close: () => ipcRenderer.invoke("reader:close"),
  hideToTray: () => ipcRenderer.invoke("reader:hide-to-tray"),
  minimize: () => ipcRenderer.invoke("reader:minimize"),
  readText: (payload) => ipcRenderer.invoke("reader:read-text", payload),
  setSettingsPanelOpen: (open) => ipcRenderer.invoke("reader:set-settings-panel-open", open),
  setSettings: (settings) => ipcRenderer.invoke("reader:set-settings", settings),
  skipSpeech: () => ipcRenderer.invoke("reader:skip-speech"),
  testVoice: (settings) => ipcRenderer.invoke("reader:test-voice", settings),
  onActivity: (listener) => subscribe("reader:activity", listener),
  onAudio: (listener) => subscribe("reader:audio", listener),
  onOutput: (listener) => subscribe("reader:output", listener),
  onSession: (listener) => subscribe("reader:session", listener),
  onStatus: (listener) => subscribe("reader:status", listener),
  onStopAudio: (listener) => subscribe("reader:stop-audio", listener),
  onUsage: (listener) => subscribe("reader:usage", listener)
});
