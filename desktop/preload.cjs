// Bridge between the desktop app and the demo page (window.lipscribeApp).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lipscribeApp', {
  isDesktop: true,
  shortcut: process.platform === 'darwin' ? '⌘⇧L' : 'Ctrl+Shift+L',
  onToggleRecording: (fn) => ipcRenderer.on('lipscribe:toggle-recording', () => fn()),
});
