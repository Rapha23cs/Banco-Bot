const { app, BrowserWindow, ipcMain, shell, Tray, Menu, Notification, safeStorage, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const updater = require('./updater');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let currentSyncProcess = null;
let schedulerTimer = null;
let currentSession = null;
let latestUpdateCheck = null;
let downloadedUpdatePath = null;
const loginAttempts = { count: 0, lockedUntil: 0 };

const APP_ROOT = __dirname;
const SCRIPTS_ROOT = app.isPackaged ? process.resourcesPath : __dirname;

function isDirWritable(dirPath) {
  try {
    if (!dirPath || !fs.existsSync(dirPath)) return false;
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveDataRoot() {
  if (!app.isPackaged) {
    return __dirname;
  }

  // Versão Portátil (.exe): usa a pasta onde o executável portátil reside (ou a pasta do projeto se rodado de dist/)
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    const parentDir = path.dirname(portableDir);
    if (
      path.basename(portableDir).toLowerCase() === 'dist' &&
      fs.existsSync(path.join(parentDir, '.env')) &&
      isDirWritable(parentDir)
    ) {
      return parentDir;
    }
    if (isDirWritable(portableDir)) {
      return portableDir;
    }
  }

  // Versão Instalada (NSIS) ou fallback seguro: pasta AppData gravável do usuário
  return app.getPath('userData');
}

const DATA_ROOT = resolveDataRoot();
try {
  if (!fs.existsSync(DATA_ROOT)) {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
  }
} catch { }

const ENV_PATH = path.join(DATA_ROOT, '.env');
const LOGS_DIR = path.join(DATA_ROOT, 'logs');
const AUDIT_LOG_PATH = path.join(LOGS_DIR, 'audit.jsonl');
const SCHEDULER_PATH = path.join(DATA_ROOT, 'scheduler.json');
const AUTH_CACHE_PATH = path.join(DATA_ROOT, '.auth-cache.json');
const ICON_PATH = path.join(APP_ROOT, 'assets', 'icon.png');
const PYTHON_CMD = 'python';

function getPythonEnv() {
  return {
    ...process.env,
    ECOSYNC_DATA_DIR: DATA_ROOT
  };
}

const DEFAULT_SCHEDULER = {
  enabled: false,
  intervalMinutes: 60,
  direction: 'push',
  noDelete: true,
  onlyIfChanges: true,
  maxDeletesAuto: 20,
  blockUsersAuto: true,
  minimizeToTray: true,
  lastRunAt: null,
  lastStatus: null,
  nextRunAt: null
};

// --------------------------------------------------------------------------
// Utilitários de Segurança, Sessão e Auditoria
// --------------------------------------------------------------------------
function appendAuditLog(entry) {
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    const record = {
      timestamp: new Date().toISOString(),
      userEmail: currentSession?.email || 'AUTONOMO',
      userPerfil: currentSession?.perfil || 'SYSTEM',
      ...entry
    };
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(record) + '\n', 'utf-8');
  } catch (err) {
    console.error('Falha ao gravar log de auditoria:', err.message);
  }
}

function requireAuth(allowedProfiles = null) {
  if (!currentSession) {
    return { success: false, error: 'Autenticação necessária.', code: 'AUTH_REQUIRED' };
  }
  if (Array.isArray(allowedProfiles) && !allowedProfiles.includes(currentSession.perfil)) {
    return {
      success: false,
      error: `Ação restrita a administradores (seu perfil: ${currentSession.perfil}).`,
      code: 'FORBIDDEN'
    };
  }
  return null;
}

function sendNativeNotification(title, body) {
  try {
    if (!Notification.isSupported()) return;
    new Notification({
      title,
      body,
      icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined
    }).show();
  } catch { }
}

function saveOfflineAuthCache(userWithHash) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    let cache = {};
    if (fs.existsSync(AUTH_CACHE_PATH)) {
      try {
        cache = JSON.parse(fs.readFileSync(AUTH_CACHE_PATH, 'utf-8')) || {};
      } catch {
        cache = {};
      }
    }
    const secretPayload = JSON.stringify({
      id: userWithHash.id,
      nome: userWithHash.nome,
      email: userWithHash.email,
      cargo: userWithHash.cargo || '',
      perfil: userWithHash.perfil,
      senha_hash: userWithHash.senha_hash
    });
    cache[userWithHash.email.toLowerCase()] = safeStorage.encryptString(secretPayload).toString('base64');
    fs.writeFileSync(AUTH_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
  } catch { }
}

