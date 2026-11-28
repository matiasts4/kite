import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { invokeCommand, isTauriEnvironment } from '../../../lib/ipc/core';
import {
  pluginMcpAppCallTool,
  pluginMcpAppReadResource,
  type McpAppCspDto,
  type McpAppResourcePayload,
} from '../../../lib/ipc/pluginRuntime';
import { RefreshIcon } from './pluginIcons';
import './mcp-app-frame.css';

const INLINE_HEIGHT_DEFAULT = 280;
const INLINE_HEIGHT_MIN = 150;
const INLINE_HEIGHT_MAX = 800;
const SEP_1865_PROTOCOL_VERSION = '2026-01-26';

export interface McpAppFrameProps {
  serverName: string;
  resourceUri: string;
  toolName?: string;
  title?: string;
  mode?: 'inline' | 'dock';
  workspaceId?: string | null;
  toolInput?: Record<string, unknown> | null;
  toolResult?: Record<string, unknown> | null;
  instanceId?: string;
  isResizing?: boolean;
  onSendMessage?: (text: string, meta?: Record<string, unknown>) => void | Promise<void>;
  onUpdateModelContext?: (context: Record<string, unknown>) => void | Promise<void>;
  onOpenLink?: (url: string) => void | Promise<void>;
  className?: string;
}

interface JsonRpcRequestEnvelope {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: Record<string, unknown>;
}

