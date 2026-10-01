const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('launcher', {
  getSettings: () => invoke('settings:get'),
  saveSettings: (patch) => invoke('settings:save', patch),
  listVersions: () => invoke('versions:list'),

  listAccounts: () => invoke('accounts:list'),
  selectAccount: (id) => invoke('accounts:select', id),
  removeAccount: (id) => invoke('accounts:remove', id),
  addOfflineAccount: (name) => invoke('accounts:addOffline', name),
  loginStart: () => invoke('accounts:loginStart'),
  loginFinish: () => invoke('accounts:loginFinish'),
  loginCancel: () => invoke('accounts:loginCancel'),
  copyCodeAndOpen: (code, url) => invoke('accounts:copyCodeAndOpen', code, url),

  listInstances: () => invoke('instances:list'),
  createInstance: (options) => invoke('instances:create', options),
  deleteInstance: (id) => invoke('instances:delete', id),
  openFolder: (id) => invoke('instances:openFolder', id),
  setSync: (id, item, enabled) => invoke('instances:setSync', id, item, enabled),
  launch: (id) => invoke('instances:launch', id),

  listMods: (id) => invoke('mods:list', id),
  removeMod: (id, file) => invoke('mods:remove', id, file),
  search: (id, query, type, offset) => invoke('modrinth:search', id, query, type, offset),
  install: (id, projectId, type) => invoke('modrinth:install', id, projectId, type),
  openExternal: (url) => invoke('openExternal', url),

  listServers: () => invoke('servers:list'),
  addServer: () => invoke('servers:add'),
  removeServer: (id) => invoke('servers:remove', id),
  openServerFolder: (id) => invoke('servers:openFolder', id),
  startServer: (id) => invoke('servers:start', id),
  stopServer: (id) => invoke('servers:stop', id),
  serverCommand: (id, text) => invoke('servers:command', id, text),
  joinServer: (id, instanceId) => invoke('servers:join', id, instanceId),

  onStatus: (callback) => ipcRenderer.on('status', (_event, data) => callback(data)),
  onLog: (callback) => ipcRenderer.on('log', (_event, data) => callback(data)),
  onServerStatus: (callback) => ipcRenderer.on('server-status', (_event, data) => callback(data)),
  onServerLog: (callback) => ipcRenderer.on('server-log', (_event, data) => callback(data)),
});
