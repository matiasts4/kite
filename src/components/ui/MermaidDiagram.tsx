import React, { useEffect, useRef, useState, useId } from 'react';
import type mermaidType from 'mermaid';
import { CopyIcon, CheckIcon } from '../views/chat/ChatIcons';

let mermaidModulePromise: Promise<typeof mermaidType> | null = null;
function loadMermaid(): Promise<typeof mermaidType> {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid').then((m) => m.default);
  }
  return mermaidModulePromise;
}

function readCssToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

// Initialize mermaid with active theme tokens
function initMermaid(mermaid: typeof mermaidType, isLight: boolean) {
  const background = readCssToken('--pane', isLight ? '#ffffff' : '#141414');
  const secondaryColor = readCssToken('--composer', isLight ? '#f3f4f6' : '#1c1c1c');
  const tertiaryColor = readCssToken('--menu-plate', isLight ? '#ffffff' : '#22242a');
  const primaryColor = readCssToken('--accent', isLight ? '#3b82f6' : '#5c8fff');
  const primaryTextColor = readCssToken('--text-primary', isLight ? '#1f2937' : '#f8fafc');
  const lineColor = readCssToken('--text-secondary', isLight ? '#6b7280' : '#94a3b8');

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: isLight ? 'default' : 'dark',
    themeVariables: isLight
      ? {
          fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
          fontSize: '13px',
          background,
          primaryColor,
          primaryTextColor,
          primaryBorderColor: primaryColor,
          lineColor,
          secondaryColor,
          tertiaryColor,
        }
      : {
          fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
          fontSize: '13px',
          darkMode: true,
          background,
          primaryColor: secondaryColor,
          primaryTextColor,
          primaryBorderColor: primaryColor,
          lineColor,
          secondaryColor: background,
          tertiaryColor,
        },
    flowchart: {
      useMaxWidth: true,
      htmlLabels: true,
      curve: 'basis',
    },
    sequence: {
      useMaxWidth: true,
    },
    gantt: {
      useMaxWidth: true,
    },
  });
}

export interface MermaidDiagramProps {
  code: string;
  className?: string;
}

