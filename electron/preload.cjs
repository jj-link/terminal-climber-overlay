const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = Object.freeze({
  command: 'overlay:command',
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
  onCommand: subscribe(CHANNELS.command, (command) => [command]),
  onTerminalSnapshot: subscribe(CHANNELS.terminalSnapshot, (snapshot) => [snapshot]),
  onTerminalStatus: subscribe(CHANNELS.terminalStatus, (message) => [message.status, message.reason]),
});
