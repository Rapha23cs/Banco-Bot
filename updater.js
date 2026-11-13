const { app, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const UPDATES_TEMP_DIR = path.join(app.getPath('temp'), 'ecosync-updates');

function getExeContext() {
  const version = app.getVersion();
  if (!app.isPackaged) {
    return { version, exeType: 'dev', exeLabel: 'Modo Desenvolvimento', currentExePath: process.execPath };
  }
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    return {
      version,
      exeType: 'portable',
      exeLabel: 'Executável Portátil (Portable)',
      currentExePath: process.env.PORTABLE_EXECUTABLE_FILE
    };
  }
  return {
    version,
    exeType: 'nsis',
    exeLabel: 'Instalador Windows (NSIS)',
    currentExePath: process.execPath
  };
}

function compareSemver(a, b) {
  const parse = (v) =>
    String(v || '0.0.0')
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .slice(0, 3)
      .map((n) => parseInt(n, 10) || 0);

  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function isValidUpdateSource(src) {
  if (!src) return true;
  if (/[\r\n\0;|&<>`]/.test(src)) return false;
  const s = src.trim();
  return /^(https?:\/\/.+|\\\\[^\\]+\\.+|[a-zA-Z]:[\\/].+)$/.test(s);
}

function isHttpUrl(src) {
  return /^https?:\/\//i.test(String(src || '').trim());
}

function normalizeGithubApiUrl(rawUrl) {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  const ghMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/releases.*)?$/i);
  if (ghMatch) {
    return `https://api.github.com/repos/${ghMatch[1]}/${ghMatch[2]}/releases/latest`;
  }
  return null;
}

function httpGetBuffer(targetUrl, token = '', redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Limite de redirecionamentos HTTP atingido.'));
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return reject(new Error('URL de atualização inválida.'));
    }

    const headers = {
      'User-Agent': `EcoSync-Bot/${app.getVersion()}`,
      Accept: 'application/vnd.github+json, application/json'
    };
    if (token && parsed.hostname === 'api.github.com') {
      headers.Authorization = `Bearer ${token}`;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(
      parsed,
      { headers, timeout: 15000 },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, parsed).href;
          return httpGetBuffer(nextUrl, token, redirects + 1).then(resolve, reject);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          const err = new Error(`Servidor respondeu HTTP ${res.statusCode} ao consultar atualizações.`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ buffer: Buffer.concat(chunks), finalUrl: targetUrl }));
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('Tempo limite excedido ao consultar atualizações.'));
    });
    req.on('error', reject);
  });
}

function pickManifestTarget(manifest, exeType) {
  const desired = exeType === 'nsis' ? 'nsis' : 'portable';
  const fallback = desired === 'nsis' ? 'portable' : 'nsis';
  if (manifest[desired]?.url || manifest[desired]?.file) return { kind: desired, entry: manifest[desired] };
  if (manifest[fallback]?.url || manifest[fallback]?.file) return { kind: fallback, entry: manifest[fallback] };
  return null;
}

function pickGithubAsset(assets, exeType) {
  const exeAssets = (assets || []).filter((a) => /\.exe$/i.test(a.name || ''));
  if (exeAssets.length === 0) return null;
  const setupAsset = exeAssets.find((a) => /setup/i.test(a.name));
  const portableAsset = exeAssets.find((a) => !/setup/i.test(a.name));
  if (exeType === 'nsis') return { kind: setupAsset ? 'nsis' : 'portable', asset: setupAsset || portableAsset || exeAssets[0] };
  return { kind: portableAsset ? 'portable' : 'nsis', asset: portableAsset || setupAsset || exeAssets[0] };
}

function scanLocalUpdateDir(dirPath, exeType) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const candidates = [];
  for (const ent of entries) {
    if (!ent.isFile() || !/\.exe$/i.test(ent.name)) continue;
    const isSetup = /setup\s+(\d+\.\d+\.\d+)\.exe$/i.test(ent.name);
    const match = ent.name.match(/(\d+\.\d+\.\d+)\.exe$/i);
    if (!match) continue;
    const fullPath = path.join(dirPath, ent.name);
    const stat = fs.statSync(fullPath);
    candidates.push({
      version: match[1],
      kind: isSetup ? 'nsis' : 'portable',
      file: ent.name,
      url: fullPath,
      size: stat.size
    });
  }
  if (candidates.length === 0) return null;

  const versions = [...new Set(candidates.map((c) => c.version))].sort(compareSemver);
  const highestVersion = versions[versions.length - 1];
  const ofVersion = candidates.filter((c) => c.version === highestVersion);
  const preferred = ofVersion.find((c) => c.kind === (exeType === 'nsis' ? 'nsis' : 'portable')) || ofVersion[0];
  return {
    version: highestVersion,
    releaseDate: null,
    notes: `Nova versão detectada na pasta de atualizações (${preferred.file}).`,
    pickedKind: preferred.kind,
    fileName: preferred.file,
    downloadUrl: preferred.url,
    size: preferred.size,
    sha256: null,
    isLocalFile: true
  };
}

