import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkFiles } from './git-diff-files.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'gate.config.json');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const INJECTED_TAURI_PARAM_TYPES = [
  'AppHandle',
  'Window',
  'WebviewWindow',
  'State<',
  'tauri::State',
  'tauri::AppHandle',
  'tauri::Window',
  'tauri::WebviewWindow',
  'tauri::ipc::Channel',
  'Channel<',
  'tauri::ipc::Request',
];

/**
 * Strip line and block comments while keeping newlines intact for exact line numbering.
 * Preserves string literals so URLs like 'https://...' are never truncated.
 */
export function stripCommentsPreservingLines(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  let quote = null;

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < n) {
        out += source[i + 1];
        i += 2;
        continue;
      }
      // JS/TS single/double-quoted strings cannot cross unescaped newlines;
      // resetting prevents apostrophes in JSX text (e.g. `<p>It's ok</p>`) from blinding later lines.
      if (ch === quote || (ch === '\n' && quote !== '`')) {
        quote = null;
      }
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      out += '  ';
      i += 2;
      while (i < n && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

function splitTopLevelCommas(input) {
  const parts = [];
  let current = '';
  let depthParen = 0;
  let depthAngle = 0;
  let depthBracket = 0;
  let depthBrace = 0;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '(') depthParen += 1;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '<') depthAngle += 1;
    else if (ch === '>') depthAngle = Math.max(0, depthAngle - 1);
    else if (ch === '[') depthBracket += 1;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === '{') depthBrace += 1;
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);

    if (ch === ',' && depthParen === 0 && depthAngle === 0 && depthBracket === 0 && depthBrace === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Strip Rust line and block comments while preserving line numbers.
 * Correctly handles Rust lifetimes (`'a`, `'static`), char literals (`'x'`, `'\n'`),
 * normal strings `"..."`, and raw strings `r#"..."#`.
 */
export function stripRustCommentsPreservingLines(source) {
  let out = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    // Rust raw string literals: r"...", r#"..."#, br#"..."#
    if ((ch === 'r' || (ch === 'b' && next === 'r')) && i + 1 < n) {
      let j = ch === 'b' ? i + 2 : i + 1;
      let hashes = 0;
      while (j < n && source[j] === '#') {
        hashes += 1;
        j += 1;
      }
      if (j < n && source[j] === '"') {
        out += source.slice(i, j + 1);
        i = j + 1;
        const closing = `"${'#'.repeat(hashes)}`;
        while (i < n) {
          if (source.startsWith(closing, i)) {
            out += closing;
            i += closing.length;
            break;
          }
          out += source[i];
          i += 1;
        }
        continue;
      }
    }

    // Normal double-quoted string
    if (ch === '"') {
      out += ch;
      i += 1;
      while (i < n) {
        const c = source[i];
        out += c;
        if (c === '\\' && i + 1 < n) {
          out += source[i + 1];
          i += 2;
          continue;
        }
        i += 1;
        if (c === '"') break;
      }
      continue;
    }

    // Rust char literal (e.g. 'a', '\n', '\x7f', '\u{1b}') — never confuse with lifetimes `'a` / `'static`
    if (ch === "'") {
      const slice = source.slice(i, i + 16);
      const charMatch = slice.match(/^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F_]+\}|.)|[^'\\\n])'/);
      if (charMatch) {
        out += charMatch[0];
        i += charMatch[0].length;
        continue;
      }
      // Lifetime token — emit as-is
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      out += '  ';
      i += 2;
      while (i < n && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (source[i] === '/' && source[i + 1] === '*') {
          depth += 1;
          out += '  ';
          i += 2;
          continue;
        }
        if (source[i] === '*' && source[i + 1] === '/') {
          depth -= 1;
          out += '  ';
          i += 2;
          continue;
        }
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * Extract every handler name registered inside `tauri::generate_handler![...]` in main.rs.
 */
export function extractRegisteredHandlers(mainRsSource) {
  const clean = stripRustCommentsPreservingLines(mainRsSource);
  const handlers = new Set();
  const macroRe = /generate_handler!\s*\[/g;
  let match;

  while ((match = macroRe.exec(clean)) !== null) {
    let idx = match.index + match[0].length;
    let depth = 1;
    const start = idx;
    while (idx < clean.length && depth > 0) {
      if (clean[idx] === '[') depth += 1;
      else if (clean[idx] === ']') depth -= 1;
      idx += 1;
    }
    const body = clean.slice(start, idx - 1);
    const cleanedBody = body.replace(/#\[[^\]]*\]/g, ' ');
    for (const rawEntry of cleanedBody.split(',')) {
      const entry = rawEntry.trim();
      if (!entry) continue;
      const parts = entry.split('::').map((p) => p.trim()).filter(Boolean);
      const leaf = parts[parts.length - 1];
      if (leaf && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(leaf)) {
        handlers.add(leaf);
      }
    }
  }

  return handlers;
}

/**
 * Extract all `#[tauri::command]` definitions and parameter shapes from a Rust source file.
 */
export function extractRustCommandsFromSource(rustSource, relFile) {
  const clean = stripRustCommentsPreservingLines(rustSource);
  const commands = [];
  const attrRe = /#\[\s*(?:tauri::)?command(?:\s*\([^)]*\))?\s*\]/g;
  let match;

  while ((match = attrRe.exec(clean)) !== null) {
    let cursor = match.index + match[0].length;
    // Skip any stacked attributes (e.g. #[allow(...)], #[cfg(...)])
    while (cursor < clean.length) {
      const rest = clean.slice(cursor);
      const ws = rest.match(/^\s+/);
      if (ws) {
        cursor += ws[0].length;
        continue;
      }
      if (rest.startsWith('#[')) {
        let depth = 0;
        let k = cursor;
        while (k < clean.length) {
          if (clean[k] === '[') depth += 1;
          else if (clean[k] === ']') {
            depth -= 1;
            if (depth === 0) {
              k += 1;
              break;
            }
          }
          k += 1;
        }
        cursor = k;
        continue;
      }
      break;
    }

    const fnSlice = clean.slice(cursor, cursor + 300);
    const fnMatch = fnSlice.match(/^(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:<[^>]*>\s*)?\(/);
    if (!fnMatch) continue;

    const name = fnMatch[1];
    const line = lineNumberAt(clean, cursor);
    const openParenIdx = cursor + fnMatch[0].length - 1;
    let idx = openParenIdx + 1;
    let depth = 1;
    while (idx < clean.length && depth > 0) {
      if (clean[idx] === '(') depth += 1;
      else if (clean[idx] === ')') depth -= 1;
      idx += 1;
    }

    const rawParams = clean.slice(openParenIdx + 1, idx - 1);
    const params = splitTopLevelCommas(rawParams)
      .map((entry) => {
        const cleaned = entry.replace(/#\[[^\]]*\]/g, '').trim();
        const colonIdx = cleaned.indexOf(':');
        if (colonIdx === -1) return null;
        const paramName = cleaned
          .slice(0, colonIdx)
          .replace(/\bmut\b/g, '')
          .trim()
          .replace(/^_+/, '');
        const paramType = cleaned.slice(colonIdx + 1).trim();
        const isInjected = INJECTED_TAURI_PARAM_TYPES.some((t) => paramType.includes(t));
        return { name: paramName, type: paramType, isInjected };
      })
      .filter(Boolean);

    const payloadParams = params.filter((p) => !p.isInjected);
    const isOptionType = (t) => /^Option\s*</.test(t.replace(/\s+/g, ''));
    const hasRequestParam = payloadParams.some((p) => p.name === 'request');
    const expectsRequestWrapper = payloadParams.length === 1 && payloadParams[0].name === 'request';
    const acceptsRequestWrapper =
      hasRequestParam && payloadParams.every((p) => p.name === 'request' || isOptionType(p.type));
    const requestOptional =
      expectsRequestWrapper && isOptionType(payloadParams[0].type);

    commands.push({
      name,
      file: relFile,
      line,
      params: payloadParams,
      hasNonInjectedParams: payloadParams.length > 0,
      expectsRequestWrapper,
      acceptsRequestWrapper,
      requestOptional,
    });
  }

  return commands;
}

function skipBalancedAngleBrackets(src, startIdx) {
  let idx = startIdx;
  if (src[idx] !== '<') return startIdx;
  let depth = 0;
  let quote = null;
  while (idx < src.length) {
    const ch = src[idx];
    if (quote) {
      if (ch === '\\') {
        idx += 2;
        continue;
      }
      if (ch === quote) quote = null;
      idx += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      idx += 1;
      continue;
    }
    // Skip arrow function `=>` inside TS generic type annotations
    if (ch === '=' && src[idx + 1] === '>') {
      idx += 2;
      continue;
    }
    if (ch === '<') depth += 1;
    else if (ch === '>') {
      depth -= 1;
      if (depth === 0) return idx + 1;
    }
    idx += 1;
  }
  return startIdx;
}

function readBalancedParenArgs(src, openParenIdx) {
  let idx = openParenIdx + 1;
  let depth = 1;
  let quote = null;
  while (idx < src.length && depth > 0) {
    const ch = src[idx];
    if (quote) {
      if (ch === '\\') {
        idx += 2;
        continue;
      }
      if (ch === quote) quote = null;
      idx += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      idx += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    idx += 1;
  }
  return src.slice(openParenIdx + 1, idx - 1);
}

/**
 * Extract all static-string IPC invocations (`invoke`, `invokeCommand`, `tauriInvoke`) from TS/TSX source.
 */
export function extractFrontendInvocationsFromSource(tsSource, relFile, callers = ['invokeCommand', 'invoke', 'tauriInvoke']) {
  const clean = stripCommentsPreservingLines(tsSource);
  const invocations = [];
  const callerGroup = callers.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const callRe = new RegExp(`(?<![A-Za-z0-9_$.])(${callerGroup})\\b`, 'g');
  let match;

  while ((match = callRe.exec(clean)) !== null) {
    const caller = match[1];
    // Skip function declarations / imports like `export async function invokeCommand`
    const prefix = clean.slice(Math.max(0, match.index - 24), match.index);
    if (/\b(?:function|import|export|as|type|interface)\s+$/.test(prefix)) continue;

    let idx = match.index + caller.length;
    while (idx < clean.length && /\s/.test(clean[idx])) idx += 1;

    if (clean[idx] === '<') {
      idx = skipBalancedAngleBrackets(clean, idx);
      while (idx < clean.length && /\s/.test(clean[idx])) idx += 1;
    }

    if (clean[idx] !== '(') continue;

    const rawArgs = readBalancedParenArgs(clean, idx);
    const args = splitTopLevelCommas(rawArgs);
    if (args.length === 0) continue;

    const firstArg = args[0].trim();
    const literalMatch = firstArg.match(/^(['"`])([a-zA-Z0-9_:.|-]+)\1$/);
    if (!literalMatch) continue;

    const command = literalMatch[2];
    const secondArg = (args[1] || '').trim();
    const isEmptyObjectLiteral = /^\{\s*\}$/.test(secondArg);
    const isObjectLiteral = secondArg.startsWith('{') && secondArg.endsWith('}');
    const hasSecondArg = secondArg.length > 0 && !isEmptyObjectLiteral && secondArg !== 'undefined' && secondArg !== 'null';

    let hasRequestKey = false;
    let onlyRequestKey = false;
    if (isObjectLiteral && !isEmptyObjectLiteral) {
      const inner = secondArg.slice(1, -1).trim();
      const topProps = splitTopLevelCommas(inner).map((p) => {
        const m = p.match(/^['"]?([a-zA-Z0-9_$]+)['"]?\s*(?::|$)/);
        return m ? m[1] : null;
      }).filter(Boolean);
      hasRequestKey = topProps.includes('request');
      onlyRequestKey = topProps.length === 1 && topProps[0] === 'request';
    }

    invocations.push({
      caller,
      command,
      file: relFile,
      line: lineNumberAt(clean, match.index),
      hasSecondArg,
      isObjectLiteral,
      hasRequestKey,
      onlyRequestKey,
    });
  }

  return invocations;
}

/**
 * Run full IPC contract verification across a repository root.
 */
export function verifyIpcWorkspace(repoRoot, ipcConfig, options = {}) {
  const { ignoreBaseline = false } = options;
  const mainPath = path.join(repoRoot, ipcConfig.rustMainPath);
  if (!fs.existsSync(mainPath)) {
    throw new Error(`Rust main file not found: ${ipcConfig.rustMainPath}`);
  }

  const mainSrc = fs.readFileSync(mainPath, 'utf8');
  const registeredHandlers = extractRegisteredHandlers(mainSrc);

  const rustFiles = walkFiles(path.join(repoRoot, ipcConfig.rustSrcDir), repoRoot, {
    extensions: ['.rs'],
  });
  const rustCommands = new Map();
  for (const rel of rustFiles) {
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    for (const cmd of extractRustCommandsFromSource(src, rel)) {
      if (!rustCommands.has(cmd.name)) {
        rustCommands.set(cmd.name, cmd);
      }
    }
  }

  const tsFiles = walkFiles(path.join(repoRoot, ipcConfig.tsSrcDir), repoRoot, {
    extensions: ['.ts', '.tsx'],
  }).filter(
    (rel) =>
      !rel.endsWith('.test.ts') &&
      !rel.endsWith('.test.tsx') &&
      !rel.endsWith('.spec.ts') &&
      !rel.endsWith('.spec.tsx') &&
      !rel.startsWith('src/test/'),
  );

  const callers = ipcConfig.invokeCallers || ['invokeCommand', 'invoke', 'tauriInvoke'];
  const ignorePrefixes = ipcConfig.ignorePrefixes || ['plugin:'];
  const ignoreCommands = new Set(ipcConfig.ignoreCommands || []);
  const baselineEntries = ignoreBaseline ? [] : (ipcConfig.legacyBaseline || []);
  const baselineMap = new Map(
    baselineEntries.map((entry) => [`${entry.file}::${entry.command}`, entry]),
  );
  const matchedBaselineKeys = new Set();

  const invocations = [];
  for (const rel of tsFiles) {
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    invocations.push(...extractFrontendInvocationsFromSource(src, rel, callers));
  }

  const errors = [];
  const baselinedErrors = [];
  const warnings = [];
  const calledCommands = new Set();

  for (const inv of invocations) {
    if (ignoreCommands.has(inv.command)) continue;
    if (ignorePrefixes.some((prefix) => inv.command.startsWith(prefix))) continue;

    calledCommands.add(inv.command);
    const registered = registeredHandlers.has(inv.command);
    const rustDef = rustCommands.get(inv.command);

    if (!registered) {
      const issue = {
        code: rustDef ? 'command-not-registered' : 'command-not-found',
        command: inv.command,
        file: inv.file,
        line: inv.line,
        message: rustDef
          ? `Command '${inv.command}' is defined in ${rustDef.file}:${rustDef.line} but missing from tauri::generate_handler![] in ${ipcConfig.rustMainPath}.`
          : `Command '${inv.command}' is invoked from frontend but has no #[tauri::command] or generate_handler![] registration in Rust.`,
      };
      const key = `${inv.file}::${inv.command}`;
      if (baselineMap.has(key)) {
        matchedBaselineKeys.add(key);
        baselinedErrors.push(issue);
      } else {
        errors.push(issue);
      }
      continue;
    }

    if (!rustDef) {
      warnings.push({
        code: 'rust-definition-not-indexed',
        command: inv.command,
        file: inv.file,
        line: inv.line,
        message: `Command '${inv.command}' is in generate_handler![] but its #[tauri::command] signature was not parsed.`,
      });
      continue;
    }

    // Payload wrapper consistency check (honors ipcConfig.payloadCheckSeverity: 'warn' | 'error')
    const payloadTarget = ipcConfig.payloadCheckSeverity === 'error' ? errors : warnings;
    if (inv.caller === 'invokeCommand' && inv.hasSecondArg && rustDef.hasNonInjectedParams && !rustDef.acceptsRequestWrapper) {
      payloadTarget.push({
        code: 'unexpected-request-wrapper',
        command: inv.command,
        file: inv.file,
        line: inv.line,
        message: `invokeCommand('${inv.command}', args) wraps payload in { request: args }, but Rust (${rustDef.file}:${rustDef.line}) expects flat params (${rustDef.params.map((p) => p.name).join(', ')}).`,
      });
    } else if (inv.caller !== 'invokeCommand' && inv.isObjectLiteral && inv.hasSecondArg) {
      if (rustDef.expectsRequestWrapper && !inv.hasRequestKey) {
        payloadTarget.push({
          code: 'missing-request-wrapper',
          command: inv.command,
          file: inv.file,
          line: inv.line,
          message: `${inv.caller}('${inv.command}', {...}) omits top-level 'request' key expected by Rust (${rustDef.file}:${rustDef.line}).`,
        });
      } else if (!rustDef.acceptsRequestWrapper && rustDef.hasNonInjectedParams && inv.onlyRequestKey) {
        payloadTarget.push({
          code: 'unexpected-request-wrapper',
          command: inv.command,
          file: inv.file,
          line: inv.line,
          message: `${inv.caller}('${inv.command}', { request: ... }) sends a 'request' wrapper, but Rust (${rustDef.file}:${rustDef.line}) expects flat params (${rustDef.params.map((p) => p.name).join(', ')}).`,
        });
      }
    }
  }

  const staleBaselineEntries = baselineEntries.filter(
    (entry) => !matchedBaselineKeys.has(`${entry.file}::${entry.command}`),
  );

  const unregisteredRustCommands = [];
  for (const [name, def] of rustCommands.entries()) {
    if (!registeredHandlers.has(name)) {
      unregisteredRustCommands.push({ name, file: def.file, line: def.line });
    }
  }

  return {
    stats: {
      registeredHandlers: registeredHandlers.size,
      rustCommands: rustCommands.size,
      frontendInvocations: invocations.length,
      uniqueCalledCommands: calledCommands.size,
      unregisteredRustCommands: unregisteredRustCommands.length,
      baselinedErrors: baselinedErrors.length,
      staleBaselineEntries: staleBaselineEntries.length,
    },
    errors,
    baselinedErrors,
    staleBaselineEntries,
    warnings,
    unregisteredRustCommands,
  };
}

function parseCliArgs(argv) {
  let configPath = DEFAULT_CONFIG_PATH;
  let json = false;
  let strict = false;
  let ignoreBaseline = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--strict') strict = true;
    else if (arg === '--no-baseline') ignoreBaseline = true;
    else if (arg === '--config' && argv[i + 1]) {
      configPath = path.resolve(argv[i + 1]);
      i += 1;
    }
  }
  return { configPath, json, strict, ignoreBaseline };
}

function runCli() {
  const { configPath, json, strict, ignoreBaseline } = parseCliArgs(process.argv.slice(2));
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const result = verifyIpcWorkspace(REPO_ROOT, config.ipc, { ignoreBaseline });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const { stats, errors, baselinedErrors, staleBaselineEntries, warnings } = result;
    console.log(
      `[verify:ipc] Registered: ${stats.registeredHandlers} | Rust #[tauri::command]: ${stats.rustCommands} | Frontend calls: ${stats.frontendInvocations} (${stats.uniqueCalledCommands} unique)`,
    );
    if (errors.length > 0) {
      console.error(`\n[ERROR] ${errors.length} broken IPC contract(s):`);
      for (const e of errors) {
        console.error(`  - ${e.file}:${e.line} [${e.code}] ${e.message}`);
      }
    }
    if (baselinedErrors.length > 0) {
      console.log(
        `[LEGACY DEBT] ${baselinedErrors.length} pre-existing broken IPC call(s) tracked in gate.config.json (run 'npm run verify:ipc -- --no-baseline' to inspect all).`,
      );
    }
    if (staleBaselineEntries.length > 0) {
      console.log(
        `[CLEANUP] ${staleBaselineEntries.length} legacyBaseline entry/entries fixed and ready to remove from gate.config.json:`,
      );
      for (const s of staleBaselineEntries) {
        console.log(`  - ${s.file} :: ${s.command}`);
      }
    }
    if (warnings.length > 0) {
      console.warn(`\n[WARN] ${warnings.length} IPC payload/signature warning(s):`);
      for (const w of warnings) {
        console.warn(`  - ${w.file}:${w.line} [${w.code}] ${w.message}`);
      }
    }
    if (errors.length === 0) {
      console.log(
        warnings.length === 0
          ? '[PASS] Zero new broken IPC contracts detected.'
          : `[PASS with ${warnings.length} warning(s)] Zero new broken IPC contracts detected.`,
      );
    }
  }

  const failed = result.errors.length > 0 || (strict && result.warnings.length > 0);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runCli();
}
