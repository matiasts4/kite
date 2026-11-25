import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesAnyGlob, resolveTargetFiles } from './git-diff-files.mjs';
import { stripCommentsPreservingLines } from './verify-ipc.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'gate.config.json');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function hasEscapeHatch(lines, zeroBasedIdx, marker) {
  if (!marker) return false;
  const current = lines[zeroBasedIdx] || '';
  const prev = zeroBasedIdx > 0 ? lines[zeroBasedIdx - 1] || '' : '';
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\S+`);
  return re.test(current) || re.test(prev);
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

function findSilentIpcCatches(rawSource, lines, marker) {
  const findings = [];
  const clean = stripCommentsPreservingLines(rawSource);
  const tryRe = /\btry\s*\{/g;
  let match;

  while ((match = tryRe.exec(clean)) !== null) {
    const tryOpen = match.index + match[0].length - 1;
    let idx = tryOpen + 1;
    let depth = 1;
    while (idx < clean.length && depth > 0) {
      if (clean[idx] === '{') depth += 1;
      else if (clean[idx] === '}') depth -= 1;
      idx += 1;
    }
    const tryBody = clean.slice(tryOpen + 1, idx - 1);
    if (!/\b(?:invokeCommand|invoke|tauriInvoke)\s*(?:<[^>]*>)?\s*\(/.test(tryBody)) {
      continue;
    }

    const rest = clean.slice(idx);
    const catchMatch = rest.match(/^\s*catch(?:\s*\([^)]*\))?\s*\{/);
    if (!catchMatch) continue;

    const catchOpen = idx + catchMatch[0].length - 1;
    let cIdx = catchOpen + 1;
    let cDepth = 1;
    while (cIdx < clean.length && cDepth > 0) {
      if (clean[cIdx] === '{') cDepth += 1;
      else if (clean[cIdx] === '}') cDepth -= 1;
      cIdx += 1;
    }

    const catchBody = clean.slice(catchOpen + 1, cIdx - 1).trim();
    if (catchBody.length === 0) {
      const lineNum = lineNumberAt(clean, idx + catchMatch.index);
      if (!hasEscapeHatch(lines, lineNum - 1, marker)) {
        findings.push({
          line: lineNum,
          snippet: (lines[lineNum - 1] || '').trim(),
        });
      }
    }
  }

  return findings;
}

function findStaticInlineStyles(rawSource, lines, forbiddenProps, marker) {
  const findings = [];
  const clean = stripCommentsPreservingLines(rawSource);
  const styleRe = /style=\{\{/g;
  let match;

  while ((match = styleRe.exec(clean)) !== null) {
    let idx = match.index + match[0].length;
    let depth = 2;
    while (idx < clean.length && depth > 0) {
      if (clean[idx] === '{') depth += 1;
      else if (clean[idx] === '}') depth -= 1;
      idx += 1;
    }
    const body = clean.slice(match.index + match[0].length, idx - 2);
    const propGroup = forbiddenProps.join('|');
    const staticPropRe = new RegExp(
      `\\b(${propGroup})\\s*:\\s*(?:['"][^'"]*['"]|\\d+(?:\\.\\d+)?)`,
      'g',
    );
    const matchedProps = [];
    let pm;
    while ((pm = staticPropRe.exec(body)) !== null) {
      // Allow explicit CSS variable strings like `color: 'var(--text-muted)'`
      const fullVal = pm[0];
      if (/['"]\s*var\(--/.test(fullVal)) continue;
      matchedProps.push(pm[1]);
    }

    if (matchedProps.length > 0) {
      const lineNum = lineNumberAt(clean, match.index);
      if (!hasEscapeHatch(lines, lineNum - 1, marker)) {
        findings.push({
          line: lineNum,
          snippet: `style={{ ${Array.from(new Set(matchedProps)).join(', ')} }}`,
        });
      }
    }
  }

  return findings;
}

/**
 * Lint a single file's content against declarative design rules.
 */
export function lintFileContent(relPath, content, designConfig, ctx = {}) {
  const { isAdded = false } = ctx;
  const normalized = relPath.replace(/\\/g, '/');

  if (matchesAnyGlob(normalized, designConfig.excludePaths || [])) {
    return [];
  }

  const lines = content.split(/\r?\n/);
  const cleanLines = stripCommentsPreservingLines(content).split(/\r?\n/);
  const marker = designConfig.inlineEscapeMarker || 'kite-design-ok:';
  const findings = [];

  for (const rule of designConfig.rules || []) {
    if (!rule.enabled) continue;
    if (rule.onlyAddedFiles && !isAdded) continue;
    if (rule.include && !matchesAnyGlob(normalized, rule.include)) continue;
    if (rule.exclude && rule.exclude.length > 0 && matchesAnyGlob(normalized, rule.exclude)) continue;

    if (rule.id === 'no-arbitrary-css-radius') {
      const forbiddenSet = new Set(rule.forbiddenPx || []);
      for (let i = 0; i < cleanLines.length; i += 1) {
        const line = cleanLines[i];
        const m = line.match(/\bborder-radius\s*:\s*([^;{}]+)/i);
        if (!m) continue;
        const val = m[1];
        if (/\b(?:var|calc)\s*\(/i.test(val)) continue;
        const pxMatches = [...val.matchAll(/\b(\d+)px\b/gi)];
        const badPx = pxMatches.map((x) => Number(x[1])).filter((n) => forbiddenSet.has(n));
        if (badPx.length > 0 && !hasEscapeHatch(lines, i, marker)) {
          findings.push({
            ruleId: rule.id,
            severity: rule.severity,
            file: normalized,
            line: i + 1,
            message: `${rule.message} Found: ${badPx.map((n) => `${n}px`).join(', ')}.`,
            fixHint: rule.fixHint,
          });
        }
      }
      continue;
    }

    if (rule.id === 'no-tailwind-arbitrary-radius') {
      for (let i = 0; i < cleanLines.length; i += 1) {
        const m = cleanLines[i].match(/\brounded-\[\d+px\]/);
        if (m && !hasEscapeHatch(lines, i, marker)) {
          findings.push({
            ruleId: rule.id,
            severity: rule.severity,
            file: normalized,
            line: i + 1,
            message: `${rule.message} Found: ${m[0]}.`,
            fixHint: rule.fixHint,
          });
        }
      }
      continue;
    }

    if (rule.id === 'no-arbitrary-control-height') {
      const forbiddenSet = new Set(rule.forbiddenPx || []);
      const keywords = (rule.selectorKeywords || []).map((k) => k.toLowerCase());
      let currentSelector = '';
      for (let i = 0; i < cleanLines.length; i += 1) {
        const line = cleanLines[i];
        if (line.includes('{')) {
          currentSelector = line.split('{')[0].trim().toLowerCase();
        }
        const m = line.match(/(?:^|[;\s{])height\s*:\s*(\d+)px\b/i);
        if (m && forbiddenSet.has(Number(m[1]))) {
          const isControl = keywords.some((kw) => currentSelector.includes(kw));
          if (isControl && !hasEscapeHatch(lines, i, marker)) {
            findings.push({
              ruleId: rule.id,
              severity: rule.severity,
              file: normalized,
              line: i + 1,
              message: `${rule.message} Found height: ${m[1]}px on '${currentSelector || 'selector'}'.`,
              fixHint: rule.fixHint,
            });
          }
        }
        if (line.includes('}')) {
          currentSelector = '';
        }
      }
      continue;
    }

    if (rule.id === 'no-hardcoded-hex-colors') {
      for (let i = 0; i < cleanLines.length; i += 1) {
        const line = cleanLines[i];
        // Ignore data URLs or SVG fragment refs inside url(...)
        const withoutUrl = line.replace(/url\([^)]*\)/gi, '');
        const hexMatch = withoutUrl.match(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/);
        if (hexMatch && !hasEscapeHatch(lines, i, marker)) {
          // Ensure it is a property value (after `:`) rather than an ID selector like `#root`
          const colonIdx = withoutUrl.indexOf(':');
          if (colonIdx !== -1 && hexMatch.index > colonIdx) {
            findings.push({
              ruleId: rule.id,
              severity: rule.severity,
              file: normalized,
              line: i + 1,
              message: `${rule.message} Found: ${hexMatch[0]}.`,
              fixHint: rule.fixHint,
            });
          }
        }
      }
      continue;
    }

    if (rule.id === 'no-raw-html-select') {
      for (let i = 0; i < cleanLines.length; i += 1) {
        if (/<select(?:\s|>|$)/.test(cleanLines[i]) && !hasEscapeHatch(lines, i, marker)) {
          findings.push({
            ruleId: rule.id,
            severity: rule.severity,
            file: normalized,
            line: i + 1,
            message: rule.message,
            fixHint: rule.fixHint,
          });
        }
      }
      continue;
    }

    if (rule.id === 'no-silent-ipc-catch') {
      const hits = findSilentIpcCatches(content, lines, marker);
      for (const hit of hits) {
        findings.push({
          ruleId: rule.id,
          severity: rule.severity,
          file: normalized,
          line: hit.line,
          message: rule.message,
          fixHint: rule.fixHint,
        });
      }
      continue;
    }

    if (rule.id === 'no-static-inline-style') {
      const hits = findStaticInlineStyles(content, lines, rule.forbiddenProps || [], marker);
      for (const hit of hits) {
        findings.push({
          ruleId: rule.id,
          severity: rule.severity,
          file: normalized,
          line: hit.line,
          message: `${rule.message} (${hit.snippet})`,
          fixHint: rule.fixHint,
        });
      }
      continue;
    }

    if (rule.id === 'max-new-file-lines') {
      const count = lines.length;
      if (rule.errorLines && count > rule.errorLines) {
        findings.push({
          ruleId: rule.id,
          severity: 'error',
          file: normalized,
          line: 1,
          message: `${rule.message} (${count} lines > hard limit ${rule.errorLines}).`,
          fixHint: rule.fixHint,
        });
      } else if (rule.warnLines && count > rule.warnLines) {
        findings.push({
          ruleId: rule.id,
          severity: 'warn',
          file: normalized,
          line: 1,
          message: `${rule.message} (${count} lines > threshold ${rule.warnLines}).`,
          fixHint: rule.fixHint,
        });
      }
    }
  }

  return findings;
}