function verifyOfflineAuthCache(email, password) {
  try {
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(AUTH_CACHE_PATH)) return null;
    const cache = JSON.parse(fs.readFileSync(AUTH_CACHE_PATH, 'utf-8')) || {};
    const enc = cache[email.toLowerCase()];
    if (!enc) return null;
    const raw = safeStorage.decryptString(Buffer.from(enc, 'base64'));
    const user = JSON.parse(raw);
    if (!user?.senha_hash) return null;
    if (!bcrypt.compareSync(password, user.senha_hash)) return null;
    return {
      id: user.id,
      nome: user.nome,
      email: user.email,
      cargo: user.cargo || '',
      perfil: user.perfil
    };
  } catch {
    return null;
  }
}

function readAuditLogs(limit = 100) {
  try {
    if (!fs.existsSync(AUDIT_LOG_PATH)) return [];
    const lines = fs.readFileSync(AUDIT_LOG_PATH, 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function maskUrl(url) {
  if (!url) return '';
  try {
    const idx = url.indexOf('://');
    if (idx === -1) return url;
    const prefix = url.slice(0, idx);
    const rest = url.slice(idx + 3);
    const atIdx = rest.lastIndexOf('@');
    if (atIdx === -1) return url;
    const creds = rest.slice(0, atIdx);
    const host = rest.slice(atIdx + 1);
    const user = creds.split(':')[0];
    return `${prefix}://${user}:****@${host}`;
  } catch {
    return url;
  }
}

function runPythonBridge(args, stdinObj = null) {
  return new Promise((resolve) => {
    const bridgeScript = path.join(SCRIPTS_ROOT, 'api_bridge.py');
    const proc = spawn(PYTHON_CMD, [bridgeScript, ...args], {
      cwd: DATA_ROOT,
      env: getPythonEnv(),
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';

    if (stdinObj !== null && proc.stdin) {
      try {
        proc.stdin.write(JSON.stringify(stdinObj));
        proc.stdin.end();
      } catch { }
    }

    proc.stdout.on('data', (d) => { stdout += d.toString('utf-8'); });
    proc.stderr.on('data', (d) => { stderr += d.toString('utf-8'); });

    proc.on('close', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({ success: false, error: 'Resposta JSON inválida do backend Python.' });
        }
      } else {
        resolve({ success: false, error: stderr || stdout || 'Erro ao executar diagnóstico Python.' });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, error: 'Erro ao invocar Python: ' + err.message });
    });
  });
}

function parseEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const lines = fs.readFileSync(ENV_PATH, 'utf-8').split(/\r?\n/);
  const map = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eqIdx = line.indexOf('=');
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (val.length >= 2 && val[0] === val[val.length - 1] && (val[0] === '"' || val[0] === "'")) {
      val = val.slice(1, -1);
    }
    map[key] = val;
  }
  return map;
}

function hasControlChars(str) {
  return /[\r\n\0]/.test(str);
}

function isValidPgUrl(url) {
  if (!url || hasControlChars(url)) return false;
  return /^(postgres|postgresql):\/\/.+/.test(url.trim());
}

function sanitizeTablesFilter(tablesFilter) {
  if (typeof tablesFilter !== 'string') return '';
  const cleaned = tablesFilter.trim();
  if (!cleaned) return '';
  if (!/^[a-zA-Z0-9_,\s]+$/.test(cleaned)) return '';
  return cleaned
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(',');
}

// --------------------------------------------------------------------------
// Agendador Inteligente (EcoSync Autonomous Scheduler)
// --------------------------------------------------------------------------
function readSchedulerConfig() {
  try {
    if (!fs.existsSync(SCHEDULER_PATH)) {
      return { ...DEFAULT_SCHEDULER };
    }
    const raw = JSON.parse(fs.readFileSync(SCHEDULER_PATH, 'utf-8'));
    return {
      ...DEFAULT_SCHEDULER,
      ...raw,
      intervalMinutes: Math.max(5, Math.min(1440, Number(raw.intervalMinutes) || 60)),
      direction: raw.direction === 'pull' ? 'pull' : 'push',
      noDelete: raw.noDelete !== false,
      onlyIfChanges: raw.onlyIfChanges !== false,
      maxDeletesAuto: Math.max(0, Math.min(10000, Number(raw.maxDeletesAuto ?? 20))),
      blockUsersAuto: raw.blockUsersAuto !== false,
      minimizeToTray: raw.minimizeToTray !== false,
      enabled: Boolean(raw.enabled)
    };
  } catch {
    return { ...DEFAULT_SCHEDULER };
  }
}

