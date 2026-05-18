const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('patrinsApp', {
  retryConnection: () => ipcRenderer.send('retry-connection'),
  version: process.env.npm_package_version || '1.0.0',

  // OS-level download engine
  startDesktopDownload: (opts) => ipcRenderer.invoke('patrins-download', opts),
  cancelDesktopDownload: (downloadId) => ipcRenderer.send('patrins-download-cancel', downloadId),
  onDownloadProgress: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('download-progress', h);
    return h;
  },
  offDownloadProgress: (h) => ipcRenderer.removeListener('download-progress', h),
  showInFolder: (filePath) => ipcRenderer.send('show-in-folder', filePath),

  // Background folder sync
  getSyncStatus:  ()       => ipcRenderer.invoke('sync:get-status'),
  pickSyncFolder: ()       => ipcRenderer.invoke('sync:pick-folder'),
  setSyncConfig:  (config) => ipcRenderer.invoke('sync:set-config', config),
  pauseSync:  () => ipcRenderer.send('sync:pause'),
  resumeSync: () => ipcRenderer.send('sync:resume'),
  onSyncStatus: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('sync:status', h);
    return h;
  },
  offSyncStatus: (h) => ipcRenderer.removeListener('sync:status', h),

  // App update notifications
  onUpdateProgress: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('update:progress', h);
    return h;
  },
  onUpdateAvailable: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('update:available', h);
    return h;
  },
  onUpdateDownloaded: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('update:downloaded', h);
    return h;
  },
  offUpdateListener: (event, h) => ipcRenderer.removeListener(event, h),
  installUpdate: () => ipcRenderer.send('update:install'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  appVersion: () => ipcRenderer.invoke('app:version'),
});
