export interface Token {
  text: string;
  className?: string;
}

export function isValidRevision64(revision?: string | null): boolean {
  return typeof revision === 'string' && /^[a-f0-9]{64}$/i.test(revision);
}

export async function toHex64String(str?: string | null, fallbackText: string = ''): Promise<string> {
  if (isValidRevision64(str)) {
    return (str as string).toLowerCase();
  }
  const source = str || fallbackText || 'kite-initial-revision-seed';
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toLowerCase();
  }
  // Safe deterministic 64-char fallback
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  const hexPart = Math.abs(hash).toString(16).padStart(8, '0');
  return hexPart.repeat(8).slice(0, 64);
}

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'default', 'import', 'from', 'export',
  'class', 'extends', 'implements', 'interface', 'type', 'struct', 'enum', 'fn',
  'pub', 'mut', 'impl', 'async', 'await', 'try', 'catch', 'finally', 'throw',
  'new', 'this', 'typeof', 'instanceof', 'void', 'as', 'in', 'of', 'def', 'elif',
  'lambda', 'yield', 'package', 'select'
]);

const TYPES = new Set([
  'string', 'number', 'boolean', 'any', 'unknown', 'never', 'void', 'Promise',
  'Record', 'Array', 'Set', 'Map', 'true', 'false', 'null', 'undefined', 'None',
  'True', 'False', 'self', 'Self', 'Option', 'Result', 'Some', 'Ok', 'Err', 'int',
  'float', 'bool', 'str'
]);

export function tokenizeLine(line: string): Token[] {
  if (!line) return [{ text: ' ' }];

  const tokens: Token[] = [];
  const regex = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[a-zA-Z_$][a-zA-Z0-9_$]*|\b\d+(?:\.\d+)?\b|[{}()[\];:.<>=+\-*\/&|!?%^~#]+|\s+)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: line.slice(lastIndex, match.index) });
    }
    const tokenStr = match[0];
    let className: string | undefined;

    if (tokenStr.startsWith('//') || tokenStr.startsWith('/*')) {
      className = 'token-comment';
    } else if (tokenStr.startsWith('"') || tokenStr.startsWith("'") || tokenStr.startsWith('`')) {
      className = 'token-string';
    } else if (KEYWORDS.has(tokenStr)) {
      className = 'token-keyword';
    } else if (TYPES.has(tokenStr)) {
      className = 'token-type';
    } else if (/^\d/.test(tokenStr)) {
      className = 'token-number';
    } else if (/^[{}()[\];:.<>=+\-*\/&|!?%^~#]+$/.test(tokenStr)) {
      className = 'token-punctuation';
    }

    tokens.push({ text: tokenStr, className });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < line.length) {
    tokens.push({ text: line.slice(lastIndex) });
  }

  return tokens.length > 0 ? tokens : [{ text: ' ' }];
}
