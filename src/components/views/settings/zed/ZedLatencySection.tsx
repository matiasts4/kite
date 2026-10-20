import React from 'react';
import { TaskLatencySummaryRow } from '../../../../lib/operator/operatorConfig';

export interface ZedLatencySectionProps {
  testMessage: string | null;
  summaries: TaskLatencySummaryRow[];
  onClearMetrics: () => void;
}

export const ZedLatencySection: React.FC<ZedLatencySectionProps> = ({
  testMessage,
  summaries,
  onClearMetrics,
}) => {
  return (
    <section className="settings-group">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <h2 className="settings-group__title" style={{ margin: 0 }}>
          Rendimiento y Latencia por Proveedor / Tarea
        </h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="secondary-button"
            onClick={onClearMetrics}
            style={{ fontSize: 12 }}
          >
            Limpiar métricas
          </button>
        </div>
      </div>

      <div className="ui-card" style={{ padding: '14px 18px' }}>
        {testMessage && (
          <div
            style={{
              marginBottom: 12,
              padding: '8px 12px',
              borderRadius: 8,
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              fontSize: 12,
              color: 'var(--text-primary)',
            }}
          >
            {testMessage}
          </div>
        )}

        {summaries.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-muted)' }}>
            Aún no hay mediciones registradas. Pulsa &ldquo;Probar latencia&rdquo; o ejecuta un
            comando en el orbe de Zed para comparar la velocidad real de cada proveedor y
            modelo.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 12,
                textAlign: 'left',
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                    color: 'var(--text-muted)',
                  }}
                >
                  <th style={{ padding: '6px 8px' }}>Proveedor</th>
                  <th style={{ padding: '6px 8px' }}>Tarea</th>
                  <th style={{ padding: '6px 8px' }}>Muestras</th>
                  <th style={{ padding: '6px 8px' }}>Última</th>
                  <th style={{ padding: '6px 8px' }}>Promedio</th>
                  <th style={{ padding: '6px 8px' }}>Mín / Máx</th>
                  <th style={{ padding: '6px 8px' }}>Éxito</th>
                </tr>
              </thead>
              <tbody>
                {summaries.map((s) => (
                  <tr
                    key={`${s.providerId}-${s.taskType}`}
                    style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)' }}
                  >
                    <td style={{ padding: '8px', fontWeight: 600 }}>
                      {s.providerId.toUpperCase()}
                    </td>
                    <td style={{ padding: '8px', color: 'var(--text-secondary)' }}>
                      {s.taskType}
                    </td>
                    <td style={{ padding: '8px' }}>{s.count}</td>
                    <td style={{ padding: '8px', fontFamily: 'var(--font-mono)' }}>
                      {s.lastMs}ms
                    </td>
                    <td
                      style={{
                        padding: '8px',
                        fontFamily: 'var(--font-mono)',
                        fontWeight: 600,
                        color:
                          s.avgMs < 400
                            ? '#34d399'
                            : s.avgMs < 1200
                              ? '#fbbf24'
                              : '#f87171',
                      }}
                    >
                      {s.avgMs}ms
                    </td>
                    <td
                      style={{
                        padding: '8px',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text-muted)',
                      }}
                    >
                      {s.minMs}ms / {s.maxMs}ms
                    </td>
                    <td style={{ padding: '8px' }}>{Math.round(s.successRate * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
};
