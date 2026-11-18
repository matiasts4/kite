import React, { useState, useEffect, useMemo, useDeferredValue, useRef } from 'react';
import { SelectMenu } from '../../ui/SelectMenu';
import type { TelemetryPrefs, TelemetryIdentity } from './types';
import {
  runLedger,
  type RunRecord,
  redactSecrets,
} from '../../../lib/operator/runLedger';

const OUTCOME_LABELS: Record<string, string> = {
  all: 'Todos los resultados',
  success: 'Éxito',
  failure: 'Fallo',
  timeout: 'Tiempo agotado',
  cancelled: 'Cancelado',
};

interface TelemetryTabProps {
  telemetryPrefs: TelemetryPrefs;
  telemetryIdentity: TelemetryIdentity | null;
  onToggleTelemetry: (key: 'analytics' | 'diagnostics') => void;
}

export const TelemetryTab: React.FC<TelemetryTabProps> = ({
  telemetryPrefs,
  telemetryIdentity,
  onToggleTelemetry,
}) => {
  const [runs, setRuns] = useState<RunRecord[]>(() => runLedger.getRuns());
  const [runIdFilter, setRunIdFilter] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [modelFilter, setModelFilter] = useState('');
  const [taskTypeFilter, setTaskTypeFilter] = useState('all');
  const [outcomeFilter, setOutcomeFilter] = useState('all');
  const [minLatency, setMinLatency] = useState('');
  const [maxLatency, setMaxLatency] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const exportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const deferredRunIdFilter = useDeferredValue(runIdFilter);
  const deferredProviderFilter = useDeferredValue(providerFilter);
  const deferredModelFilter = useDeferredValue(modelFilter);
  const deferredTaskTypeFilter = useDeferredValue(taskTypeFilter);
  const deferredOutcomeFilter = useDeferredValue(outcomeFilter);
  const deferredMinLatency = useDeferredValue(minLatency);
  const deferredMaxLatency = useDeferredValue(maxLatency);
  const deferredDateFilter = useDeferredValue(dateFilter);

  useEffect(() => {
    // Refresh runs on mount and listen to runLedger events
    setRuns(runLedger.getRuns());
    const unsubscribe = runLedger.subscribe(() => {
      setRuns(runLedger.getRuns());
    });
    return () => {
      unsubscribe();
      if (exportTimerRef.current) clearTimeout(exportTimerRef.current);
    };
  }, []);

  const filteredRuns = useMemo(() => {
    const qRunId = deferredRunIdFilter.trim().toLowerCase();
    const qProvider = deferredProviderFilter !== 'all' ? deferredProviderFilter.toLowerCase() : '';
    const qModel = deferredModelFilter.trim().toLowerCase();
    const qTaskType = deferredTaskTypeFilter !== 'all' ? deferredTaskTypeFilter.toLowerCase() : '';
    const hasMinLatency = deferredMinLatency.trim().length > 0;
    const minLatencyNum = hasMinLatency ? Number(deferredMinLatency) : 0;
    const hasMaxLatency = deferredMaxLatency.trim().length > 0;
    const maxLatencyNum = hasMaxLatency ? Number(deferredMaxLatency) : 0;

    if (
      !qRunId &&
      !qProvider &&
      !qModel &&
      !qTaskType &&
      deferredOutcomeFilter === 'all' &&
      !hasMinLatency &&
      !hasMaxLatency &&
      !deferredDateFilter
    ) {
      return runs;
    }

    return runs.filter((r) => {
      if (qRunId && !r.runId.toLowerCase().includes(qRunId)) {
        return false;
      }
      if (qProvider && (!r.provider || !r.provider.toLowerCase().includes(qProvider))) {
        return false;
      }
      if (qModel && (!r.model || !r.model.toLowerCase().includes(qModel))) {
        return false;
      }
      if (qTaskType && (!r.taskType || !r.taskType.toLowerCase().includes(qTaskType))) {
        return false;
      }
      if (deferredOutcomeFilter !== 'all' && r.outcome !== deferredOutcomeFilter) {
        return false;
      }
      if (hasMinLatency && (r.durationMs || 0) < minLatencyNum) {
        return false;
      }
      if (hasMaxLatency && (r.durationMs || 0) > maxLatencyNum) {
        return false;
      }
      if (deferredDateFilter) {
        const runDate = new Date(r.startedAt).toISOString().slice(0, 10);
        if (runDate !== deferredDateFilter) {
          return false;
        }
      }
      return true;
    });
  }, [
    runs,
    deferredRunIdFilter,
    deferredProviderFilter,
    deferredModelFilter,
    deferredTaskTypeFilter,
    deferredOutcomeFilter,
    deferredMinLatency,
    deferredMaxLatency,
    deferredDateFilter,
  ]);

  const { stats, successRate } = useMemo(() => {
    const latencyStats = runLedger.getLatencyPercentiles(filteredRuns);
    let successes = 0;
    for (const r of filteredRuns) {
      if (r.outcome === 'success') successes += 1;
    }
    const rate = filteredRuns.length > 0 ? Math.round((successes / filteredRuns.length) * 100) : 100;
    return { stats: latencyStats, successRate: rate };
  }, [filteredRuns]);

  const handleExport = (format: 'json' | 'jsonl') => {
    const data = format === 'jsonl'
      ? filteredRuns.map((r) => JSON.stringify(r)).join('\n')
      : JSON.stringify(filteredRuns, null, 2);

    try {
      const blob = new Blob([data], { type: format === 'jsonl' ? 'application/x-ndjson' : 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `operator-run-history-${Date.now()}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      setExportMessage(`Historial exportado en ${format.toUpperCase()}.`);
    } catch {
      // Fallback: clipboard copy
      navigator.clipboard?.writeText(data);
      setExportMessage(`Historial copiado al portapapeles.`);
    }

    if (exportTimerRef.current) clearTimeout(exportTimerRef.current);
    exportTimerRef.current = setTimeout(() => setExportMessage(null), 3000);
  };

  const handleClearHistory = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    runLedger.clearHistory();
    setRuns([]);
    setConfirmClear(false);
    setExpandedRunId(null);
  };

  return (
    <div className="space-y-6">
      <section className="settings-group">
        <h2 className="settings-group__title">Privacidad</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Analítica de producto</h3>
              <p>Comparte el uso de funciones para mejorar Kite Code. Sin prompts, archivos ni direcciones de correo.</p>
            </div>
            <div className="settings-row__control">
              <button
                aria-checked={telemetryPrefs.analytics}
                aria-label="Analítica de producto"
                className="ui-switch"
                onClick={() => onToggleTelemetry('analytics')}
                role="switch"
                type="button"
              >
                <span aria-hidden="true" className="ui-switch__knob" />
              </button>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Informes de fallos y errores</h3>
              <p>Comparte informes redactados de fallos y categorías de error para corregir problemas de producción.</p>
            </div>
            <div className="settings-row__control">
              <button
                aria-checked={telemetryPrefs.diagnostics}
                aria-label="Informes de fallos y errores"
                className="ui-switch"
                onClick={() => onToggleTelemetry('diagnostics')}
                role="switch"
                type="button"
              >
                <span aria-hidden="true" className="ui-switch__knob" />
              </button>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Identificador anónimo</h3>
              <p>
                {telemetryIdentity?.id
                  ? `${telemetryIdentity.id.slice(0, 32)}…`
                  : 'Firma local de hardware generada en el dispositivo.'}
              </p>
            </div>
            <div className="settings-row__control">
              <span className="settings-badge" data-tone={telemetryIdentity?.ready ? 'running' : 'accent'}>
                {telemetryIdentity?.ready ? 'Listo' : 'Local'}
              </span>
            </div>
          </div>
        </div>
        <p className="settings-note">
          La configuración de privacidad se conserva localmente en este dispositivo.
        </p>
      </section>

      {/* Operator Run History & Execution Observability */}
      <section className="settings-group">
        <div className="flex items-center justify-between mb-2">
          <h2 className="settings-group__title">Latencia del operador e historial de ejecuciones</h2>
          <div className="flex items-center gap-2">
            <button
              className="px-2.5 py-1 text-xs rounded border border-neutral-700 hover:bg-neutral-800 text-neutral-300 transition"
              onClick={() => handleExport('json')}
              title="Exportar ejecuciones filtradas como JSON"
            >
              Exportar JSON
            </button>
            <button
              className="px-2.5 py-1 text-xs rounded border border-neutral-700 hover:bg-neutral-800 text-neutral-300 transition"
              onClick={() => handleExport('jsonl')}
              title="Exportar ejecuciones filtradas como JSONL"
            >
              Exportar JSONL
            </button>
            <button
              className={`px-2.5 py-1 text-xs rounded border transition ${
                confirmClear
                  ? 'bg-rose-900/60 border-rose-500 text-rose-200'
                  : 'border-neutral-700 hover:bg-neutral-800 text-neutral-400'
              }`}
              onClick={handleClearHistory}
              onMouseLeave={() => setConfirmClear(false)}
              title="Borrar todas las ejecuciones locales almacenadas del operador"
            >
              {confirmClear ? 'Haz clic de nuevo para confirmar' : 'Limpiar historial'}
            </button>
          </div>
        </div>

        {exportMessage && (
          <div className="mb-3 px-3 py-1.5 text-xs rounded bg-emerald-950/70 border border-emerald-600 text-emerald-200">
            {exportMessage}
          </div>
        )}

        {/* Aggregated Stats Badges */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
          <div className="p-3 rounded-lg bg-neutral-900 border border-neutral-800">
            <div className="text-[11px] text-neutral-400 uppercase tracking-wider">Latencia p50</div>
            <div className="text-xl font-semibold text-neutral-100">{stats.p50} ms</div>
          </div>
          <div className="p-3 rounded-lg bg-neutral-900 border border-neutral-800">
            <div className="text-[11px] text-neutral-400 uppercase tracking-wider">Latencia p95</div>
            <div className="text-xl font-semibold text-neutral-100">{stats.p95} ms</div>
          </div>
          <div className="p-3 rounded-lg bg-neutral-900 border border-neutral-800">
            <div className="text-[11px] text-neutral-400 uppercase tracking-wider">Latencia prom.</div>
            <div className="text-xl font-semibold text-neutral-100">{stats.avg} ms</div>
          </div>
          <div className="p-3 rounded-lg bg-neutral-900 border border-neutral-800">
            <div className="text-[11px] text-neutral-400 uppercase tracking-wider">Ejecuciones</div>
            <div className="text-xl font-semibold text-neutral-100">{filteredRuns.length}</div>
          </div>
          <div className="p-3 rounded-lg bg-neutral-900 border border-neutral-800">
            <div className="text-[11px] text-neutral-400 uppercase tracking-wider">Tasa de éxito</div>
            <div className="text-xl font-semibold text-emerald-400">{successRate}%</div>
          </div>
        </div>

        {/* Filters Grid */}
        <div className="p-3 rounded-lg bg-neutral-900/60 border border-neutral-800 space-y-3 mb-4">
          <div className="text-xs font-medium text-neutral-300">Filtrar historial</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-4 gap-2 text-xs">
            <div>
              <label className="block text-[10px] text-neutral-400 mb-0.5">ID de ejecución</label>
              <input
                type="text"
                value={runIdFilter}
                onChange={(e) => setRunIdFilter(e.target.value)}
                placeholder="Buscar runId…"
                className="w-full px-2 py-1 bg-neutral-950 border border-neutral-800 rounded text-neutral-200 focus:outline-none focus:border-neutral-600"
              />
            </div>
            <div>
              <label className="block text-[10px] text-neutral-400 mb-0.5">Proveedor</label>
              <SelectMenu
                label="Proveedor"
                variant="field"
                className="settings-select"
                value={providerFilter}
                rows={[
                  { id: 'all', title: 'Todos los proveedores' },
                  { id: 'local', title: 'local' },
                  { id: 'opencode', title: 'opencode' },
                  { id: 'vercel', title: 'vercel' },
                  { id: 'cloudflare', title: 'cloudflare' },
                  { id: 'grok', title: 'grok' },
                  { id: 'antigravity', title: 'antigravity' },
                ]}
                triggerLabel={providerFilter === 'all' ? 'Todos los proveedores' : providerFilter}
                onSelect={setProviderFilter}
              />
            </div>
            <div>
              <label className="block text-[10px] text-neutral-400 mb-0.5">Modelo</label>
              <input
                type="text"
                value={modelFilter}
                onChange={(e) => setModelFilter(e.target.value)}
                placeholder="ej. deepseek, gpt-4o…"
                className="w-full px-2 py-1 bg-neutral-950 border border-neutral-800 rounded text-neutral-200 focus:outline-none focus:border-neutral-600"
              />
            </div>
            <div>
              <label className="block text-[10px] text-neutral-400 mb-0.5">Tipo de tarea</label>
              <SelectMenu
                label="Tipo de tarea"
                variant="field"
                className="settings-select"
                value={taskTypeFilter}
                rows={[
                  { id: 'all', title: 'Todas las tareas' },
                  { id: 'open_terminals', title: 'open_terminals' },
                  { id: 'close_terminals', title: 'close_terminals' },
                  { id: 'inject_prompt', title: 'inject_prompt' },
                  { id: 'open_browser', title: 'open_browser' },
                  { id: 'narrate_summary', title: 'narrate_summary' },
                  { id: 'spawn_subagent', title: 'spawn_subagent' },
                  { id: 'chat_response', title: 'chat_response' },
                  { id: 'deterministic', title: 'deterministic' },
                ]}
                triggerLabel={taskTypeFilter === 'all' ? 'Todas las tareas' : taskTypeFilter}
                onSelect={setTaskTypeFilter}
              />
            </div>
            <div>
              <label className="block text-[10px] text-neutral-400 mb-0.5">Resultado</label>
              <SelectMenu
                label="Resultado"
                variant="field"
                className="settings-select"
                value={outcomeFilter}
                rows={[
                  { id: 'all', title: 'Todos los resultados' },
                  { id: 'success', title: 'Éxito' },
                  { id: 'failure', title: 'Fallo' },
                  { id: 'timeout', title: 'Tiempo agotado' },
                  { id: 'cancelled', title: 'Cancelado' },
                ]}
                triggerLabel={OUTCOME_LABELS[outcomeFilter] ?? outcomeFilter}
                onSelect={setOutcomeFilter}
              />
            </div>
            <div>
              <label className="block text-[10px] text-neutral-400 mb-0.5">Rango de latencia (ms)</label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  placeholder="Mín"
                  value={minLatency}
                  onChange={(e) => setMinLatency(e.target.value)}
                  className="w-1/2 px-2 py-1 bg-neutral-950 border border-neutral-800 rounded text-neutral-200 focus:outline-none focus:border-neutral-600"
                />
                <span className="text-neutral-500">-</span>
                <input
                  type="number"
                  placeholder="Máx"
                  value={maxLatency}
                  onChange={(e) => setMaxLatency(e.target.value)}
                  className="w-1/2 px-2 py-1 bg-neutral-950 border border-neutral-800 rounded text-neutral-200 focus:outline-none focus:border-neutral-600"
                />
              </div>
            </div>
            <div>
              <label className="block text-[10px] text-neutral-400 mb-0.5">Fecha</label>
              <input
                type="date"
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value)}
                className="w-full px-2 py-1 bg-neutral-950 border border-neutral-800 rounded text-neutral-200 focus:outline-none focus:border-neutral-600"
              />
            </div>
            <div className="flex items-end">
              <button
                className="px-2 py-1 w-full text-neutral-400 hover:text-neutral-200 border border-neutral-800 rounded hover:bg-neutral-800 text-center transition"
                onClick={() => {
                  setRunIdFilter('');
                  setProviderFilter('all');
                  setModelFilter('');
                  setTaskTypeFilter('all');
                  setOutcomeFilter('all');
                  setMinLatency('');
                  setMaxLatency('');
                  setDateFilter('');
                }}
              >
                Restablecer filtros
              </button>
            </div>
          </div>
        </div>

        {/* Runs List Table */}
        <div className="border border-neutral-800 rounded-lg overflow-hidden bg-neutral-950">
          {filteredRuns.length === 0 ? (
            <div className="p-8 text-center text-xs text-neutral-500">
              Ninguna ejecución del operador coincide con los criterios seleccionados.
            </div>
          ) : (
            <div className="divide-y divide-neutral-900 text-xs">
              <div className="grid grid-cols-12 gap-2 p-2.5 bg-neutral-900/80 font-medium text-neutral-400 text-[11px]">
                <div className="col-span-3">ID de ejecución</div>
                <div className="col-span-2">Tipo de tarea</div>
                <div className="col-span-3">Proveedor / Modelo</div>
                <div className="col-span-1 text-right">Latencia</div>
                <div className="col-span-1 text-center">Estado</div>
                <div className="col-span-2 text-right">Hora</div>
              </div>
              {filteredRuns.map((r) => {
                const isExpanded = expandedRunId === r.runId;
                const statusColor =
                  r.outcome === 'success'
                    ? 'text-emerald-400 bg-emerald-950/60 border-emerald-700/50'
                    : r.outcome === 'timeout'
                    ? 'text-amber-400 bg-amber-950/60 border-amber-700/50'
                    : r.outcome === 'cancelled'
                    ? 'text-neutral-400 bg-neutral-800/60 border-neutral-700/50'
                    : 'text-rose-400 bg-rose-950/60 border-rose-700/50';

                return (
                  <div key={r.runId} className="hover:bg-neutral-900/30 transition">
                    <div
                      className="grid grid-cols-12 gap-2 p-2.5 cursor-pointer items-center"
                      onClick={() => setExpandedRunId(isExpanded ? null : r.runId)}
                    >
                      <div className="col-span-3 font-mono text-[11px] text-neutral-300 truncate" title={r.runId}>
                        {r.runId}
                      </div>
                      <div className="col-span-2 text-neutral-400 truncate">
                        <span className="px-1.5 py-0.5 rounded bg-neutral-800 text-[10px]">
                          {r.taskType || 'chat'}
                        </span>
                      </div>
                      <div className="col-span-3 text-neutral-400 truncate" title={`${r.provider || 'local'} / ${r.model || 'heuristic'}`}>
                        <span className="text-neutral-200">{r.provider || 'local'}</span>
                        <span className="text-neutral-500"> / {r.model || 'heuristic'}</span>
                      </div>
                      <div className="col-span-1 text-right font-mono text-neutral-300">
                        {r.durationMs || 0} ms
                      </div>
                      <div className="col-span-1 text-center">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] border ${statusColor}`}>
                          {(r.outcome && OUTCOME_LABELS[r.outcome]) || r.outcome || 'desconocido'}
                        </span>
                      </div>
                      <div className="col-span-2 text-right text-neutral-500 text-[11px]">
                        {new Date(r.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </div>
                    </div>

                    {/* Expanded Run Detail Drawer */}
                    {isExpanded && (
                      <div className="p-3 bg-neutral-900/40 border-t border-neutral-900 space-y-2 text-[11px]">
                        <div>
                          <span className="text-neutral-500 font-medium">Entrada: </span>
                          <span className="text-neutral-200 font-mono">{redactSecrets(r.input)}</span>
                        </div>
                        {r.reply && (
                          <div>
                            <span className="text-neutral-500 font-medium">Respuesta: </span>
                            <span className="text-neutral-200">{redactSecrets(r.reply)}</span>
                          </div>
                        )}
                        {r.errorCategory && (
                          <div>
                            <span className="text-rose-400 font-medium">Categoría de error: </span>
                            <span className="text-rose-300 font-mono">{r.errorCategory}</span>
                          </div>
                        )}
                        {/* Timestamps */}
                        <div className="pt-1">
                          <span className="text-neutral-500 font-medium">Marcas de tiempo:</span>
                          <div className="mt-1 flex flex-wrap gap-2 text-[10px] font-mono text-neutral-400">
                            {r.timestamps.input && <span>entrada: {r.timestamps.input}</span>}
                            {r.timestamps.providerRequest && <span>solicitud: +{r.timestamps.providerRequest - r.startedAt}ms</span>}
                            {r.timestamps.firstToken && <span>primer_token: +{r.timestamps.firstToken - r.startedAt}ms</span>}
                            {r.timestamps.toolCallEmission && <span>emisión_herramienta: +{r.timestamps.toolCallEmission - r.startedAt}ms</span>}
                            {r.timestamps.toolStart && <span>inicio_herramienta: +{r.timestamps.toolStart - r.startedAt}ms</span>}
                            {r.timestamps.toolEnd && <span>fin_herramienta: +{r.timestamps.toolEnd - r.startedAt}ms</span>}
                            {r.timestamps.terminalExecution && <span>ejec_terminal: +{r.timestamps.terminalExecution - r.startedAt}ms</span>}
                            {r.timestamps.finalResponse && <span>respuesta_final: +{r.timestamps.finalResponse - r.startedAt}ms</span>}
                          </div>
                        </div>

                        {/* Tool Calls */}
                        {r.toolCalls.length > 0 && (
                          <div className="pt-1">
                            <span className="text-neutral-500 font-medium">Llamadas a herramientas ({r.toolCalls.length}):</span>
                            <div className="mt-1 space-y-1">
                              {r.toolCalls.map((tc, idx) => (
                                <div key={idx} className="p-1.5 rounded bg-neutral-950 border border-neutral-800 font-mono text-[10px]">
                                  <div className="flex justify-between text-neutral-300">
                                    <span>{tc.name}</span>
                                    <span>hash: {tc.argumentsHash} | {tc.ok !== false ? 'OK' : 'FALLO'}</span>
                                  </div>
                                  {tc.arguments && (
                                    <div className="text-neutral-400 truncate mt-0.5">
                                      {redactSecrets(JSON.stringify(tc.arguments))}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Terminal Outputs */}
                        {r.terminalOutputs.length > 0 && (
                          <div className="pt-1">
                            <span className="text-neutral-500 font-medium">Extractos de salida de terminal:</span>
                            <div className="mt-1 space-y-1">
                              {r.terminalOutputs.map((to, idx) => (
                                <div key={idx} className="p-1.5 rounded bg-neutral-950 border border-neutral-800 font-mono text-[10px] text-neutral-400">
                                  <div className="text-neutral-500 mb-0.5">Terminal: {to.terminalId || 'desconocida'} (código de salida {to.exitCode ?? 0})</div>
                                  <div className="break-all whitespace-pre-wrap">{redactSecrets(to.excerpt)}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Tokens */}
                        {r.tokenCounts && (
                          <div className="text-[10px] text-neutral-500 pt-1">
                            Tokens: entrada={r.tokenCounts.prompt ?? 0}, salida={r.tokenCounts.completion ?? 0}, caché={r.tokenCounts.cache ?? 0}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <p className="settings-note mt-2">
          Los secretos sin cifrar, claves de API y salidas extensas de terminal nunca se almacenan ni se muestran.
        </p>
      </section>
    </div>
  );
};
