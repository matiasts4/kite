#!/usr/bin/env node
// One-command release: bump -> build -> sign -> latest.json -> publish.
//
//   npm run release -- patch                  # feed LOCAL (por defecto)
//   npm run release -- 1.2.0
//   npm run release -- patch --dry-run        # build + manifiestos en dist/release; restaura versión
//   npm run release -- patch --github         # publica en GitHub Releases (requiere gh + origin)
//   flags: --notes="texto"  --skip-tests  --feed-url=http://host:puerto
//
// Modo local (por defecto): copia instalador + firma + latest.json a dist/feed/<producto>/ y
// ARRANCA SOLO el servidor de feed (scripts/feed-server.mjs) si no está corriendo.
// Requiere clave de firma (TAURI_SIGNING_PRIVATE_KEY o ~/.tauri/kite.key).

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureFeedServer, FEED_PORT } from './feed-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || d;
const has = (n) => args.includes(`--${n}`);
const bumpArg = args.find((a) => !a.startsWith('--')) || 'patch';
const dryRun = has('dry-run');
const github = has('github') && !dryRun;
const feedBase = flag('feed-url', `http://127.0.0.1:${FEED_PORT}`);

const PRODUCTS = {
  studio: { label: 'Kite Code', file: 'Kite-Code', match: /Kite/i, extra: [] },
};

const step = (m) => console.log(`\n\x1b[36m▶ ${m}\x1b[0m`);
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });
const out = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const VERSION_FILES = ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml'];
let originals = null;
const restore = () => originals && VERSION_FILES.forEach((f) => fs.writeFileSync(path.join(root, f), originals[f]));
const fail = (m) => {
  restore();
  console.error(`\n\x1b[31m✖ RELEASE ABORTADO: ${m}\x1b[0m`);
  process.exit(1);
};

// ---- preflight --------------------------------------------------------------
step('Preflight');
const which = flag('product', 'studio');
const selected = which === 'both' ? Object.keys(PRODUCTS) : [which];
if (selected.some((p) => !PRODUCTS[p])) fail(`--product inválido: ${which}`);

const keyPath = path.join(os.homedir(), '.tauri', 'kite.key');
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  if (!fs.existsSync(keyPath)) fail(`Falta la clave de firma (${keyPath}). Genera una con: npx tauri signer generate`);
  process.env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(keyPath, 'utf8');
  process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';
}