async function checkForUpdates(rawSource, token = '') {
  const ctx = getExeContext();
  const source = String(rawSource || '').trim();
  const authToken = String(token || '').trim();
  if (!source) {
    return {
      success: false,
      notConfigured: true,
      currentVersion: ctx.version,
      exeType: ctx.exeType,
      exeLabel: ctx.exeLabel,
      error: 'Fonte de atualização (APP_UPDATE_URL) ainda não configurada nas Configurações (.env).'
    };
  }
  if (!isValidUpdateSource(source)) {
    return { success: false, error: 'Endereço APP_UPDATE_URL inválido ou bloqueado por segurança.' };
  }

  try {
    let remote = null;

    if (isHttpUrl(source)) {
      const ghUrl = normalizeGithubApiUrl(source);
      if (ghUrl || /api\.github\.com\/repos\/.+\/releases/i.test(source)) {
        const apiUrl = ghUrl || source;
        let rel;
        try {
          const { buffer } = await httpGetBuffer(apiUrl, authToken);
          rel = JSON.parse(buffer.toString('utf-8'));
        } catch (err) {
          if (err.statusCode === 404) {
            const repoApiUrl = apiUrl.replace(/\/releases\/latest$/i, '');
            try {
              await httpGetBuffer(repoApiUrl, authToken);
              return {
                success: true,
                updateAvailable: false,
                noReleasesYet: true,
                currentVersion: ctx.version,
                exeType: ctx.exeType,
                exeLabel: ctx.exeLabel,
                message: 'Repositório conectado, mas ainda não existe nenhuma Release publicada no GitHub.'
              };
            } catch (repoErr) {
              if (repoErr.statusCode === 404) {
                throw new Error(
                  'Repositório GitHub privado ou sem releases (HTTP 404). Informe um Token (APP_UPDATE_TOKEN), deixe o repo público, ou use uma URL HTTP / Pasta de Rede.'
                );
              }
              throw repoErr;
            }
          }
          throw err;
        }
        const version = String(rel.tag_name || rel.name || '').replace(/^v/i, '');
        const picked = pickGithubAsset(rel.assets, ctx.exeType);
        if (!version || !picked) {
          throw new Error('Release do GitHub encontrada, mas sem arquivo .exe compatível nos assets.');
        }
        remote = {
          version,
          releaseDate: rel.published_at ? rel.published_at.slice(0, 10) : null,
          notes: rel.body || `Release ${rel.tag_name || version}`,
          pickedKind: picked.kind,
          fileName: picked.asset.name,
          downloadUrl: authToken && picked.asset.url ? picked.asset.url : picked.asset.browser_download_url,
          isGithubAssetApi: Boolean(authToken && picked.asset.url),
          size: picked.asset.size || 0,
          sha256: null,
          isLocalFile: false
        };
      } else {
        const manifestUrl = /\.json(\?.*)?$/i.test(source)
          ? source
          : `${source.replace(/\/+$/, '')}/latest.json`;
        const { buffer, finalUrl } = await httpGetBuffer(manifestUrl);
        const manifest = JSON.parse(buffer.toString('utf-8'));
        const picked = pickManifestTarget(manifest, ctx.exeType);
        if (!manifest.version || !picked) {
          throw new Error('Manifesto latest.json inválido ou sem binário compatível.');
        }
        const relOrAbs = picked.entry.url || picked.entry.file;
        const resolvedUrl = new URL(relOrAbs, finalUrl).href;
        remote = {
          version: String(manifest.version).replace(/^v/i, ''),
          releaseDate: manifest.releaseDate || null,
          notes: manifest.notes || `Versão ${manifest.version}`,
          pickedKind: picked.kind,
          fileName: picked.entry.file || path.basename(new URL(resolvedUrl).pathname),
          downloadUrl: resolvedUrl,
          size: picked.entry.size || 0,
          sha256: picked.entry.sha256 || null,
          isLocalFile: false
        };
      }
    } else {
      if (!fs.existsSync(source)) {
        throw new Error(`Pasta ou arquivo de atualização não acessível: ${source}`);
      }
      const stat = fs.statSync(source);
      const manifestPath = stat.isDirectory() ? path.join(source, 'latest.json') : source;
      if (fs.existsSync(manifestPath) && /\.json$/i.test(manifestPath)) {
        const baseDir = path.dirname(manifestPath);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const picked = pickManifestTarget(manifest, ctx.exeType);
        if (!manifest.version || !picked) {
          throw new Error('Manifesto local latest.json sem binário compatível.');
        }
        const rawTarget = picked.entry.url || picked.entry.file;
        const localExePath = path.isAbsolute(rawTarget) ? rawTarget : path.join(baseDir, rawTarget);
        remote = {
          version: String(manifest.version).replace(/^v/i, ''),
          releaseDate: manifest.releaseDate || null,
          notes: manifest.notes || `Versão ${manifest.version}`,
          pickedKind: picked.kind,
          fileName: picked.entry.file || path.basename(localExePath),
          downloadUrl: localExePath,
          size: picked.entry.size || (fs.existsSync(localExePath) ? fs.statSync(localExePath).size : 0),
          sha256: picked.entry.sha256 || null,
          isLocalFile: !isHttpUrl(localExePath)
        };
      } else if (stat.isDirectory()) {
        remote = scanLocalUpdateDir(source, ctx.exeType);
        if (!remote) {
          throw new Error('Nenhum latest.json ou executável com versão (X.Y.Z.exe) encontrado na pasta.');
        }
      } else {
        throw new Error('Caminho local deve ser uma pasta ou um arquivo latest.json.');
      }
    }

    const updateAvailable = compareSemver(remote.version, ctx.version) > 0;
    return {
      success: true,
      updateAvailable,
      currentVersion: ctx.version,
      exeType: ctx.exeType,
      exeLabel: ctx.exeLabel,
      update: remote
    };
  } catch (err) {
    return {
      success: false,
      currentVersion: ctx.version,
      exeType: ctx.exeType,
      exeLabel: ctx.exeLabel,
      error: err.message
    };
  }
}

