const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = Object.freeze({
  overlayState: 'overlay:state',
  getOverlayState: 'overlay:get-state',
  setClickThrough: 'overlay:set-click-through',
  setPaused: 'overlay:set-paused',
  reset: 'overlay:reset',
  command: 'overlay:command',
  quit: 'overlay:quit',
  terminalSnapshot: 'terminal:snapshot',
  terminalStatus: 'terminal:status',
});

function subscribe(channel, project) {
  return (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, ...args) => callback(...project(...args));
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('terminalClimberApi', {
  isDesktop: true,
  getState: () => ipcRenderer.invoke(CHANNELS.getOverlayState),
  setClickThrough: (enabled) => ipcRenderer.send(CHANNELS.setClickThrough, Boolean(enabled)),
  setPaused: (paused) => ipcRenderer.send(CHANNELS.setPaused, Boolean(paused)),
  reset: () => ipcRenderer.send(CHANNELS.reset),
  quit: () => ipcRenderer.send(CHANNELS.quit),
  onStateChanged: subscribe(CHANNELS.overlayState, (state) => [state]),
  onTerminalSnapshot: subscribe(CHANNELS.terminalSnapshot, (snapshot) => [snapshot]),
  onTerminalStatus: subscribe(CHANNELS.terminalStatus, (message) => [message.status, message.reason]),
  onCommand: subscribe(CHANNELS.command, (command) => [command]),
});
