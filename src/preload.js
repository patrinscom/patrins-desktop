const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('patrinsApp', {
  retryConnection: () => ipcRenderer.send('retry-connection'),

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

  // Find in page
  findInPage:    (text, opts) => ipcRenderer.send('find-in-page', text, opts || {}),
  stopFindInPage: ()          => ipcRenderer.send('stop-find-in-page'),
  onFindResult: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('find-result', h);
    return h;
  },
  offFindResult: (h) => ipcRenderer.removeListener('find-result', h),

  // Watch Folders
  getWatchFolders:    ()     => ipcRenderer.invoke('watchfolders:list'),
  addWatchFolder:     (path) => ipcRenderer.invoke('watchfolders:add', path),
  removeWatchFolder:  (path) => ipcRenderer.invoke('watchfolders:remove', path),
  getWatchFolderStatus: ()   => ipcRenderer.invoke('watchfolders:status'),
  onWatchFoldersChanged: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('sync:watch-folders-changed', h);
    return h;
  },
  onWatchStatus: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('sync:watch-status', h);
    return h;
  },

  // LAN P2P
  lanStart:    ()                      => ipcRenderer.invoke('lan:start'),
  lanStop:     ()                      => ipcRenderer.send('lan:stop'),
  lanPeers:    ()                      => ipcRenderer.invoke('lan:peers'),
  lanSendFile: (peerId, filePath)      => ipcRenderer.invoke('lan:send-file', { peerId, filePath }),
  onLanPeers: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('lan:peers', h);
    return h;
  },
  onLanFileReceived: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('lan:file-received', h);
    return h;
  },
  onLanSendProgress: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('lan:send-progress', h);
    return h;
  },

  // Shell integration events (context menu → upload here)
  onShellUploadHere: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('shell:upload-here', h);
    return h;
  },
});
