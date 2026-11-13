const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const DIST_DIR = path.join(ROOT, 'dist');

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function main() {
  if (!fs.existsSync(PKG_PATH) || !fs.existsSync(DIST_DIR)) {
    console.log('[manifest] Diretório dist/ ou package.json ausente; pulando latest.json.');
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'));
  const version = pkg.version || '1.0.0';
  const productName = pkg.build?.productName || pkg.name || 'EcoSync Bot - SGA 360';

  const setupName = `${productName} Setup ${version}.exe`;
  const portableName = `${productName} ${version}.exe`;

  const setupPath = path.join(DIST_DIR, setupName);
  const portablePath = path.join(DIST_DIR, portableName);

  const manifest = {
    name: productName,
    version,
    releaseDate: new Date().toISOString().slice(0, 10),
    notes: `Versão ${version} do EcoSync Bot • SGA 360°`,
    nsis: null,
    portable: null
  };

  if (fs.existsSync(setupPath)) {
    const stat = fs.statSync(setupPath);
    manifest.nsis = {
      file: setupName,
      url: setupName,
      size: stat.size,
      sha256: sha256File(setupPath)
    };
  }

  if (fs.existsSync(portablePath)) {
    const stat = fs.statSync(portablePath);
    manifest.portable = {
      file: portableName,
      url: portableName,
      size: stat.size,
      sha256: sha256File(portablePath)
    };
  }

  const outPath = path.join(DIST_DIR, 'latest.json');
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  console.log(`[manifest] Gerado ${outPath} (nsis=${Boolean(manifest.nsis)}, portable=${Boolean(manifest.portable)})`);
}

main();