export const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ code, className = '' }) => {
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'diagram' | 'code'>('diagram');
  const [copied, setCopied] = useState(false);
  const [themeTick, setThemeTick] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rawId = useId().replace(/[:]/g, '_');
  const diagramId = `mermaid_${rawId}`;

  const cleanCode = code.trim();

  useEffect(() => {
    const handleThemeChange = () => setThemeTick((t) => t + 1);
    window.addEventListener('kite:theme-changed', handleThemeChange);
    return () => window.removeEventListener('kite:theme-changed', handleThemeChange);
  }, []);

  useEffect(() => {
    if (!cleanCode) {
      setSvgHtml(null);
      setError(null);
      return;
    }

    let isMounted = true;
    const isLight = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light';

    const renderDiagram = async () => {
      try {
        const mermaid = await loadMermaid();
        if (!isMounted) return;
        initMermaid(mermaid, isLight);

        // Clear any old error elements mermaid might have appended to document.body
        const oldErr = document.getElementById(`d${diagramId}`);
        if (oldErr) oldErr.remove();

        // Render to SVG
        const { svg } = await mermaid.render(diagramId, cleanCode);
        if (isMounted) {
          setSvgHtml(svg);
          setError(null);
        }
      } catch (err: any) {
        // Clean up error element injected by mermaid
        const errEl = document.getElementById(`d${diagramId}`);
        if (errEl) errEl.remove();

        if (isMounted) {
          setError(err?.message || 'Error al renderizar el diagrama Mermaid');
          setSvgHtml(null);
        }
      }
    };

    void renderDiagram();

    return () => {
      isMounted = false;
      const errEl = document.getElementById(`d${diagramId}`);
      if (errEl) errEl.remove();
    };
  }, [cleanCode, diagramId, themeTick]);

  const handleCopy = () => {
    void navigator.clipboard.writeText(cleanCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={`mermaid-container ${className}`}
      style={{
        margin: '14px 0',
        borderRadius: 'var(--card-radius, 12px)',
        border: '1px solid var(--glass-border, var(--block-stroke, rgba(255, 255, 255, 0.12)))',
        background: 'var(--glass-elevated-bg, var(--block-fill, var(--pane, #141414)))',
        overflow: 'hidden',
        maxWidth: '100%',
        boxSizing: 'border-box',
      }}
    >
      <div
        className="mermaid-toolbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 12px',
          background: 'var(--block-fill, var(--chip-fill, rgba(255, 255, 255, 0.05)))',
          borderBottom: '1px solid var(--glass-border, var(--block-stroke, rgba(255, 255, 255, 0.08)))',
          fontSize: '11px',
          color: 'var(--text-secondary, #8b949e)',
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontWeight: 600, color: 'var(--text-primary, #f3f4f6)' }}>
            Diagrama Mermaid
          </span>
          {!error && (
            <div
              style={{
                display: 'inline-flex',
                background: 'var(--glass-nested-bg, var(--chip-fill, rgba(0, 0, 0, 0.25)))',
                border: '1px solid var(--glass-border, var(--block-stroke, rgba(255, 255, 255, 0.08)))',
                borderRadius: 'var(--vl-radius-sm, 6px)',
                padding: '2px',
                gap: '2px',
              }}
            >
              <button
                type="button"
                onClick={() => setViewMode('diagram')}
                style={{
                  padding: '2px 8px',
                  borderRadius: 'var(--vl-radius-xs, 4px)',
                  border: 'none',
                  fontSize: '10.5px',
                  cursor: 'pointer',
                  background: viewMode === 'diagram' ? 'var(--accent-fill, var(--accent, #3b82f6))' : 'transparent',
                  color: viewMode === 'diagram' ? 'var(--accent-on-fill, #ffffff)' : 'inherit',
                  fontWeight: viewMode === 'diagram' ? 600 : 400,
                  transition: 'all 0.15s ease',
                }}
              >
                Gráfico
              </button>
              <button
                type="button"
                onClick={() => setViewMode('code')}
                style={{
                  padding: '2px 8px',
                  borderRadius: 'var(--vl-radius-xs, 4px)',
                  border: 'none',
                  fontSize: '10.5px',
                  cursor: 'pointer',
                  background: viewMode === 'code' ? 'var(--accent-fill, var(--accent, #3b82f6))' : 'transparent',
                  color: viewMode === 'code' ? 'var(--accent-on-fill, #ffffff)' : 'inherit',
                  fontWeight: viewMode === 'code' ? 600 : 400,
                  transition: 'all 0.15s ease',
                }}
              >
                Código
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={handleCopy}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            background: 'none',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 'inherit',
          }}
          title="Copiar código fuente Mermaid"
        >
          {copied ? (
            <CheckIcon size={12} style={{ color: 'var(--status-running, #22c55e)' }} />
          ) : (
            <CopyIcon size={12} />
          )}
          <span>{copied ? 'Copiado' : 'Copiar'}</span>
        </button>
      </div>

      <div style={{ padding: '16px', overflowX: 'auto', textAlign: 'center' }}>
        {error ? (
          <div>
            <div
              style={{
                color: 'var(--status-failed, #f87171)',
                fontSize: '11.5px',
                marginBottom: '8px',
                textAlign: 'left',
              }}
            >
              ⚠️ No se pudo renderizar el diagrama ({error}). Mostrando código fuente:
            </div>
            <pre
              style={{
                textAlign: 'left',
                margin: 0,
                padding: '10px',
                background: 'var(--glass-code-bg, var(--terminal-canvas, rgba(0, 0, 0, 0.3)))',
                border: '1px solid var(--glass-border, var(--block-stroke, rgba(255, 255, 255, 0.08)))',
                borderRadius: 'var(--control-radius, 8px)',
                fontFamily: 'var(--font-mono, monospace)',
                fontSize: '11.5px',
                overflowX: 'auto',
                color: 'var(--text-secondary, #cbd5e1)',
              }}
            >
              <code>{cleanCode}</code>
            </pre>
          </div>
        ) : viewMode === 'code' ? (
          <pre
            style={{
              textAlign: 'left',
              margin: 0,
              padding: '10px',
              background: 'var(--glass-code-bg, var(--terminal-canvas, rgba(0, 0, 0, 0.3)))',
              border: '1px solid var(--glass-border, var(--block-stroke, rgba(255, 255, 255, 0.08)))',
              borderRadius: 'var(--control-radius, 8px)',
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: '11.5px',
              overflowX: 'auto',
              color: 'var(--text-secondary, #cbd5e1)',
            }}
          >
            <code>{cleanCode}</code>
          </pre>
        ) : svgHtml ? (
          <div
            ref={containerRef}
            className="mermaid-svg-wrapper"
            dangerouslySetInnerHTML={{ __html: svgHtml }}
            style={{
              display: 'flex',
              justifyContent: 'center',
              width: '100%',
              minHeight: '80px',
            }}
          />
        ) : (
          <div
            style={{
              color: 'var(--text-secondary, #94a3b8)',
              fontSize: '12px',
              padding: '20px',
            }}
          >
            Generando diagrama...
          </div>
        )}
      </div>
    </div>
  );
};
