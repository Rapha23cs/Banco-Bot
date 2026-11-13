const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Controles de Janela
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  // Autenticação & Sessão
  authLogin: (creds) => ipcRenderer.invoke('auth-login', creds),
  authLogout: () => ipcRenderer.invoke('auth-logout'),
  getAuthSession: () => ipcRenderer.invoke('auth-session'),

  // Diagnóstico, Telemetria & Dados
  getStatus: () => ipcRenderer.invoke('get-status'),
  getInsights: () => ipcRenderer.invoke('get-insights'),
  getTableSchema: (tableName) => ipcRenderer.invoke('get-table-schema', tableName),
  getDiff: (params) => ipcRenderer.invoke('get-diff', params),
  getDiffDetail: (params) => ipcRenderer.invoke('get-diff-detail', params),
  getBackups: () => ipcRenderer.invoke('get-backups'),
  previewBackup: (params) => ipcRenderer.invoke('preview-backup', params),
  cleanupBackups: (keep) => ipcRenderer.invoke('cleanup-backups', keep),
  restoreBackup: (params) => ipcRenderer.invoke('restore-backup', params),
  runMaintenance: (target) => ipcRenderer.invoke('run-maintenance', target),
  getAuditLogs: () => ipcRenderer.invoke('get-audit-logs'),

  // Execução de Sincronização
  runSync: (params) => ipcRenderer.invoke('run-sync', params),
  cancelSync: () => ipcRenderer.invoke('cancel-sync'),

  // Agendador Inteligente (EcoSync Scheduler)
  getScheduler: () => ipcRenderer.invoke('get-scheduler'),
  saveScheduler: (config) => ipcRenderer.invoke('save-scheduler', config),

  // Configurações Seguras (.env)
  openFolder: (name) => ipcRenderer.invoke('open-folder', name),
  readEnvConfig: () => ipcRenderer.invoke('read-env-config'),
  saveEnvConfig: (config) => ipcRenderer.invoke('save-env-config', config),
  openEnvExternal: () => ipcRenderer.invoke('open-env-external'),

  // Atualizações Automáticas (NSIS & Portátil)
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateProgress: (callback) => {
    ipcRenderer.on('update-progress', (_event, data) => callback(data));
  },

  // Eventos em Tempo Real
  onSyncOutput: (callback) => {
    ipcRenderer.on('sync-output', (_event, data) => callback(data));
  },
  onSyncDone: (callback) => {
    ipcRenderer.on('sync-done', (_event, data) => callback(data));
  },
  onSchedulerEvent: (callback) => {
    ipcRenderer.on('scheduler-event', (_event, data) => callback(data));
  },
  onWindowMaximized: (callback) => {
    ipcRenderer.on('window-maximized', (_event, isMax) => callback(isMax));
  },
  removeSyncListeners: () => {
    ipcRenderer.removeAllListeners('sync-output');
    ipcRenderer.removeAllListeners('sync-done');
  }
});