function downloadHttpToFile(targetUrl, destPath, onProgress, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Limite de redirecionamentos excedido ao baixar atualização.'));
    const parsed = new URL(targetUrl);
    const headers = { 'User-Agent': `EcoSync-Bot/${app.getVersion()}` };
    if (options.token && parsed.hostname === 'api.github.com') {
      headers.Authorization = `Bearer ${options.token}`;
      headers.Accept = 'application/octet-stream';
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(
      parsed,
      { headers, timeout: 30000 },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, parsed).href;
          return downloadHttpToFile(nextUrl, destPath, onProgress, options, redirects + 1).then(resolve, reject);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`Falha HTTP ${res.statusCode} ao baixar binário.`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10) || 0;
        let downloaded = 0;
        let lastEmit = 0;
        const hash = crypto.createHash('sha256');
        const out = fs.createWriteStream(destPath);

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          hash.update(chunk);
          const now = Date.now();
          if (now - lastEmit >= 120 || (totalBytes > 0 && downloaded >= totalBytes)) {
            lastEmit = now;
            onProgress?.({
              phase: 'downloading',
              downloaded,
              total: totalBytes,
              percent: totalBytes > 0 ? Math.min(100, Math.round((downloaded / totalBytes) * 100)) : null
            });
          }
        });

        res.pipe(out);
        out.on('finish', () => {
          out.close(() => resolve({ size: downloaded, sha256: hash.digest('hex') }));
        });
        out.on('error', (err) => {
          try { fs.unlinkSync(destPath); } catch {}
          reject(err);
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('Tempo limite excedido no download da atualização.')));
    req.on('error', (err) => {
      try { fs.unlinkSync(destPath); } catch {}
      reject(err);
    });
  });
}

function copyLocalWithProgress(srcPath, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(srcPath)) {
      return reject(new Error(`Arquivo de atualização não encontrado: ${srcPath}`));
    }
    const stat = fs.statSync(srcPath);
    const totalBytes = stat.size;
    let copied = 0;
    const hash = crypto.createHash('sha256');
    const reader = fs.createReadStream(srcPath);
    const writer = fs.createWriteStream(destPath);

    reader.on('data', (chunk) => {
      copied += chunk.length;
      hash.update(chunk);
      onProgress?.({
        phase: 'downloading',
        downloaded: copied,
        total: totalBytes,
        percent: totalBytes > 0 ? Math.min(100, Math.round((copied / totalBytes) * 100)) : 100
      });
    });

    reader.on('error', reject);
    writer.on('error', reject);
    writer.on('finish', () => resolve({ size: copied, sha256: hash.digest('hex') }));
    reader.pipe(writer);
  });
}

function isValidPeExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 1024 * 1024) return false;
    const fd = fs.openSync(filePath, 'r');
    const hdr = Buffer.alloc(2);
    fs.readSync(fd, hdr, 0, 2, 0);
    fs.closeSync(fd);
    return hdr.toString('ascii') === 'MZ';
  } catch {
    return false;
  }
}

async function downloadUpdateArtifact(updateInfo, onProgress, token = '') {
  if (!updateInfo?.downloadUrl) {
    return { success: false, error: 'URL de download não informada.' };
  }
  const safeName = path.basename(updateInfo.fileName || `EcoSync-${updateInfo.version || 'new'}.exe`);
  if (!/\.exe$/i.test(safeName)) {
    return { success: false, error: 'O arquivo de atualização deve ser um executável .exe válido.' };
  }

  if (!fs.existsSync(UPDATES_TEMP_DIR)) {
    fs.mkdirSync(UPDATES_TEMP_DIR, { recursive: true });
  }
  const destPath = path.join(UPDATES_TEMP_DIR, safeName);

  try {
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
  } catch {}

  try {
    let result;
    if (updateInfo.isLocalFile && !isHttpUrl(updateInfo.downloadUrl)) {
      result = await copyLocalWithProgress(updateInfo.downloadUrl, destPath, onProgress);
    } else {
      result = await downloadHttpToFile(updateInfo.downloadUrl, destPath, onProgress, { token });
    }

    onProgress?.({ phase: 'verifying', percent: 100, downloaded: result.size, total: result.size });

    if (!isValidPeExecutable(destPath)) {
      try { fs.unlinkSync(destPath); } catch {}
      throw new Error('O arquivo baixado não é um executável Windows (.exe PE) válido.');
    }

    if (updateInfo.sha256 && result.sha256.toLowerCase() !== String(updateInfo.sha256).trim().toLowerCase()) {
      try { fs.unlinkSync(destPath); } catch {}
      throw new Error('Falha na verificação de integridade SHA-256 do executável.');
    }

    return {
      success: true,
      filePath: destPath,
      fileName: safeName,
      size: result.size,
      sha256: result.sha256
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function applyDownloadedUpdate(downloadedFilePath, onBeforeQuit) {
  const ctx = getExeContext();
  if (!downloadedFilePath || !fs.existsSync(downloadedFilePath) || !isValidPeExecutable(downloadedFilePath)) {
    return { success: false, error: 'Arquivo de atualização baixado ausente ou inválido.' };
  }

  if (ctx.exeType === 'dev') {
    shell.showItemInFolder(downloadedFilePath);
    return {
      success: true,
      devMode: true,
      message: `Modo Desenvolvimento: novo .exe salvo em ${downloadedFilePath}. Feche o app e execute o binário manualmente.`,
      filePath: downloadedFilePath
    };
  }

  if (ctx.exeType === 'nsis') {
    onBeforeQuit?.();
    const child = spawn(downloadedFilePath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
    setTimeout(() => app.quit(), 350);
    return { success: true, exeType: 'nsis', message: 'Instalador iniciado. O EcoSync Bot será atualizado e reiniciado.' };
  }

  // Portable: cria script temporário que aguarda o processo atual liberar o arquivo, substitui e reabre
  const batPath = path.join(UPDATES_TEMP_DIR, 'apply_portable_update.cmd');
  const scriptContent = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal enableextensions',
    'set /a TRIES=0',
    ':waitloop',
    'timeout /t 1 /nobreak >nul',
    'copy /y "%SOURCE_EXE%" "%TARGET_EXE%" >nul 2>&1',
    'if not errorlevel 1 goto finish',
    'set /a TRIES+=1',
    'if %TRIES% lss 25 goto waitloop',
    'exit /b 1',
    ':finish',
    'del /f /q "%SOURCE_EXE%" >nul 2>&1',
    'start "" "%TARGET_EXE%"',
    'del /f /q "%~f0" >nul 2>&1'
  ].join('\r\n');

  fs.writeFileSync(batPath, scriptContent, 'utf-8');
  onBeforeQuit?.();

  const child = spawn('cmd.exe', ['/d', '/c', batPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      SOURCE_EXE: downloadedFilePath,
      TARGET_EXE: ctx.currentExePath
    }
  });
  child.unref();
  setTimeout(() => app.quit(), 350);
  return {
    success: true,
    exeType: 'portable',
    message: 'Substituindo executável portátil e reiniciando o EcoSync Bot...'
  };
}

module.exports = {
  getExeContext,
  compareSemver,
  isValidUpdateSource,
  checkForUpdates,
  downloadUpdateArtifact,
  applyDownloadedUpdate
};