/**
 * Verify design & hygiene rules across resolved target files in a workspace.
 */
export function verifyDesignWorkspace(repoRoot, designConfig, options = {}) {
  const { files, addedFiles, scopeLabel } = resolveTargetFiles(repoRoot, {
    ...options,
    scanDirs: ['src'],
  });

  const errors = [];
  const warnings = [];
  const byRule = {};

  for (const rel of files) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const content = fs.readFileSync(abs, 'utf8');
    const findings = lintFileContent(rel, content, designConfig, {
      isAdded: addedFiles.has(rel),
    });
    for (const f of findings) {
      byRule[f.ruleId] = (byRule[f.ruleId] || 0) + 1;
      if (f.severity === 'error') errors.push(f);
      else warnings.push(f);
    }
  }

  return {
    scope: scopeLabel,
    scannedFiles: files.length,
    errors,
    warnings,
    byRule,
  };
}

function parseCliArgs(argv) {
  let configPath = DEFAULT_CONFIG_PATH;
  let all = false;
  let staged = false;
  let baseRef = null;
  let json = false;
  let strict = false;
  let reportOnly = false;
  const files = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') all = true;
    else if (arg === '--staged') staged = true;
    else if (arg === '--json') json = true;
    else if (arg === '--strict') strict = true;
    else if (arg === '--report-only') reportOnly = true;
    else if (arg === '--base' && argv[i + 1]) {
      baseRef = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--base=')) {
      baseRef = arg.slice('--base='.length);
    } else if (arg === '--config' && argv[i + 1]) {
      configPath = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === '--files' && argv[i + 1]) {
      files.push(...argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean));
      i += 1;
    } else if (!arg.startsWith('-')) {
      files.push(arg);
    }
  }

  return { configPath, all, staged, baseRef, files, json, strict, reportOnly };
}

