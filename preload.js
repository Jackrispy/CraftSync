const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('craftsync', {
  // Auth
  login:          () => ipcRenderer.invoke('auth:login'),
  logout:         () => ipcRenderer.invoke('auth:logout'),
  checkAuth:      () => ipcRenderer.invoke('auth:check'),

  // Members
  setOnline:      (data) => ipcRenderer.invoke('members:setOnline', data),
  setOffline:     () => ipcRenderer.invoke('members:setOffline'),
  listMembers:    () => ipcRenderer.invoke('members:list'),

  // Config & Friends
  getConfig:          () => ipcRenderer.invoke('config:get'),
  initConfig:         (data) => ipcRenderer.invoke('config:init', data),
  getOwnerDriveId:    () => ipcRenderer.invoke('owner:get-drive-id'),
  getStorageQuota:    () => ipcRenderer.invoke('storage:get-quota'),
  generateInvite:     () => ipcRenderer.invoke('friends:generate-invite'),
  redeemInvite:       (data) => ipcRenderer.invoke('friends:redeem-invite', data),
  listLocalFriends:   () => ipcRenderer.invoke('friends:list-local'),
  removeLocalFriend:  (data) => ipcRenderer.invoke('friends:remove-local', data),
  listFriends:        () => ipcRenderer.invoke('friends:list'),
  addFriend:          (data) => ipcRenderer.invoke('friends:add', data),
  removeFriend:       (data) => ipcRenderer.invoke('friends:remove', data),

  // Worlds
  listWorlds:     ()       => ipcRenderer.invoke('worlds:list'),
  addWorld:       (data)   => ipcRenderer.invoke('worlds:add', data),
  playWorld:      (data)   => ipcRenderer.invoke('worlds:play', data),
  joinWorld:      (data)   => ipcRenderer.invoke('worlds:join', data),
  uploadWorld:    (data)   => ipcRenderer.invoke('worlds:upload', data),
  downloadModpack:(data)   => ipcRenderer.invoke('worlds:download-modpack', data),
  uploadModpack:      (data) => ipcRenderer.invoke('worlds:upload-modpack', data),
  syncMods:           (data) => ipcRenderer.invoke('worlds:sync-mods', data),
  checkProfileExists: (data) => ipcRenderer.invoke('worlds:check-profile-exists', data),
  deleteWorld:        (data) => ipcRenderer.invoke('worlds:delete', data),
  uploadCache:    (data)   => ipcRenderer.invoke('worlds:upload-cache', data),
  downloadCache:  (data)   => ipcRenderer.invoke('worlds:download-cache', data),
  updateWorldVersion: (data) => ipcRenderer.invoke('worlds:update-version', data),

  // Minecraft process control
  mcKill:         () => ipcRenderer.invoke('mc:kill'),
  mcStatus:       () => ipcRenderer.invoke('mc:status'),
  saveSavesPath:      (data) => ipcRenderer.invoke('worlds:save-saves-path', data),
  getSavesPaths:      () => ipcRenderer.invoke('worlds:get-saves-paths'),
  saveModpackDownload:(data) => ipcRenderer.invoke('worlds:save-modpack-downloaded', data),
  getModpackDownloads:() => ipcRenderer.invoke('worlds:get-modpack-downloads'),

  // Minecraft events (push from main → renderer)
  onMcLog:        (cb) => ipcRenderer.on('mc:log',          (_, data) => cb(data)),
  onMcClosed:     (cb) => ipcRenderer.on('mc:closed',       (_, data) => cb(data)),
  onMcJoinClosed: (cb) => ipcRenderer.on('mc:join-closed',  (_, data) => cb(data)),
  onMcUploaded:   (cb) => ipcRenderer.on('mc:uploaded',     (_, data) => cb(data)),
  onMcUploadError:(cb) => ipcRenderer.on('mc:upload-error', (_, data) => cb(data)),
  onProgress:     (cb) => ipcRenderer.on('progress:update', (_, data) => cb(data)),
  cancelOperation: () => ipcRenderer.invoke('operation:cancel'),

  // Dialogs
  openFolder:     (options) => ipcRenderer.invoke('dialog:open-folder', options),
  openMrpack:     () => ipcRenderer.invoke('dialog:open-mrpack'),
  getFolderSize:  (data) => ipcRenderer.invoke('fs:folder-size', data),

  // Window controls
  minimize:       () => ipcRenderer.invoke('window:minimize'),
  maximize:       () => ipcRenderer.invoke('window:maximize'),
  close:          () => ipcRenderer.invoke('window:close'),

  // Shell
  openPath:       (p) => ipcRenderer.invoke('shell:open', p),
})

