#!/usr/bin/env node
// Feed estático local para el updater de Tauri: sirve dist/feed/<producto>/{latest.json,*.exe}
// en http://127.0.0.1:9101. El script de release lo arranca solo (desacoplado) si hace falta.
//   npm run feed          # arranque manual en primer plano

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FEED_PORT = Number(process.env.KITE_FEED_PORT || 9101);
const here = path.dirname(fileURLToPath(import.meta.url));
const rootFeed = path.resolve(here, '..', 'feed');
export const getFeedDir = () => rootFeed;
const TYPES = { '.json': 'application/json; charset=utf-8', '.exe': 'application/octet-stream', '.sig': 'text/plain' };

export async function isFeedUp(port = FEED_PORT) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch { return false; }
}

/** Arranca el servidor en segundo plano (sin ventana) si no responde. */
export async function ensureFeedServer() {
  if (await isFeedUp()) return true;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve'], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isFeedUp()) return true;
  }
  return false;
}

function serve() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/health') { res.writeHead(200); return res.end('ok'); }
    const feedDir = getFeedDir();
    const file = path.normalize(path.join(feedDir, url));
    if (!file.startsWith(feedDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); return res.end('not found');
    }
    const stat = fs.statSync(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
      return res.end();
    }
    fs.createReadStream(file).pipe(res);
  });
  server.on('error', (e) => { console.error('feed server:', e.message); process.exit(1); });
  server.listen(FEED_PORT, '127.0.0.1', () => console.log(`Feed en http://127.0.0.1:${FEED_PORT} (${getFeedDir()})`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