function runCli() {
  const opts = parseCliArgs(process.argv.slice(2));
  const config = JSON.parse(fs.readFileSync(opts.configPath, 'utf8'));
  const result = verifyDesignWorkspace(REPO_ROOT, config.design, opts);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `[verify:design] Scope: ${result.scope} | Scanned: ${result.scannedFiles} file(s) | Errors: ${result.errors.length} | Warnings: ${result.warnings.length}`,
    );
    if (Object.keys(result.byRule).length > 0) {
      console.log('  Breakdown by rule:');
      for (const [ruleId, count] of Object.entries(result.byRule).sort((a, b) => b[1] - a[1])) {
        console.log(`    - ${ruleId}: ${count}`);
      }
    }
    const maxPrint = opts.all ? 25 : 60;
    if (result.errors.length > 0) {
      console.error(`\n[ERROR] Design/hygiene violations (showing up to ${maxPrint}):`);
      for (const e of result.errors.slice(0, maxPrint)) {
        console.error(`  - ${e.file}:${e.line} [${e.ruleId}] ${e.message}`);
        if (e.fixHint) console.error(`      Fix: ${e.fixHint}`);
      }
    }
    if (result.warnings.length > 0 && !opts.all) {
      console.warn(`\n[WARN] Design warnings (showing up to ${maxPrint}):`);
      for (const w of result.warnings.slice(0, maxPrint)) {
        console.warn(`  - ${w.file}:${w.line} [${w.ruleId}] ${w.message}`);
      }
    }
    if (result.errors.length === 0) {
      console.log('[PASS] Zero blocking design/hygiene violations in target scope.');
    }
  }

  if (opts.reportOnly) {
    process.exit(0);
  }
  const failed = result.errors.length > 0 || (opts.strict && result.warnings.length > 0);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runCli();
}
