import React, { useEffect, useRef, useState, useId } from 'react';
import mermaid from 'mermaid';
import { CopyIcon, CheckIcon } from '../views/chat/ChatIcons';

// Initialize mermaid with appropriate theme
function initMermaid(isLight: boolean) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: isLight ? 'default' : 'dark',
    themeVariables: isLight
      ? {
          fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
          fontSize: '13px',
          primaryColor: '#3b82f6',
          primaryTextColor: '#1f2937',
          primaryBorderColor: '#93c5fd',
          lineColor: '#6b7280',
          secondaryColor: '#f3f4f6',
          tertiaryColor: '#ffffff',
        }
      : {
          fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
          fontSize: '13px',
          darkMode: true,
          background: '#16181d',
          primaryColor: '#1e293b',
          primaryTextColor: '#f8fafc',
          primaryBorderColor: '#38bdf8',
          lineColor: '#94a3b8',
          secondaryColor: '#0f172a',
          tertiaryColor: '#1e293b',
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rawId = useId().replace(/[:]/g, '_');
  const diagramId = `mermaid_${rawId}`;

  const cleanCode = code.trim();

  useEffect(() => {
    if (!cleanCode) {
      setSvgHtml(null);
      setError(null);
      return;
    }

    let isMounted = true;
    const isLight = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light';
    initMermaid(isLight);

    const renderDiagram = async () => {
      try {
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
  }, [cleanCode, diagramId]);

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
        borderRadius: '8px',
        border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.12))',
        background: 'var(--block-fill, #16181d)',
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
          background: 'var(--chip-fill, rgba(255, 255, 255, 0.05))',
          borderBottom: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.08))',
          fontSize: '11px',
          color: 'var(--text-secondary, #8b949e)',
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
                background: 'var(--surface-inset, rgba(0, 0, 0, 0.25))',
                borderRadius: '4px',
                padding: '2px',
                gap: '2px',
              }}
            >
              <button
                type="button"
                onClick={() => setViewMode('diagram')}
                style={{
                  padding: '2px 8px',
                  borderRadius: '3px',
                  border: 'none',
                  fontSize: '10.5px',
                  cursor: 'pointer',
                  background: viewMode === 'diagram' ? 'var(--accent, #3b82f6)' : 'transparent',
                  color: viewMode === 'diagram' ? '#ffffff' : 'inherit',
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
                  borderRadius: '3px',
                  border: 'none',
                  fontSize: '10.5px',
                  cursor: 'pointer',
                  background: viewMode === 'code' ? 'var(--accent, #3b82f6)' : 'transparent',
                  color: viewMode === 'code' ? '#ffffff' : 'inherit',
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
                background: 'var(--surface-inset, rgba(0, 0, 0, 0.3))',
                borderRadius: '4px',
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
              background: 'var(--surface-inset, rgba(0, 0, 0, 0.3))',
              borderRadius: '4px',
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
