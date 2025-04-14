// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  connectPlex: (config) => ipcRenderer.invoke('connect-plex', config),
  getServerStatus: () => ipcRenderer.invoke('get-server-status'),
  manualAdbReverse: () => ipcRenderer.invoke('manual-adb-reverse'),
  toggleAutoAdb: () => ipcRenderer.invoke('toggle-auto-adb'),
  pushBuild: (buildPath) => ipcRenderer.invoke('push-build', buildPath),
  getConfig: () => ipcRenderer.invoke('get-config'),
  updateDeviceIP: (newIP) => ipcRenderer.invoke('update-device-ip', newIP)
});
