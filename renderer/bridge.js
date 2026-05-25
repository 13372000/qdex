function subscribeTauri(eventApi, eventName, listener) {
  let cleanup = null;
  void eventApi.listen(eventName, (event) => listener(event.payload)).then((unlisten) => {
    cleanup = unlisten;
  });
  return () => cleanup?.();
}

function tauriBridge(tauri) {
  const invoke = tauri.core.invoke;
  const events = tauri.event;

  return {
    getState: () => invoke("get_state"),
    attachActive: () => invoke("attach_active"),
    downloadAssets: () => invoke("download_assets"),
    close: () => invoke("close"),
    hideToTray: () => invoke("hide_to_tray"),
    minimize: () => invoke("minimize"),
    readText: (payload) => invoke("read_text", { payload }),
    setSettingsPanelOpen: (open) => invoke("set_settings_panel_open", { open }),
    setSettings: (settings) => invoke("set_settings", { settings }),
    skipSpeech: () => invoke("skip_speech"),
    testVoice: (settings) => invoke("test_voice", { settings }),
    onActivity: (listener) => subscribeTauri(events, "reader:activity", listener),
    onAudio: (listener) => subscribeTauri(events, "reader:audio", listener),
    onOutput: (listener) => subscribeTauri(events, "reader:output", listener),
    onSession: (listener) => subscribeTauri(events, "reader:session", listener),
    onStatus: (listener) => subscribeTauri(events, "reader:status", listener),
    onStopAudio: (listener) => subscribeTauri(events, "reader:stop-audio", listener),
    onUsage: (listener) => subscribeTauri(events, "reader:usage", listener)
  };
}

if (!window.codexReader && window.__TAURI__) {
  window.codexReader = tauriBridge(window.__TAURI__);
}