function writeSchedulerConfig(cfg) {
  try {
    const dir = path.dirname(SCHEDULER_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SCHEDULER_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (err) {
    console.error('Falha ao salvar configuração do agendador:', err.message);
  }
}

async function executeScheduledCycle() {
  const cfg = readSchedulerConfig();
  if (!cfg.enabled) return;

  if (currentSyncProcess) {
    mainWindow?.webContents.send('scheduler-event', {
      type: 'skipped',
      message: 'Ciclo automático adiado: sincronização manual em andamento.'
    });
    return;
  }

  try {
    const diffArgs = ['diff', cfg.direction];
    if (cfg.noDelete) diffArgs.push('--no-delete');
    const diffRes = await runPythonBridge(diffArgs);

    if (!diffRes?.success) {
      cfg.lastRunAt = new Date().toISOString();
      cfg.lastStatus = 'Erro de conexão';
      cfg.nextRunAt = new Date(Date.now() + cfg.intervalMinutes * 60000).toISOString();
      writeSchedulerConfig(cfg);
      sendNativeNotification('EcoSync Bot • Erro no Ciclo', diffRes?.error || 'Falha de conexão com o banco.');
      mainWindow?.webContents.send('scheduler-event', { type: 'error', config: cfg, message: diffRes?.error });
      return;
    }

    if (cfg.onlyIfChanges && diffRes.total_changes === 0) {
      cfg.lastRunAt = new Date().toISOString();
      cfg.lastStatus = 'Sem divergências (ignorado)';
      cfg.nextRunAt = new Date(Date.now() + cfg.intervalMinutes * 60000).toISOString();
      writeSchedulerConfig(cfg);
      appendAuditLog({
        action: 'auto_sync_check',
        direction: cfg.direction,
        mode: cfg.noDelete ? 'incremental' : 'mirror',
        success: true,
        durationMs: 0
      });
      mainWindow?.webContents.send('scheduler-event', {
        type: 'checked_clean',
        config: cfg,
        message: 'EcoSync vigia: bancos 100% idênticos, nenhuma ação necessária.'
      });
      return;
    }

    // Trava Anti-Catástrofe do Robô Autônomo
    const exceedsDeletes = !cfg.noDelete && diffRes.total_deletes > cfg.maxDeletesAuto;
    const touchesUsers = cfg.blockUsersAuto && diffRes.affects_users;
    if (exceedsDeletes || touchesUsers) {
      const reasons = [];
      if (exceedsDeletes) reasons.push(`${diffRes.total_deletes} remoções (> limite ${cfg.maxDeletesAuto})`);
      if (touchesUsers) reasons.push('tabela usuarios afetada');
      const blockMsg = `Trava de Segurança: ${reasons.join(' e ')}. Ação automática bloqueada.`;
      cfg.lastRunAt = new Date().toISOString();
      cfg.lastStatus = blockMsg;
      cfg.nextRunAt = new Date(Date.now() + cfg.intervalMinutes * 60000).toISOString();
      writeSchedulerConfig(cfg);
      appendAuditLog({
        action: 'auto_sync_blocked_safety',
        direction: cfg.direction,
        mode: blockMsg,
        success: false
      });
      sendNativeNotification('EcoSync Bot • Execução Bloqueada por Segurança', blockMsg);
      mainWindow?.webContents.send('scheduler-event', {
        type: 'blocked_safety',
        config: cfg,
        message: blockMsg
      });
      return;
    }

    // Executa sincronização automática
    const syncScript = path.join(SCRIPTS_ROOT, 'sync_prod.py');
    const args = [syncScript, cfg.direction === 'pull' ? '--pull' : '--push', '--yes'];
    if (cfg.noDelete) args.push('--no-delete');

    const startedAt = Date.now();
    currentSyncProcess = spawn(PYTHON_CMD, args, {
      cwd: DATA_ROOT,
      env: getPythonEnv(),
      windowsHide: true
    });

    let outputLog = '';
    currentSyncProcess.stdout.on('data', (d) => {
      const txt = d.toString('utf-8');
      outputLog += txt;
      mainWindow?.webContents.send('sync-output', { type: 'stdout', text: txt });
    });
    currentSyncProcess.stderr.on('data', (d) => {
      mainWindow?.webContents.send('sync-output', { type: 'stderr', text: d.toString('utf-8') });
    });

    currentSyncProcess.on('close', (code) => {
      const durationMs = Date.now() - startedAt;
      currentSyncProcess = null;
      cfg.lastRunAt = new Date().toISOString();
      cfg.lastStatus = code === 0 ? 'Sincronizado automaticamente' : `Falha (código ${code})`;
      cfg.nextRunAt = new Date(Date.now() + cfg.intervalMinutes * 60000).toISOString();
      writeSchedulerConfig(cfg);

      appendAuditLog({
        action: 'auto_sync_execute',
        direction: cfg.direction,
        mode: cfg.noDelete ? 'incremental' : 'mirror',
        success: code === 0,
        exitCode: code,
        durationMs
      });

      if (code === 0) {
        sendNativeNotification('EcoSync Bot • Sincronização Concluída', `Ciclo ${cfg.direction.toUpperCase()} concluído com sucesso.`);
      } else {
        sendNativeNotification('EcoSync Bot • Falha na Sincronização', cfg.lastStatus);
      }

      mainWindow?.webContents.send('scheduler-event', {
        type: code === 0 ? 'cycle-done' : 'cycle-error',
        config: cfg,
        message: cfg.lastStatus
      });
    });
  } catch (err) {
    currentSyncProcess = null;
    mainWindow?.webContents.send('scheduler-event', { type: 'error', message: err.message });
  }
}

function setupSchedulerTimer() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  const cfg = readSchedulerConfig();
  if (!cfg.enabled) {
    cfg.nextRunAt = null;
    writeSchedulerConfig(cfg);
    return;
  }

  const intervalMs = cfg.intervalMinutes * 60000;
  if (!cfg.nextRunAt || new Date(cfg.nextRunAt).getTime() <= Date.now()) {
    cfg.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    writeSchedulerConfig(cfg);
  }

  schedulerTimer = setInterval(() => {
    executeScheduledCycle();
  }, intervalMs);
}

// --------------------------------------------------------------------------
// Janela Principal (Com Sandbox & Hardening de Segurança)
// --------------------------------------------------------------------------
function createWindow() {
  const indexHtmlPath = path.join(APP_ROOT, 'src', 'index.html');

  mainWindow = new BrowserWindow({
    width: 1300,
    height: 850,
    minWidth: 1040,
    minHeight: 700,
    frame: false,
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    backgroundColor: '#060911',
    show: false,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      disableBlinkFeatures: 'Auxclick'
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const expected = 'file:///' + indexHtmlPath.replace(/\\/g, '/');
    if (decodeURI(targetUrl).toLowerCase() !== expected.toLowerCase()) {
      event.preventDefault();
    }
  });

  mainWindow.loadFile(indexHtmlPath);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    setupSchedulerTimer();
  });

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window-maximized', true);
  });

  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window-maximized', false);
  });

  mainWindow.on('close', (event) => {
    const cfg = readSchedulerConfig();
    if (!isQuitting && cfg.enabled && cfg.minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
      sendNativeNotification('EcoSync Bot em Segundo Plano', 'O robô autônomo continua ativo na bandeja do sistema.');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function setupTray() {
  if (tray || !fs.existsSync(ICON_PATH)) return;
  try {
    const img = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip('EcoSync Bot • SGA 360°');
    const menu = Menu.buildFromTemplate([
      {
        label: 'Abrir EcoSync Bot',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          } else {
            createWindow();
          }
        }
      },
      {
        label: 'Executar Ciclo Agora',
        click: () => executeScheduledCycle()
      },
      { type: 'separator' },
      {
        label: 'Sair Completamente',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);
    tray.setContextMenu(menu);
    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch { }
}

app.whenReady().then(() => {
  createWindow();
  setupTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (currentSyncProcess) {
    try {
      currentSyncProcess.kill();
    } catch { }
    currentSyncProcess = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --------------------------------------------------------------------------
// IPC Handlers - Controles de Janela
// --------------------------------------------------------------------------
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());

// --------------------------------------------------------------------------
// IPC Handlers - Autenticação Segura & RBAC (Tabela usuarios + Offline DPAPI)
// --------------------------------------------------------------------------
ipcMain.handle('auth-session', async () => ({
  success: true,
  authenticated: Boolean(currentSession),
  user: currentSession
}));

ipcMain.handle('auth-login', async (_event, creds = {}) => {
  const now = Date.now();
  if (loginAttempts.lockedUntil > now) {
    const secs = Math.ceil((loginAttempts.lockedUntil - now) / 1000);
    return { success: false, error: `Muitas tentativas falhas. Aguarde ${secs}s.` };
  }

  const email = typeof creds?.email === 'string' ? creds.email.trim() : '';
  const password = typeof creds?.password === 'string' ? creds.password : '';
  if (!email || !password) {
    return { success: false, error: 'Informe e-mail e senha.' };
  }

  const lookup = await runPythonBridge(['auth-lookup'], { email });

  if (lookup?.success && lookup?.db_online) {
    const user = lookup.user;
    if (!lookup.found || !user || !user.senha_hash) {
      loginAttempts.count++;
      if (loginAttempts.count >= 5) {
        loginAttempts.lockedUntil = now + 30000;
        loginAttempts.count = 0;
      }
      appendAuditLog({ action: 'auth_login_failed', mode: email, success: false });
      return { success: false, error: 'E-mail ou senha inválidos.' };
    }

    if (!user.ativo || user.status_aprovacao !== 'APROVADO') {
      appendAuditLog({ action: 'auth_login_blocked', mode: email, success: false });
      return { success: false, error: 'Usuário inativo ou pendente de aprovação.' };
    }

    const ok = bcrypt.compareSync(password, user.senha_hash);
    if (!ok) {
      loginAttempts.count++;
      if (loginAttempts.count >= 5) {
        loginAttempts.lockedUntil = now + 30000;
        loginAttempts.count = 0;
      }
      appendAuditLog({ action: 'auth_login_failed', mode: email, success: false });
      return { success: false, error: 'E-mail ou senha inválidos.' };
    }

    loginAttempts.count = 0;
    loginAttempts.lockedUntil = 0;
    saveOfflineAuthCache(user);

    currentSession = {
      id: user.id,
      nome: user.nome,
      email: user.email,
      cargo: user.cargo || '',
      perfil: user.perfil,
      loginAt: new Date().toISOString(),
      offlineMode: false
    };

    runPythonBridge(['touch-login', String(user.id), lookup.source_db || 'local']).catch(() => { });
    appendAuditLog({ action: 'auth_login_success', mode: `db:${lookup.source_db}`, success: true });
    return { success: true, user: currentSession };
  }

  // Fallback seguro via Windows DPAPI caso ambos os bancos estejam offline
  const cachedUser = verifyOfflineAuthCache(email, password);
  if (cachedUser) {
    loginAttempts.count = 0;
    currentSession = {
      ...cachedUser,
      loginAt: new Date().toISOString(),
      offlineMode: true
    };
    appendAuditLog({ action: 'auth_login_offline', mode: 'safeStorage', success: true });
    return { success: true, user: currentSession };
  }

  loginAttempts.count++;
  if (loginAttempts.count >= 5) {
    loginAttempts.lockedUntil = now + 30000;
    loginAttempts.count = 0;
  }
  return {
    success: false,
    error: lookup?.error
      ? `Bancos inacessíveis (${lookup.error}) e nenhuma credencial offline validada.`
      : 'E-mail ou senha inválidos.'
  };
});

ipcMain.handle('auth-logout', async () => {
  if (currentSession) {
    appendAuditLog({ action: 'auth_logout', success: true });
  }
  currentSession = null;
  return { success: true };
});

// --------------------------------------------------------------------------
// IPC Handlers - Diagnóstico, Insights, Schema, Diff & Backups
// --------------------------------------------------------------------------
ipcMain.handle('get-status', async () => requireAuth() || runPythonBridge(['status']));
ipcMain.handle('get-insights', async () => requireAuth() || runPythonBridge(['insights']));

ipcMain.handle('get-table-schema', async (_event, tableName) => {
  const denied = requireAuth();
  if (denied) return denied;
  if (typeof tableName !== 'string' || !/^[a-zA-Z0-9_]+$/.test(tableName)) {
    return { success: false, error: 'Nome de tabela inválido.' };
  }
  return runPythonBridge(['schema', tableName]);
});

ipcMain.handle('get-diff', async (_event, params = {}) => {
  const denied = requireAuth();
  if (denied) return denied;
  const direction = params?.direction === 'pull' ? 'pull' : 'push';
  const args = ['diff', direction];
  if (params?.noDelete === true) args.push('--no-delete');
  const safeTables = sanitizeTablesFilter(params?.tablesFilter);
  if (safeTables) args.push(`--tables=${safeTables}`);
  return runPythonBridge(args);
});

ipcMain.handle('get-diff-detail', async (_event, params = {}) => {
  const denied = requireAuth();
  if (denied) return denied;
  const direction = params?.direction === 'pull' ? 'pull' : 'push';
  const tableName = typeof params?.tableName === 'string' ? params.tableName : '';
  if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
    return { success: false, error: 'Nome de tabela inválido.' };
  }
  const args = ['diff-detail', direction, tableName];
  if (params?.noDelete === true) args.push('--no-delete');
  return runPythonBridge(args);
});

ipcMain.handle('get-backups', async () => requireAuth() || runPythonBridge(['backups']));

ipcMain.handle('preview-backup', async (_event, params = {}) => {
  const denied = requireAuth();
  if (denied) return denied;
  const folder = params?.folder === 'local' ? 'local' : (params?.folder === 'prod' ? 'prod' : '');
  const filename = typeof params?.filename === 'string' ? params.filename : '';
  if (!folder || !/^[a-zA-Z0-9_.-]+\.json$/.test(filename)) {
    return { success: false, error: 'Parâmetros de backup inválidos.' };
  }
  return runPythonBridge(['preview', folder, filename]);
});

ipcMain.handle('cleanup-backups', async (_event, keep = 10) => {
  const denied = requireAuth(['ADMIN']);
  if (denied) return denied;
  const safeKeep = Math.max(3, Math.min(100, Number(keep) || 10));
  const res = await runPythonBridge(['cleanup_backups', String(safeKeep)]);
  if (res?.success) {
    appendAuditLog({
      action: 'backups_cleanup',
      mode: `keep_${safeKeep} (${res.removed_files} removidos)`,
      success: true
    });
  }
  return res;
});

ipcMain.handle('restore-backup', async (_event, params = {}) => {
  const denied = requireAuth(['ADMIN']);
  if (denied) return denied;
  const folder = params?.folder === 'local' ? 'local' : (params?.folder === 'prod' ? 'prod' : '');
  const filename = typeof params?.filename === 'string' ? params.filename : '';
  if (!folder || !/^[a-zA-Z0-9_.-]+\.json$/.test(filename)) {
    return { success: false, error: 'Parâmetros de backup inválidos.' };
  }
  const startedAt = Date.now();
  const res = await runPythonBridge(['restore', folder, filename]);
  appendAuditLog({
    action: 'backup_restore',
    direction: folder,
    mode: filename,
    success: Boolean(res?.success),
    durationMs: Date.now() - startedAt
  });
  return res;
});

ipcMain.handle('run-maintenance', async (_event, target = 'both') => {
  const denied = requireAuth(['ADMIN']);
  if (denied) return denied;
  const safeTarget = ['local', 'prod', 'both'].includes(target) ? target : 'both';
  const startedAt = Date.now();
  const res = await runPythonBridge(['maintenance', safeTarget]);
  appendAuditLog({
    action: 'pg_analyze',
    mode: safeTarget,
    success: Boolean(res?.success),
    durationMs: Date.now() - startedAt
  });
  return res;
});

ipcMain.handle('get-audit-logs', async () => requireAuth() || ({
  success: true,
  logs: readAuditLogs(100)
}));

// --------------------------------------------------------------------------
// IPC Handlers - Agendador Inteligente
// --------------------------------------------------------------------------
ipcMain.handle('get-scheduler', async () => requireAuth() || ({
  success: true,
  config: readSchedulerConfig(),
  rootDir: DATA_ROOT
}));

ipcMain.handle('save-scheduler', async (_event, rawConfig = {}) => {
  const denied = requireAuth(['ADMIN']);
  if (denied) return denied;
  const current = readSchedulerConfig();
  const intervalMinutes = Math.max(5, Math.min(1440, Number(rawConfig.intervalMinutes) || 60));
  const updated = {
    ...current,
    enabled: Boolean(rawConfig.enabled),
    intervalMinutes,
    direction: rawConfig.direction === 'pull' ? 'pull' : 'push',
    noDelete: rawConfig.noDelete !== false,
    onlyIfChanges: rawConfig.onlyIfChanges !== false,
    maxDeletesAuto: Math.max(0, Math.min(10000, Number(rawConfig.maxDeletesAuto ?? 20))),
    blockUsersAuto: rawConfig.blockUsersAuto !== false,
    minimizeToTray: rawConfig.minimizeToTray !== false,
    nextRunAt: rawConfig.enabled ? new Date(Date.now() + intervalMinutes * 60000).toISOString() : null
  };
  writeSchedulerConfig(updated);
  setupSchedulerTimer();
  appendAuditLog({
    action: updated.enabled ? 'scheduler_enabled' : 'scheduler_disabled',
    direction: updated.direction,
    mode: `${updated.intervalMinutes}m`,
    success: true
  });
  return { success: true, config: updated };
});

// --------------------------------------------------------------------------
// IPC Handlers - Execução Segura da Sincronização (sync_prod.py)
// --------------------------------------------------------------------------
ipcMain.handle('run-sync', (event, params = {}) => {
  const isDryRun = Boolean(params?.isDryRun);
  const denied = requireAuth(isDryRun ? null : ['ADMIN']);
  if (denied) return denied;

  if (currentSyncProcess) {
    return { success: false, error: 'Já existe uma sincronização em andamento.' };
  }

  const direction = params?.direction === 'pull' ? 'pull' : 'push';
  const noDelete = Boolean(params?.noDelete);
  const safeTables = sanitizeTablesFilter(params?.tablesFilter);

  const syncScript = path.join(SCRIPTS_ROOT, 'sync_prod.py');
  const args = [syncScript, direction === 'pull' ? '--pull' : '--push'];
  if (isDryRun) {
    args.push('--dry-run');
  } else {
    args.push('--yes');
  }
  if (noDelete) args.push('--no-delete');
  if (safeTables) args.push('--tables', safeTables);

  const startedAt = Date.now();
  currentSyncProcess = spawn(PYTHON_CMD, args, {
    cwd: DATA_ROOT,
    env: getPythonEnv(),
    windowsHide: true
  });

  currentSyncProcess.stdout.on('data', (data) => {
    event.sender.send('sync-output', { type: 'stdout', text: data.toString('utf-8') });
  });

  currentSyncProcess.stderr.on('data', (data) => {
    event.sender.send('sync-output', { type: 'stderr', text: data.toString('utf-8') });
  });

  currentSyncProcess.on('close', (code) => {
    const durationMs = Date.now() - startedAt;
    currentSyncProcess = null;

    appendAuditLog({
      action: isDryRun ? 'sync_dry_run' : 'sync_execute',
      direction,
      mode: (noDelete ? 'incremental' : 'mirror') + (safeTables ? ' [parcial]' : ''),
      success: code === 0,
      exitCode: code,
      durationMs
    });

    event.sender.send('sync-done', { code, success: code === 0, durationMs });
  });

  currentSyncProcess.on('error', (err) => {
    currentSyncProcess = null;
    appendAuditLog({
      action: isDryRun ? 'sync_dry_run' : 'sync_execute',
      direction,
      success: false,
      error: err.message
    });
    event.sender.send('sync-output', { type: 'stderr', text: 'Erro ao iniciar processo: ' + err.message + '\n' });
    event.sender.send('sync-done', { code: -1, success: false });
  });

  return { success: true };
});

ipcMain.handle('cancel-sync', () => {
  const denied = requireAuth();
  if (denied) return denied;
  if (currentSyncProcess) {
    currentSyncProcess.kill();
    currentSyncProcess = null;
    appendAuditLog({ action: 'sync_cancelled', success: false });
    return { success: true, message: 'Operação cancelada pelo usuário.' };
  }
  return { success: false, message: 'Nenhuma sincronização em andamento.' };
});

// --------------------------------------------------------------------------
// IPC Handlers - Arquivos e Configurações Seguras (.env)
// --------------------------------------------------------------------------
ipcMain.handle('open-folder', async (_event, folderName) => {
  const denied = requireAuth();
  if (denied) return denied;
  const allowed = {
    root: DATA_ROOT,
    backups_prod: path.join(DATA_ROOT, 'backups_prod'),
    backups_local: path.join(DATA_ROOT, 'backups_local'),
    logs: LOGS_DIR
  };
  const targetPath = allowed[folderName];
  if (!targetPath) return { success: false, error: 'Pasta não permitida.' };

  if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
  await shell.openPath(targetPath);
  return { success: true };
});

ipcMain.handle('read-env-config', async () => {
  const denied = requireAuth();
  if (denied) return denied;
  const isAdmin = currentSession?.perfil === 'ADMIN';
  const envMap = parseEnvFile();
  const localUrl = envMap.LOCAL_DATABASE_URL || envMap.DATABASE_URL || '';
  const prodUrl = envMap.PROD_DATABASE_URL || '';
  const updateUrl = envMap.APP_UPDATE_URL || '';
  const updateToken = envMap.APP_UPDATE_TOKEN || '';

  return {
    success: fs.existsSync(ENV_PATH),
    readOnly: !isAdmin,
    config: {
      localUrl: isAdmin ? localUrl : '',
      prodUrl: isAdmin ? prodUrl : '',
      localUrlMasked: maskUrl(localUrl),
      prodUrlMasked: maskUrl(prodUrl),
      direction: (envMap.SYNC_DIRECTION || 'push').toLowerCase() === 'pull' ? 'pull' : 'push',
      autoConfirm: ['true', '1', 'sim', 'yes'].includes((envMap.SYNC_AUTO_CONFIRM || 'false').toLowerCase()),
      deleteMissing: !['false', '0', 'no', 'nao'].includes((envMap.SYNC_DELETE_MISSING || 'true').toLowerCase()),
      excludeTables: envMap.SYNC_EXCLUDE_TABLES || '',
      updateUrl: isAdmin ? updateUrl : maskUrl(updateUrl),
      updateToken: isAdmin ? updateToken : ''
    }
  };
});

ipcMain.handle('save-env-config', async (_event, config = {}) => {
  const denied = requireAuth(['ADMIN']);
  if (denied) return denied;
  try {
    const localUrl = (config.localUrl || '').trim();
    const prodUrl = (config.prodUrl || '').trim();
    const direction = config.direction === 'pull' ? 'pull' : 'push';
    const autoConfirm = Boolean(config.autoConfirm) ? 'true' : 'false';
    const deleteMissing = config.deleteMissing === false ? 'false' : 'true';
    const excludeTables = (config.excludeTables || '').trim();
    const updateUrl = (config.updateUrl || '').trim();
    const updateToken = (config.updateToken || '').trim();

    if (!isValidPgUrl(localUrl)) {
      return { success: false, error: 'URL do banco Local inválida. Deve iniciar com postgresql:// e não conter quebras de linha.' };
    }
    if (prodUrl && !isValidPgUrl(prodUrl)) {
      return { success: false, error: 'URL do banco de Produção inválida. Deve iniciar com postgresql:// e não conter quebras de linha.' };
    }
    if (prodUrl && localUrl === prodUrl) {
      return { success: false, error: 'A URL do banco Local e de Produção não podem ser idênticas.' };
    }
    if (excludeTables && (!/^[a-zA-Z0-9_,\s]+$/.test(excludeTables) || hasControlChars(excludeTables))) {
      return { success: false, error: 'Lista de tabelas ignoradas contém caracteres inválidos.' };
    }
    if (updateUrl && !updater.isValidUpdateSource(updateUrl)) {
      return { success: false, error: 'Endereço de atualização (APP_UPDATE_URL) inválido.' };
    }
    if (updateToken && hasControlChars(updateToken)) {
      return { success: false, error: 'Token de atualização contém caracteres inválidos.' };
    }

    if (fs.existsSync(ENV_PATH)) {
      fs.copyFileSync(ENV_PATH, path.join(DATA_ROOT, '.env.bak'));
    }

    const lines = [
      '# ==============================================================================',
      '# EcoSync Bot • SGA 360° Robô de Sincronização de Banco de Dados',
      '# ==============================================================================',
      `DATABASE_URL=${localUrl}`,
      `LOCAL_DATABASE_URL=${localUrl}`,
      prodUrl ? `PROD_DATABASE_URL=${prodUrl}` : '# PROD_DATABASE_URL=',
      `SYNC_DIRECTION=${direction}`,
      `SYNC_AUTO_CONFIRM=${autoConfirm}`,
      `SYNC_DELETE_MISSING=${deleteMissing}`,
      excludeTables ? `SYNC_EXCLUDE_TABLES=${excludeTables}` : '# SYNC_EXCLUDE_TABLES=',
      updateUrl ? `APP_UPDATE_URL=${updateUrl}` : '# APP_UPDATE_URL=',
      updateToken ? `APP_UPDATE_TOKEN=${updateToken}` : '# APP_UPDATE_TOKEN='
    ];

    fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf-8');
    appendAuditLog({
      action: 'env_updated',
      direction,
      autoConfirm: autoConfirm === 'true',
      deleteMissing: deleteMissing === 'true',
      success: true
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('open-env-external', async () => {
  const denied = requireAuth(['ADMIN']);
  if (denied) return denied;
  if (fs.existsSync(ENV_PATH)) {
    await shell.openPath(ENV_PATH);
    return { success: true };
  }
  return { success: false, error: 'Arquivo .env não encontrado.' };
});

// --------------------------------------------------------------------------
// IPC Handlers - Auto-Atualização Universal (NSIS Installer & Portátil .exe)
// --------------------------------------------------------------------------
ipcMain.handle('get-app-info', async () => {
  const ctx = updater.getExeContext();
  const envMap = parseEnvFile();
  return {
    success: true,
    ...ctx,
    updateUrlConfigured: Boolean((envMap.APP_UPDATE_URL || '').trim())
  };
});

ipcMain.handle('check-for-updates', async () => {
  const denied = requireAuth();
  if (denied) return denied;
  const envMap = parseEnvFile();
  const res = await updater.checkForUpdates(envMap.APP_UPDATE_URL || '', envMap.APP_UPDATE_TOKEN || '');
  if (res.success && res.updateAvailable && res.update) {
    latestUpdateCheck = res.update;
    downloadedUpdatePath = null;
  }
  appendAuditLog({
    action: 'update_check',
    mode: res.exeType || 'unknown',
    success: Boolean(res.success),
    updateAvailable: Boolean(res.updateAvailable),
    targetVersion: res.update?.version || null
  });
  return res;
});

ipcMain.handle('download-update', async () => {
  const denied = requireAuth();
  if (denied) return denied;
  if (!latestUpdateCheck) {
    return { success: false, error: 'Nenhuma atualização pendente foi verificada.' };
  }
  const envMap = parseEnvFile();
  const res = await updater.downloadUpdateArtifact(
    latestUpdateCheck,
    (progress) => {
      mainWindow?.webContents.send('update-progress', progress);
    },
    envMap.APP_UPDATE_TOKEN || ''
  );
  if (res.success) {
    downloadedUpdatePath = res.filePath;
  }
  appendAuditLog({
    action: 'update_download',
    targetVersion: latestUpdateCheck.version,
    file: res.fileName || latestUpdateCheck.fileName,
    success: Boolean(res.success),
    error: res.error || null
  });
  return res;
});

ipcMain.handle('install-update', async () => {
  const denied = requireAuth();
  if (denied) return denied;
  const ctx = updater.getExeContext();
  const res = updater.applyDownloadedUpdate(downloadedUpdatePath, () => {
    isQuitting = true;
  });
  appendAuditLog({
    action: 'update_install',
    mode: ctx.exeType,
    targetVersion: latestUpdateCheck?.version || null,
    success: Boolean(res.success),
    error: res.error || null
  });
  return res;
});