let repo = '';
if (github) {
  try { out('gh auth status'); } catch { fail('`gh` no está instalado o no ha iniciado sesión (gh auth login).'); }
  try { repo = (out('git remote get-url origin').match(/github\.com[:/](.+?)(?:\.git)?$/) || [])[1] || ''; } catch { /* below */ }
  if (!repo) fail('No hay remote `origin` de GitHub. Añádelo o usa el modo local (sin --github).');
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const cur = pkg.version.split('.').map(Number);
let next;
if (/^\d+\.\d+\.\d+$/.test(bumpArg)) next = bumpArg;
else if (bumpArg === 'major') next = `${cur[0] + 1}.0.0`;
else if (bumpArg === 'minor') next = `${cur[0]}.${cur[1] + 1}.0`;
else if (bumpArg === 'patch') next = `${cur[0]}.${cur[1]}.${cur[2] + 1}`;
else fail(`Versión inválida: ${bumpArg}`);
const gt = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
if (!gt(next, pkg.version)) fail(`La nueva versión (${next}) debe ser mayor que la actual (${pkg.version}).`);
console.log(`Versión: ${pkg.version} → ${next} | productos: ${selected.join(', ')} | destino: ${dryRun ? 'dry-run' : github ? 'GitHub ' + repo : 'feed local ' + feedBase}`);

const fast = has('fast') || has('quick');

if (!has('skip-tests')) {
  step('Tests');
  try {
    if (fast) {
      console.log('⚡ Modo rápido: ejecutando tests sobre archivos modificados (--changed)...');
      run('npx vitest run --changed --bail 1');
    } else {
      run('npm test -- --bail 1');
    }
  } catch {
    fail('Los tests fallan. Corrige o usa --skip-tests.');
  }
}

// ---- higiene de dist/ (previene recursión matrioska en tauri-build) --------------
const distDir = path.join(root, 'dist');
if (fs.existsSync(distDir)) {
  for (const f of fs.readdirSync(distDir)) {
    if (f.endsWith('.exe') || f.endsWith('.zip') || f.endsWith('.sig') || f === 'feed' || f === 'release') {
      fs.rmSync(path.join(distDir, f), { recursive: true, force: true });
    }
  }
}

// ---- bump (única fuente: package.json) ------------------------------------------
step(`Bump a ${next}`);
originals = Object.fromEntries(VERSION_FILES.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
const sub = (file, re, rep) => {
  const p = path.join(root, file);
  const t = fs.readFileSync(p, 'utf8');
  if (!re.test(t)) fail(`No pude actualizar la versión en ${file}`);
  fs.writeFileSync(p, t.replace(re, rep));
};
sub('package.json', /("version":\s*")[^"]+(")/, `$1${next}$2`);
sub('src-tauri/tauri.conf.json', /("version":\s*")[^"]+(")/, `$1${next}$2`);
sub('src-tauri/Cargo.toml', /(^version\s*=\s*")[^"]+(")/m, `$1${next}$2`);

// ---- build + manifiestos ----------------------------------------------------------
const outDir = path.join(root, 'releases', `v${next}`);
fs.mkdirSync(outDir, { recursive: true });
const bundleDir = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
let notes = flag('notes', '');
if (!notes) { try { notes = out('git log --pretty=format:"- %s" -n 15'); } catch { notes = `Versión ${next}`; } }
const built = [];

for (const key of selected) {
  const prod = PRODUCTS[key];
  step(`Build ${prod.label}`);
  try { run(`npx tauri build --bundles nsis --ci ${prod.extra.join(' ')}`); }
  catch { fail(`Falló el build de ${prod.label}. Versión restaurada.`); }

  const allFiles = fs.readdirSync(bundleDir);
  let artifact = allFiles.find((f) => f.includes(next) && prod.match.test(f) && f.endsWith('.nsis.zip') && fs.existsSync(path.join(bundleDir, `${f}.sig`)));
  if (!artifact) {
    artifact = allFiles.find((f) => f.includes(next) && prod.match.test(f) && f.endsWith('.exe') && fs.existsSync(path.join(bundleDir, `${f}.sig`)));
  }
  if (!artifact) {
    artifact = allFiles.find((f) => f.endsWith(`_${next}_x64-setup.exe`) && prod.match.test(f));
  }
  if (!artifact) fail(`No encontré el artefacto ${prod.label} ${next} en ${bundleDir}`);

  let sigSrc = path.join(bundleDir, `${artifact}.sig`);
  if (!fs.existsSync(sigSrc) && artifact.endsWith('.exe')) {
    const zipSig = path.join(bundleDir, `${artifact.replace(/\.exe$/, '')}.nsis.zip.sig`);
    if (fs.existsSync(zipSig)) sigSrc = zipSig;
  }
  if (!fs.existsSync(sigSrc)) fail(`Falta firma para ${artifact} en ${bundleDir}`);

  const ext = path.extname(artifact) === '.zip' ? '.nsis.zip' : path.extname(artifact);
  const assetName = `${prod.file}_${next}_x64-setup${ext}`; // sin espacios
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(path.join(bundleDir, artifact), path.join(outDir, assetName));
  const signature = fs.readFileSync(sigSrc, 'utf8').trim();
  fs.writeFileSync(path.join(outDir, `${assetName}.sig`), signature);

  const base = github ? `https://github.com/${repo}/releases/download/v${next}` : `${feedBase}/${key}`;
  const manifest = {
    version: next,
    notes,
    pub_date: new Date().toISOString(),
    platforms: { 'windows-x86_64': { signature, url: `${base}/${assetName}` } },
  };
  const mName = github ? `latest-${key}.json` : 'latest.json';
  fs.writeFileSync(path.join(outDir, `${key}-${mName}`), JSON.stringify(manifest, null, 2));
  built.push({ key, assetName, mName, manifest });
  console.log(`✔ ${assetName}`);
}

// ---- publicar ------------------------------------------------------------------------
if (dryRun) {
  restore();
  console.log(`\n\x1b[32m✔ Dry-run OK. Artefactos en ${outDir} (versión restaurada, nada publicado).\x1b[0m`);
  process.exit(0);
}

if (github) {
  step('Commit + tag + push');
  const files = 'package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock';
  run(`git commit -m "chore(release): v${next}" --only ${files}`);
  run(`git tag v${next}`);
  run(`git push origin HEAD v${next}`);
  step('Crear GitHub Release');
  const noteFile = path.join(outDir, 'NOTES.md');
  fs.writeFileSync(noteFile, notes);
  const assets = built.flatMap((b) => [path.join(outDir, b.assetName), path.join(outDir, `${b.key}-${b.mName}`)]);
  const r = spawnSync('gh', ['release', 'create', `v${next}`, ...assets, '--title', `v${next}`, '--notes-file', noteFile], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) { console.error('gh release create falló. Artefactos en ' + outDir); process.exit(1); }
  console.log(`\n\x1b[32m✔ Release v${next} publicada en GitHub.\x1b[0m`);
  process.exit(0);
}

step('Publicar en feed local');
function pruneOldArtifacts(dir, keepCount = 2) {
  if (!fs.existsSync(dir)) return;
  const exes = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.exe'))
    .map((f) => ({
      name: f,
      time: fs.statSync(path.join(dir, f)).mtimeMs,
    }))
    .sort((a, b) => b.time - a.time);

  const toRemove = exes.slice(keepCount);
  for (const item of toRemove) {
    try {
      fs.rmSync(path.join(dir, item.name), { force: true });
      const sig = path.join(dir, `${item.name}.sig`);
      if (fs.existsSync(sig)) fs.rmSync(sig, { force: true });
      console.log(`🧹 Podado instalador antiguo del feed: ${item.name}`);
    } catch { /* ignore */ }
  }
}

function pruneOldReleases(releasesDir, keepCount = 2) {
  if (!fs.existsSync(releasesDir)) return;
  const versions = fs.readdirSync(releasesDir)
    .map((d) => ({
      name: d,
      path: path.join(releasesDir, d),
      time: fs.statSync(path.join(releasesDir, d)).mtimeMs,
    }))
    .filter((d) => {
      try { return fs.statSync(d.path).isDirectory(); } catch { return false; }
    })
    .sort((a, b) => b.time - a.time);

  for (const oldVer of versions.slice(keepCount)) {
    try {
      fs.rmSync(oldVer.path, { recursive: true, force: true });
      console.log(`🧹 Podada release archivada antigua: ${oldVer.name}`);
    } catch { /* ignore */ }
  }
}

for (const b of built) {
  const dir = path.join(root, 'feed', b.key);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(outDir, b.assetName), path.join(dir, b.assetName));
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(b.manifest, null, 2));
  pruneOldArtifacts(dir, 2);
}
pruneOldReleases(path.join(root, 'releases'), 2);
const ok = await ensureFeedServer();
if (!ok) console.log('\x1b[33m⚠ No pude arrancar el feed server; ejecuta: npm run feed\x1b[0m');
for (const b of built) {
  try {
    const j = await (await fetch(`${feedBase}/${b.key}/latest.json`)).json();
    console.log(j.version === next ? `✔ ${b.key}: feed OK (${next})` : `⚠ ${b.key}: el feed sirve ${j.version}`);
  } catch (e) { console.log(`⚠ ${b.key}: no pude verificar el feed (${e.message})`); }
}
console.log(`\n\x1b[32m✔ v${next} publicada en el feed local. Las apps instaladas la detectarán al abrir o desde "Buscar actualizaciones".\x1b[0m`);
