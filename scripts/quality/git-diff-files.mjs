import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Normalize a file path to forward-slash repo-relative form.
 */
export function normalizeRelPath(filePath, repoRoot = process.cwd()) {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
  const rel = path.relative(repoRoot, abs);
  return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Lightweight zero-dependency glob matcher supporting *, **, ?, and {a,b} alternation.
 */
export function globToRegExp(globPattern) {
  const normalized = globPattern.replace(/\\/g, '/');
  let regexStr = '^';
  let i = 0;

  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') {
          regexStr += '(?:.*/)?';
          i += 3;
          continue;
        }
        regexStr += '.*';
        i += 2;
        continue;
      }
      regexStr += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      regexStr += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '{') {
      const closeIdx = normalized.indexOf('}', i + 1);
      if (closeIdx !== -1) {
        const inner = normalized.slice(i + 1, closeIdx);
        const parts = inner.split(',').map((p) => p.replace(/[.+^$|()[\]\\]/g, '\\$&'));
        regexStr += `(?:${parts.join('|')})`;
        i = closeIdx + 1;
        continue;
      }
    }
    if (/[.+^$|()[\]\\]/.test(ch)) {
      regexStr += `\\${ch}`;
    } else {
      regexStr += ch;
    }
    i += 1;
  }

  regexStr += '$';
  return new RegExp(regexStr);
}

export function matchesAnyGlob(relPath, patterns = []) {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

/**
 * Recursively walk a directory and return repo-relative forward-slash paths.
 */
export function walkFiles(dirAbs, repoRoot, opts = {}) {
  const {
    ignoreDirs = new Set(['node_modules', 'target', 'dist', '.git', '.codegraph', 'test-results', 'releases', 'scratch']),
    extensions = null,
  } = opts;

  const out = [];
  if (!fs.existsSync(dirAbs)) return out;

  const stack = [dirAbs];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoreDirs.has(entry.name)) {
          stack.push(path.join(current, entry.name));
        }
      } else if (entry.isFile()) {
        const full = path.join(current, entry.name);
        if (extensions && !extensions.some((ext) => entry.name.endsWith(ext))) {
          continue;
        }
        out.push(normalizeRelPath(full, repoRoot));
      }
    }
  }
  out.sort();
  return out;
}

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Resolve target files for diff-scoped checks.
 * Returns `{ files: string[], addedFiles: Set<string>, scopeLabel: string }`.
 */
export function resolveTargetFiles(repoRoot, options = {}) {
  const { files = [], all = false, staged = false, baseRef = null, scanDirs = ['src'] } = options;

  if (files && files.length > 0) {
    const normalized = Array.from(
      new Set(
        files
          .map((f) => normalizeRelPath(f, repoRoot))
          .filter((f) => fs.existsSync(path.join(repoRoot, f))),
      ),
    ).sort();
    return {
      files: normalized,
      addedFiles: new Set(),
      scopeLabel: `explicit(${normalized.length})`,
    };
  }

  if (all) {
    const found = [];
    for (const dir of scanDirs) {
      found.push(...walkFiles(path.join(repoRoot, dir), repoRoot));
    }
    return {
      files: Array.from(new Set(found)).sort(),
      addedFiles: new Set(),
      scopeLabel: 'all',
    };
  }

  const changed = new Set();
  const addedFiles = new Set();

  if (baseRef) {
    const out = runGit(['diff', '--name-status', '--diff-filter=ACMR', `${baseRef}...HEAD`], repoRoot);
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const status = parts[0] || '';
      const rel = (parts[parts.length - 1] || '').replace(/\\/g, '/');
      if (!rel || !fs.existsSync(path.join(repoRoot, rel))) continue;
      changed.add(rel);
      if (status.startsWith('A')) addedFiles.add(rel);
    }
    // Also include local working-tree modifications on top of HEAD.
    const working = runGit(['status', '--porcelain=v1', '-uall'], repoRoot);
    for (const line of working.split(/\r?\n/)) {
      if (!line || line.length < 4) continue;
      const xy = line.slice(0, 2);
      if (xy.includes('D')) continue;
      let rawPath = line.slice(3).trim();
      if (rawPath.includes(' -> ')) rawPath = rawPath.split(' -> ').pop().trim();
      rawPath = rawPath.replace(/^"|"$/g, '').replace(/\\/g, '/');
      if (!fs.existsSync(path.join(repoRoot, rawPath))) continue;
      changed.add(rawPath);
      if (xy === '??' || xy.startsWith('A')) addedFiles.add(rawPath);
    }
    return {
      files: Array.from(changed).sort(),
      addedFiles,
      scopeLabel: `base(${baseRef})`,
    };
  }

  if (staged) {
    const out = runGit(['diff', '--cached', '--name-status', '--diff-filter=ACMR'], repoRoot);
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const status = parts[0] || '';
      const rel = (parts[parts.length - 1] || '').replace(/\\/g, '/');
      if (!rel || !fs.existsSync(path.join(repoRoot, rel))) continue;
      changed.add(rel);
      if (status.startsWith('A')) addedFiles.add(rel);
    }
    return {
      files: Array.from(changed).sort(),
      addedFiles,
      scopeLabel: 'staged',
    };
  }

  // Default: working tree modifications + untracked files.
  const statusOut = runGit(['status', '--porcelain=v1', '-uall'], repoRoot);
  for (const line of statusOut.split(/\r?\n/)) {
    if (!line || line.length < 4) continue;
    const xy = line.slice(0, 2);
    if (xy.includes('D')) continue;
    let rawPath = line.slice(3).trim();
    if (rawPath.includes(' -> ')) rawPath = rawPath.split(' -> ').pop().trim();
    rawPath = rawPath.replace(/^"|"$/g, '').replace(/\\/g, '/');
    if (!fs.existsSync(path.join(repoRoot, rawPath))) continue;
    changed.add(rawPath);
    if (xy === '??' || xy.startsWith('A')) addedFiles.add(rawPath);
  }

  return {
    files: Array.from(changed).sort(),
    addedFiles,
    scopeLabel: 'working-tree',
  };
}