function resolveDocumentTheme(): 'dark' | 'light' {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function sanitizeBareOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /[\s*;,'"<>\\]/.test(trimmed)) return null;
  const sep = trimmed.indexOf('://');
  if (sep <= 0) return null;
  const scheme = trimmed.slice(0, sep).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ws' && scheme !== 'wss') {
    return null;
  }
  const rest = trimmed.slice(sep + 3);
  if (!rest || /[/?#@]/.test(rest)) return null;
  try {
    const parsed = new URL(`${scheme}://${rest}`);
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
      return null;
    }
    return `${scheme}://${parsed.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

function sanitizeOriginArray(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const clean = sanitizeBareOrigin(item);
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

export function buildMcpAppCspPolicy(csp?: McpAppCspDto | null): string {
  const connect = sanitizeOriginArray(csp?.connectDomains);
  const resources = sanitizeOriginArray(csp?.resourceDomains);
  const frames = sanitizeOriginArray(csp?.frameDomains);
  const baseUri = sanitizeOriginArray(csp?.baseUriDomains);

  const resourceTail = resources.length > 0 ? ` ${resources.join(' ')}` : '';
  const directives = [
    "default-src 'none'",
    `script-src 'unsafe-inline'${resourceTail}`,
    `style-src 'unsafe-inline'${resourceTail}`,
    `img-src data: blob:${resourceTail}`,
    `font-src data:${resourceTail}`,
    `media-src data: blob:${resourceTail}`,
    `connect-src ${connect.length > 0 ? connect.join(' ') : "'none'"}`,
    `frame-src ${frames.length > 0 ? frames.join(' ') : "'none'"}`,
    `base-uri ${baseUri.length > 0 ? baseUri.join(' ') : "'none'"}`,
    "object-src 'none'",
    "form-action 'none'",
  ];
  return directives.join('; ');
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function injectCspMetaIntoHtml(html: string, csp?: McpAppCspDto | null): string {
  const policy = buildMcpAppCspPolicy(csp);
  const metaTag = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttr(policy)}">`;

  const headMatch = /<head(?:\s[^>]*)?>/i.exec(html);
  if (headMatch) {
    const insertAt = headMatch.index + headMatch[0].length;
    return `${html.slice(0, insertAt)}${metaTag}${html.slice(insertAt)}`;
  }

  const htmlMatch = /<html(?:\s[^>]*)?>/i.exec(html);
  if (htmlMatch) {
    const insertAt = htmlMatch.index + htmlMatch[0].length;
    return `${html.slice(0, insertAt)}<head>${metaTag}</head>${html.slice(insertAt)}`;
  }

  const doctypeMatch = /^\s*<!doctype\s+[^>]*>/i.exec(html);
  if (doctypeMatch) {
    const insertAt = doctypeMatch[0].length;
    return `${html.slice(0, insertAt)}<head>${metaTag}</head>${html.slice(insertAt)}`;
  }

  return `<head>${metaTag}</head>${html}`;
}

export function clampInlineAppHeight(rawHeight: unknown): number | null {
  if (typeof rawHeight !== 'number' || !Number.isFinite(rawHeight) || rawHeight <= 0) {
    return null;
  }
  return Math.min(INLINE_HEIGHT_MAX, Math.max(INLINE_HEIGHT_MIN, Math.round(rawHeight)));
}

function parseSafeHttpLink(params: Record<string, unknown> | undefined): string | null {
  const raw = params?.url ?? params?.uri ?? params?.href;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractMessageText(params: Record<string, unknown> | undefined): string {
  if (!params) return '';
  if (typeof params.text === 'string' && params.text.trim()) {
    return params.text.trim();
  }
  if (typeof params.content === 'string' && params.content.trim()) {
    return params.content.trim();
  }
  if (Array.isArray(params.content)) {
    return params.content
      .map((entry) => {
        if (entry && typeof entry === 'object' && 'text' in entry) {
          const t = (entry as { text?: unknown }).text;
          return typeof t === 'string' ? t : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

export const McpAppFrame: React.FC<McpAppFrameProps> = ({
  serverName,
  resourceUri,
  toolName,
  title,
  mode = 'inline',
  workspaceId = null,
  toolInput = null,
  toolResult = null,
  instanceId,
  isResizing = false,
  onSendMessage,
  onUpdateModelContext,
  onOpenLink,
  className = '',
}) => {
  const generatedId = useId();
  const resolvedInstanceId = instanceId?.trim() || `mcp-app-${generatedId}`;

  const [payload, setPayload] = useState<McpAppResourcePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bridgeNotice, setBridgeNotice] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [inlineHeight, setInlineHeight] = useState<number>(INLINE_HEIGHT_DEFAULT);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const initializedRef = useRef(false);
  const lastFlushedInputRef = useRef<Record<string, unknown> | null>(null);
  const lastFlushedResultRef = useRef<Record<string, unknown> | null>(null);

  const toolInputRef = useRef(toolInput);
  toolInputRef.current = toolInput;
  const toolResultRef = useRef(toolResult);
  toolResultRef.current = toolResult;

  const postToApp = useCallback((message: Record<string, unknown>) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(message, '*');
  }, []);

  const flushInitialPayloads = useCallback(() => {
    const currentInput = toolInputRef.current;
    if (currentInput != null && lastFlushedInputRef.current !== currentInput) {
      lastFlushedInputRef.current = currentInput;
      postToApp({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: currentInput } });
    }
    const currentResult = toolResultRef.current;
    if (currentResult != null && lastFlushedResultRef.current !== currentResult) {
      lastFlushedResultRef.current = currentResult;
      postToApp({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: currentResult });
    }
  }, [postToApp]);

  useEffect(() => {
    let cancelled = false;
    initializedRef.current = false;
    lastFlushedInputRef.current = null;
    lastFlushedResultRef.current = null;
    setLoading(true);
    setLoadError(null);
    setBridgeNotice(null);

    void pluginMcpAppReadResource({ serverName, uri: resourceUri, workspaceId })
      .then((res) => {
        if (!cancelled) setPayload(res);
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[McpAppFrame] Failed to load MCP App resource '${resourceUri}':`, err);
        setPayload(null);
        setLoadError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [serverName, resourceUri, workspaceId, reloadNonce]);

  useEffect(() => {
    if (initializedRef.current) flushInitialPayloads();
  }, [toolInput, toolResult, flushInitialPayloads]);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    let lastTheme = resolveDocumentTheme();
    const observer = new MutationObserver(() => {
      const nextTheme = resolveDocumentTheme();
      if (nextTheme === lastTheme) return;
      lastTheme = nextTheme;
      if (initializedRef.current) {
        postToApp({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: nextTheme } });
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [postToApp]);

  // SEP-1865 postMessage JSON-RPC bridge
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const frameWin = iframeRef.current?.contentWindow;
      if (!frameWin || event.source !== frameWin) {
        return;
      }
      const raw = event.data as JsonRpcRequestEnvelope | null | undefined;
      if (!raw || typeof raw !== 'object' || raw.jsonrpc !== '2.0' || typeof raw.method !== 'string') {
        return;
      }

      const method = raw.method;
      const reqId = raw.id;
      const hasId = reqId !== undefined && reqId !== null;
      const params = raw.params && typeof raw.params === 'object' ? raw.params : undefined;

      const replyResult = (result: unknown) => {
        if (hasId) postToApp({ jsonrpc: '2.0', id: reqId, result });
      };

      const replyError = (code: number, message: string) => {
        if (hasId) postToApp({ jsonrpc: '2.0', id: reqId, error: { code, message } });
      };

      const settleBridgePromise = (
        work: Promise<unknown>,
        label: string,
        surfaceNotice = false,
      ) => {
        void work
          .then((res) => replyResult(res === undefined ? {} : res))
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[McpAppFrame] ${label} failed:`, err);
            if (surfaceNotice) setBridgeNotice(msg);
            replyError(-32000, msg);
          });
      };

      switch (method) {
        case 'ui/initialize': {
          const displayMode = mode === 'inline' ? 'inline' : 'panel';
          replyResult({
            protocolVersion: SEP_1865_PROTOCOL_VERSION,
            hostInfo: { name: 'Kite Code', version: '0.1.94' },
            hostCapabilities: {
              openLinks: {},
              serverTools: { listChanged: false },
              logging: {},
              updateModelContext: { text: {} },
            },
            hostContext: {
              theme: resolveDocumentTheme(),
              displayMode,
              availableDisplayModes: [displayMode],
              ...(toolName ? { toolInfo: { tool: { name: toolName } } } : {}),
            },
          });
          break;
        }

        case 'ui/notifications/initialized': {
          initializedRef.current = true;
          flushInitialPayloads();
          break;
        }

        case 'tools/call': {
          const targetTool = typeof params?.name === 'string' ? params.name.trim() : '';
          if (!targetTool) {
            replyError(-32602, 'tools/call requires a non-empty tool name.');
            return;
          }
          const rawArgs = params?.arguments;
          const argsObj =
            rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
              ? (rawArgs as Record<string, unknown>)
              : {};
          settleBridgePromise(
            pluginMcpAppCallTool({
              instanceId: resolvedInstanceId,
              serverName,
              toolName: targetTool,
              arguments: argsObj,
              workspaceId,
            }),
            `tools/call '${targetTool}'`,
          );
          break;
        }

        case 'ui/message': {
          const text = extractMessageText(params);
          window.dispatchEvent(
            new CustomEvent('kite:mcp-app-message', {
              detail: {
                instanceId: resolvedInstanceId,
                serverName,
                resourceUri,
                workspaceId,
                text,
                params: params ?? {},
              },
            }),
          );
          if (onSendMessage) {
            settleBridgePromise(Promise.resolve(onSendMessage(text, params)), 'ui/message');
          } else {
            replyResult({});
          }
          break;
        }

        case 'ui/update-model-context': {
          const contextPayload = params ?? {};
          window.dispatchEvent(
            new CustomEvent('kite:mcp-app-model-context', {
              detail: {
                instanceId: resolvedInstanceId,
                serverName,
                resourceUri,
                workspaceId,
                context: contextPayload,
              },
            }),
          );
          if (onUpdateModelContext) {
            settleBridgePromise(
              Promise.resolve(onUpdateModelContext(contextPayload)),
              'ui/update-model-context',
            );
          } else {
            replyResult({});
          }
          break;
        }

        case 'ui/open-link': {
          const safeUrl = parseSafeHttpLink(params);
          if (!safeUrl) {
            setBridgeNotice('Blocked non-http(s) link request from MCP App.');
            replyError(-32602, 'Only http(s) URLs are allowed.');
            return;
          }
          if (onOpenLink) {
            settleBridgePromise(Promise.resolve(onOpenLink(safeUrl)), 'ui/open-link');
          } else if (isTauriEnvironment()) {
            settleBridgePromise(
              invokeCommand('open_external_link', { url: safeUrl }),
              'open_external_link IPC',
              true,
            );
          } else {
            window.open(safeUrl, '_blank', 'noopener,noreferrer');
            replyResult({});
          }
          break;
        }

        case 'ui/notifications/size-changed': {
          if (mode === 'inline') {
            const nextHeight = clampInlineAppHeight(params?.height);
            if (nextHeight !== null) setInlineHeight(nextHeight);
          }
          break;
        }

        default: {
          if (hasId) replyError(-32601, `Unsupported MCP App bridge method: ${method}`);
          break;
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [
    flushInitialPayloads,
    mode,
    onOpenLink,
    onSendMessage,
    onUpdateModelContext,
    postToApp,
    resolvedInstanceId,
    resourceUri,
    serverName,
    toolName,
    workspaceId,
  ]);

  const srcDoc = useMemo(() => (payload ? injectCspMetaIntoHtml(payload.html, payload.csp) : ''), [payload]);
  const resolvedTitle = title?.trim() || toolName?.trim() || resourceUri;
  const borderless = payload?.prefersBorder === false;
  const rootClassName = [
    'mcp-app-frame',
    mode === 'dock' ? 'mcp-app-frame--dock' : 'mcp-app-frame--inline',
    borderless ? 'mcp-app-frame--borderless' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  const viewportStyle =
    mode === 'inline'
      ? ({ '--mcp-app-inline-height': `${inlineHeight}px` } as React.CSSProperties)
      : undefined;

  return (
    <section
      className={rootClassName}
      aria-label={resolvedTitle}
      data-testid="mcp-app-frame"
      data-mode={mode}
      data-instance-id={resolvedInstanceId}
    >
      <header className="mcp-app-frame__header">
        <span className="mcp-app-frame__badge">App</span>
        <span className="mcp-app-frame__title" title={resolvedTitle}>{resolvedTitle}</span>
        <span className="mcp-app-frame__server" title={serverName}>{serverName}</span>
        <button
          type="button"
          className="mcp-app-frame__refresh-btn"
          aria-label="Reload MCP App"
          title="Reload MCP App"
          disabled={loading}
          onClick={() => setReloadNonce((n) => n + 1)}
        >
          <RefreshIcon size={12} />
        </button>
      </header>

      <div className="mcp-app-frame__viewport" style={viewportStyle}>
        {loading ? (
          <div className="mcp-app-frame__state" role="status">
            <span className="loading-spinner" aria-hidden="true" />
            <p className="mcp-app-frame__state-title">Loading {resolvedTitle}...</p>
          </div>
        ) : loadError || !payload ? (
          <div className="mcp-app-frame__state" role="alert">
            <p className="mcp-app-frame__state-title">Could not load {resolvedTitle}</p>
            <p className="mcp-app-frame__state-error">{loadError || 'Empty MCP App resource payload.'}</p>
            <button type="button" className="mcp-app-frame__retry-btn" onClick={() => setReloadNonce((n) => n + 1)}>
              Retry
            </button>
          </div>
        ) : (
          <>
            <iframe
              ref={iframeRef}
              key={`${serverName}:${resourceUri}:${reloadNonce}`}
              data-testid="mcp-app-iframe"
              title={resolvedTitle}
              sandbox="allow-scripts"
              srcDoc={srcDoc}
              className="mcp-app-frame__iframe"
            />
            {isResizing && (
              <div className="mcp-app-frame__resize-shield" data-testid="mcp-app-resize-shield" aria-hidden="true" />
            )}
          </>
        )}
      </div>

      {bridgeNotice && (
        <div className="mcp-app-frame__notice" role="status">
          <span>{bridgeNotice}</span>
          <button type="button" className="mcp-app-frame__notice-close" onClick={() => setBridgeNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
    </section>
  );
};
