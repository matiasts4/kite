import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './remote-tab.css';
import {
  configureRemoteGateway,
  configureRemoteTailscale,
  createRemotePairing,
  getRemoteGatewayStatus,
  getRemoteTailscaleStatus,
  listRemoteDevices,
  revokeRemoteDevice,
  type MobileUpdateStatus,
  type RemoteBindMode,
  type RemoteGatewayStatus,
  type RemotePairedDevice,
  type RemotePairingSession,
  type RemoteTailscaleMode,
  type RemoteTailscaleStatus,
} from '../../../lib/ipc/remote';
import { generateQrSvgData } from '../../../lib/remote/qrSvg';
import { SegmentedIndicator } from '../../ui/SegmentedIndicator';

const DEFAULT_MOBILE_UPDATE: MobileUpdateStatus = {
  available: false,
  feedDir: '',
  versionName: null,
  versionCode: null,
  filename: null,
  sha256: null,
  sizeBytes: null,
  releaseNotes: null,
  publishedAtUnixMs: null,
  downloadPath: '/mobile/app/latest.apk',
};

const DEFAULT_TAILSCALE_STATUS: RemoteTailscaleStatus = {
  installed: false,
  cliPath: null,
  backendState: 'NotInstalled',
  running: false,
  ipv4: null,
  dnsName: null,
  magicDnsSuffix: null,
  funnelCapable: false,
  configuredMode: 'off',
  activeMode: 'off',
  httpsUrl: null,
  directIpUrl: null,
  approvalUrl: null,
  lastError: null,
};

const DEFAULT_GATEWAY_STATUS: RemoteGatewayStatus = {
  enabled: false,
  running: false,
  port: 17420,
  bindMode: 'lan',
  autoStart: false,
  publicUrl: null,
  tailscaleMode: 'off',
  connectedClients: 0,
  mobileUpdate: DEFAULT_MOBILE_UPDATE,
};

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  return fallback;
}

function formatCountdown(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatPlatformLabel(platform: string): string {
  const normalized = platform.trim().toLowerCase();
  if (normalized === 'android') return 'Android';
  if (normalized === 'ios') return 'iOS';
  if (normalized === 'web') return 'Web';
  return platform || 'Dispositivo';
}

function formatSpanishDateTime(unixMs: number): string {
  try {
    return new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(
      new Date(unixMs)
    );
  } catch (err) {
    console.warn('[RemoteTab] Failed to format timestamp:', err);
    return new Date(unixMs).toLocaleString();
  }
}

function formatLastSeen(unixMs: number): string {
  if (!Number.isFinite(unixMs) || unixMs <= 0) return 'Recién emparejado';
  return formatSpanishDateTime(unixMs);
}

function formatPublishedAt(unixMs: number | null | undefined): string | null {
  if (unixMs == null || !Number.isFinite(unixMs) || unixMs <= 0) return null;
  return formatSpanishDateTime(unixMs);
}

function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSha256Preview(sha256: string | null | undefined): string | null {
  const trimmed = sha256?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 16) return trimmed;
  return `${trimmed.slice(0, 12)}…${trimmed.slice(-6)}`;
}

function formatMobileVersion(update: MobileUpdateStatus): string | null {
  const version = update.versionName?.trim();
  const code = update.versionCode;
  if (version && code != null) return `v${version} (build ${code})`;
  if (version) return `v${version}`;
  if (code != null) return `Build ${code}`;
  return null;
}

function formatTailscaleBadge(ts: RemoteTailscaleStatus): {
  label: string;
  tone: 'running' | 'warning' | 'neutral';
} {
  if (!ts.installed) return { label: 'No instalado', tone: 'warning' };
  if (!ts.running) return { label: 'Sesión pendiente', tone: 'warning' };
  if (ts.activeMode === 'funnel') return { label: 'Funnel público', tone: 'running' };
  if (ts.activeMode === 'serve') return { label: 'Serve HTTPS', tone: 'running' };
  return { label: 'VPN privada', tone: 'running' };
}

export const RemoteTab: React.FC = () => {
  const [status, setStatus] = useState<RemoteGatewayStatus>(DEFAULT_GATEWAY_STATUS);
  const [devices, setDevices] = useState<RemotePairedDevice[]>([]);
  const [bindMode, setBindMode] = useState<RemoteBindMode>('lan');
  const [portInput, setPortInput] = useState<string>('17420');
  const [publicUrlInput, setPublicUrlInput] = useState<string>('');
  const [tailscaleOverride, setTailscaleOverride] = useState<RemoteTailscaleStatus | null>(null);
  const [tailscaleBusy, setTailscaleBusy] = useState<boolean>(false);
  const [tailscaleError, setTailscaleError] = useState<string | null>(null);
  const [publicUrlSavedNotice, setPublicUrlSavedNotice] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [savedNotice, setSavedNotice] = useState<boolean>(false);
  const [pairing, setPairing] = useState<RemotePairingSession | null>(null);
  const [pairingLoading, setPairingLoading] = useState<boolean>(false);
  const [remainingSeconds, setRemainingSeconds] = useState<number>(0);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [copiedTarget, setCopiedTarget] = useState<string | null>(null);
  const [pairedNotice, setPairedNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publicUrlTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pairedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousDeviceIdsRef = useRef<Set<string>>(new Set());
  const pairingRef = useRef<RemotePairingSession | null>(null);
  pairingRef.current = pairing;

  const applyStatusSnapshot = useCallback((next: RemoteGatewayStatus, syncInputs = true) => {
    setStatus(next);
    if (next.tailscale) {
      setTailscaleOverride(next.tailscale);
    }
    if (syncInputs) {
      setBindMode(next.bindMode);
      setPortInput(String(next.port));
      setPublicUrlInput(next.publicUrl ?? '');
    }
  }, []);

  const loadSnapshot = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = Boolean(options?.silent);
      if (!silent) {
        setLoading(true);
      }
      try {
        const [gatewayRes, devicesRes] = await Promise.all([
          getRemoteGatewayStatus(),
          listRemoteDevices(),
        ]);
        const prevIds = previousDeviceIdsRef.current;
        const newlyPaired = devicesRes.find((d) => !prevIds.has(d.id));
        previousDeviceIdsRef.current = new Set(devicesRes.map((d) => d.id));

        if (silent && pairingRef.current && gatewayRes.pairingActive === false && newlyPaired) {
          setPairing(null);
          setPairedNotice(`Dispositivo "${newlyPaired.name}" emparejado correctamente.`);
          if (pairedTimerRef.current) clearTimeout(pairedTimerRef.current);
          pairedTimerRef.current = setTimeout(() => setPairedNotice(null), 5000);
        }

        applyStatusSnapshot(gatewayRes, !silent);
        setDevices(devicesRes);
        setError(null);
      } catch (err) {
        console.warn('[RemoteTab] Failed to load remote gateway snapshot:', err);
        if (!silent) {
          setError(
            extractErrorMessage(err, 'No se pudo obtener el estado del gateway remoto.')
          );
        }
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [applyStatusSnapshot]
  );

  useEffect(() => {
    void loadSnapshot();
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      if (publicUrlTimerRef.current) clearTimeout(publicUrlTimerRef.current);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      if (pairedTimerRef.current) clearTimeout(pairedTimerRef.current);
    };
  }, [loadSnapshot]);

  const isActive = status.running ?? status.enabled;

  useEffect(() => {
    if (!isActive && !pairing) return;
    const poll = setInterval(() => {
      void loadSnapshot({ silent: true });
    }, 3000);
    return () => clearInterval(poll);
  }, [isActive, pairing, loadSnapshot]);

  useEffect(() => {
    if (!pairing) {
      setRemainingSeconds(0);
      return;
    }
    const updateRemaining = () => {
      const diffSec = Math.max(
        0,
        Math.ceil((pairing.expiresAtUnixMs - Date.now()) / 1000)
      );
      setRemainingSeconds(diffSec);
    };
    updateRemaining();
    const timer = setInterval(updateRemaining, 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  const updateGatewayConfig = useCallback(
    async (
      patch: Parameters<typeof configureRemoteGateway>[0],
      fallbackError: string,
      notifySaved = false
    ) => {
      if (saving || loading) return;
      setSaving(true);
      setError(null);
      try {
        const updated = await configureRemoteGateway(patch);
        applyStatusSnapshot(updated);
        if (notifySaved) {
          setSavedNotice(true);
          if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
          savedTimerRef.current = setTimeout(() => setSavedNotice(false), 2500);
        }
      } catch (err) {
        console.warn('[RemoteTab] Failed to configure remote gateway:', err);
        setError(extractErrorMessage(err, fallbackError));
      } finally {
        setSaving(false);
      }
    },
    [applyStatusSnapshot, loading, saving]
  );

  const handleToggleEnabled = () => {
    const nextEnabled = !status.enabled;
    if (!nextEnabled) {
      setPairing(null);
      setPairedNotice(null);
    }
    void updateGatewayConfig(
      { enabled: nextEnabled },
      'No se pudo cambiar el estado del gateway remoto.'
    );
  };

  const handleToggleAutoStart = () =>
    void updateGatewayConfig({ autoStart: !status.autoStart }, 'No se pudo actualizar el inicio automático.');

  const handleSaveNetworkConfig = () => {
    if (saving || loading) return;
    const parsedPort = Number(portInput);
    if (!Number.isInteger(parsedPort) || parsedPort < 1024 || parsedPort > 65535) {
      setError('El puerto TCP debe ser un número entero entre 1024 y 65535.');
      return;
    }
    void updateGatewayConfig(
      { port: parsedPort, bindMode, autoStart: status.autoStart },
      'No se pudo guardar la configuración de red.',
      true
    );
  };

  const handleRefreshTailscale = async () => {
    if (tailscaleBusy || loading) return;
    setTailscaleBusy(true);
    setTailscaleError(null);
    try {
      const probed = await getRemoteTailscaleStatus(true);
      setTailscaleOverride(probed);
      await loadSnapshot({ silent: true });
    } catch (err) {
      setTailscaleError(
        extractErrorMessage(err, 'No se pudo verificar el estado de Tailscale.')
      );
    } finally {
      setTailscaleBusy(false);
    }
  };

  const handleSelectTailscaleMode = async (nextMode: RemoteTailscaleMode) => {
    if (tailscaleBusy || saving || loading) return;
    const currentMode = (tailscaleOverride ?? status.tailscale)?.activeMode ?? status.tailscaleMode ?? 'off';
    if (nextMode === currentMode) return;
    setTailscaleBusy(true);
    setTailscaleError(null);
    try {
      const updated = await configureRemoteTailscale(nextMode);
      applyStatusSnapshot(updated, false);
    } catch (err) {
      setTailscaleError(
        extractErrorMessage(err, 'No se pudo cambiar el modo de acceso Tailscale.')
      );
      try {
        setTailscaleOverride(await getRemoteTailscaleStatus(true));
      } catch {
        // Best effort refresh to capture approvalUrl if CLI emitted one
      }
    } finally {
      setTailscaleBusy(false);
    }
  };

  const handleSavePublicUrl = async () => {
    if (saving || loading || tailscaleBusy) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await configureRemoteGateway({ publicUrl: publicUrlInput.trim() });
      applyStatusSnapshot(updated, true);
      setPublicUrlSavedNotice(true);
      if (publicUrlTimerRef.current) clearTimeout(publicUrlTimerRef.current);
      publicUrlTimerRef.current = setTimeout(() => setPublicUrlSavedNotice(false), 2500);
    } catch (err) {
      setError(extractErrorMessage(err, 'No se pudo guardar la URL fija externa.'));
    } finally {
      setSaving(false);
    }
  };

  const tailscale = tailscaleOverride ?? status.tailscale ?? DEFAULT_TAILSCALE_STATUS;
  const tailscaleBadge = formatTailscaleBadge(tailscale);
  const selectedTailscaleMode: RemoteTailscaleMode =
    tailscale.activeMode !== 'off'
      ? tailscale.activeMode
      : status.tailscaleMode ?? tailscale.configuredMode ?? 'off';

  const handleGeneratePairing = async () => {
    if (pairingLoading || loading || saving) return;
    setPairingLoading(true);
    setPairedNotice(null);
    setError(null);
    try {
      if (!isActive) {
        const updated = await configureRemoteGateway({ enabled: true });
        applyStatusSnapshot(updated);
        if (updated.running === false || updated.enabled === false) {
          throw new Error(
            updated.lastError ||
              'No se pudo iniciar el gateway remoto para generar el código QR.'
          );
        }
      }
      setPairing(await createRemotePairing());
    } catch (err) {
      console.warn('[RemoteTab] Failed to create pairing QR session:', err);
      setError(extractErrorMessage(err, 'No se pudo generar el código QR de emparejamiento.'));
    } finally {
      setPairingLoading(false);
    }
  };

  const handleRevokeDevice = async (deviceId: string) => {
    if (revokingId) return;
    setRevokingId(deviceId);
    setError(null);
    try {
      setDevices(await revokeRemoteDevice(deviceId));
      try {
        applyStatusSnapshot(await getRemoteGatewayStatus());
      } catch (statusErr) {
        console.warn('[RemoteTab] Failed to refresh gateway status after revoke:', statusErr);
      }
    } catch (err) {
      console.warn('[RemoteTab] Failed to revoke remote device:', err);
      setError(extractErrorMessage(err, 'No se pudo revocar el acceso del dispositivo.'));
    } finally {
      setRevokingId(null);
    }
  };

  const handleCopyValue = async (value: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      }
      setCopiedTarget(value);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedTarget(null), 2000);
    } catch (err) {
      console.warn('[RemoteTab] Clipboard copy failed:', err);
      setError('No se pudo copiar la dirección al portapapeles.');
    }
  };

  const qrRenderState = useMemo(() => {
    if (!pairing?.uri) return { qr: null, qrError: null };
    try {
      return { qr: generateQrSvgData(pairing.uri), qrError: null };
    } catch (err) {
      console.warn('[RemoteTab] Failed to encode pairing URI into QR:', err);
      return {
        qr: null,
        qrError: extractErrorMessage(err, 'No se pudo codificar el QR de emparejamiento.'),
      };
    }
  }, [pairing]);

  const candidateUrls = useMemo(() => {
    if (!pairing) return [];
    if (Array.isArray(pairing.candidateUrls) && pairing.candidateUrls.length > 0) {
      return pairing.candidateUrls;
    }
    return (pairing.hosts ?? []).map((host) => `http://${host}:${pairing.port}`);
  }, [pairing]);

  const statusCandidateUrls = useMemo(() => {
    if (Array.isArray(status.candidateUrls) && status.candidateUrls.length > 0) {
      return status.candidateUrls;
    }
    return (status.candidateHosts ?? []).map((host) => `http://${host}:${status.port}`);
  }, [status]);

  const clientsCount = status.connectedClients ?? 0;
  const clientsLabel =
    clientsCount === 1 ? '1 cliente conectado' : `${clientsCount} clientes conectados`;

  const emuPairCommand = pairing ? `npm run emu:pair "${pairing.uri}"` : '';

  const mobileUpdate = status.mobileUpdate;
  const mobileUpdateAvailable = Boolean(mobileUpdate?.available);
  const mobileFeedDir = mobileUpdate?.feedDir?.trim() ?? '';
  const mobileDownloadPath = mobileUpdate?.downloadPath?.trim() ?? '';
  const mobileVersionLabel = mobileUpdate ? formatMobileVersion(mobileUpdate) : null;
  const mobileSizeLabel = mobileUpdate ? formatBytes(mobileUpdate.sizeBytes) : null;
  const mobileShaPreview = mobileUpdate ? formatSha256Preview(mobileUpdate.sha256) : null;
  const mobilePublishedLabel = mobileUpdate
    ? formatPublishedAt(mobileUpdate.publishedAtUnixMs)
    : null;
  const mobileReleaseNotes = mobileUpdate?.releaseNotes?.trim() || null;
  const mobileMetaParts = [
    mobileVersionLabel,
    mobileUpdate?.filename?.trim() || null,
    mobileSizeLabel,
    mobilePublishedLabel ? `Publicado: ${mobilePublishedLabel}` : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <>
      {error && (
        <div className="remote-tab__alert" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="ghost-button remote-tab__alert-dismiss"
            onClick={() => setError(null)}
          >
            Descartar
          </button>
        </div>
      )}

      {pairedNotice && (
        <div className="remote-tab__success" role="status">
          <span>{pairedNotice}</span>
          <button
            type="button"
            className="ghost-button remote-tab__alert-dismiss"
            onClick={() => setPairedNotice(null)}
          >
            Ocultar
          </button>
        </div>
      )}

      <section className="settings-group" aria-labelledby="remote-gateway-status-heading">
        <h2 id="remote-gateway-status-heading" className="settings-group__title">Gateway Remoto</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">
                <span>Estado del servidor</span>
                <span className="settings-badge" data-tone={isActive ? 'running' : 'warning'}>
                  {isActive ? 'Activo' : 'Detenido'}
                </span>
              </h3>
              <p>
                {isActive
                  ? `Puerto ${status.port} · ${clientsLabel}${status.hostName ? ` · ${status.hostName}` : ''}`
                  : `Servicio detenido · Puerto configurado ${status.port} · ${clientsLabel}`}
              </p>
              {status.lastError && <p data-tone="failed">{status.lastError}</p>}
            </div>
            <div className="settings-row__control">
              <button type="button" role="switch" aria-checked={status.enabled} aria-label="Habilitar gateway remoto" className="ui-switch" disabled={saving || loading} onClick={handleToggleEnabled}>
                <span aria-hidden="true" className="ui-switch__knob" />
              </button>
            </div>
          </div>

          {isActive && statusCandidateUrls.length > 0 && (
            <div className="remote-tab__status-urls">
              <h4 className="remote-tab__urls-title">Direcciones activas de escucha</h4>
              {statusCandidateUrls.map((url) => (
                <div key={url} className="remote-tab__url-row">
                  <code className="remote-tab__url">{url}</code>
                  <button
                    type="button"
                    className="secondary-button remote-tab__copy-btn"
                    onClick={() => void handleCopyValue(url)}
                  >
                    {copiedTarget === url ? 'Copiado' : 'Copiar'}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Inicio automático</h3>
              <p>Levanta el servidor remoto automáticamente al iniciar Kite Code.</p>
            </div>
            <div className="settings-row__control">
              <button type="button" role="switch" aria-checked={status.autoStart} aria-label="Inicio automático del gateway remoto" className="ui-switch" disabled={saving || loading} onClick={handleToggleAutoStart}>
                <span aria-hidden="true" className="ui-switch__knob" />
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="remote-network-heading">
        <h2 id="remote-network-heading" className="settings-group__title">Configuración de red</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Modo de escucha</h3>
              <p>LAN y Tailscale permite conexiones desde Wi-Fi local y red privada; Solo local escucha en 127.0.0.1.</p>
            </div>
            <div className="settings-row__control">
              <fieldset aria-label="Modo de escucha" className="ui-segmented">
                <button type="button" aria-pressed={bindMode === 'lan'} className="ui-segmented__item" disabled={saving || loading} onClick={() => setBindMode('lan')}>
                  {bindMode === 'lan' && <SegmentedIndicator group="settings-remote-bind-mode" />}
                  <span>LAN y Tailscale</span>
                </button>
                <button type="button" aria-pressed={bindMode === 'loopback'} className="ui-segmented__item" disabled={saving || loading} onClick={() => setBindMode('loopback')}>
                  {bindMode === 'loopback' && <SegmentedIndicator group="settings-remote-bind-mode" />}
                  <span>Solo local</span>
                </button>
              </fieldset>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">
                <label htmlFor="remote-gateway-port">Puerto TCP</label>
              </h3>
              <p>Puerto HTTP + WebSocket para el protocolo kite-remote/v1.</p>
            </div>
            <div className="settings-row__control">
              <div className="remote-tab__port-actions">
                <input
                  id="remote-gateway-port"
                  type="number"
                  min={1024}
                  max={65535}
                  className="ui-field remote-tab__port-input"
                  value={portInput}
                  disabled={saving || loading}
                  onChange={(e) => setPortInput(e.target.value)}
                />
                <button
                  type="button"
                  className="primary-button remote-tab__btn"
                  disabled={saving || loading}
                  onClick={handleSaveNetworkConfig}
                >
                  Guardar configuración
                </button>
                {savedNotice && <span className="remote-tab__save-feedback">Guardado</span>}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="remote-tailscale-heading">
        <div className="remote-tab__group-head">
          <h2 id="remote-tailscale-heading" className="settings-group__title">
            Acceso externo (Tailscale)
          </h2>
          <button
            type="button"
            className="secondary-button remote-tab__copy-btn"
            disabled={tailscaleBusy || loading}
            onClick={() => void handleRefreshTailscale()}
          >
            {tailscaleBusy ? 'Verificando…' : 'Verificar'}
          </button>
        </div>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">
                <span>Túnel Tailscale (URL fija sin dominio)</span>
                <span className="settings-badge" data-tone={tailscaleBadge.tone}>
                  {tailscaleBadge.label}
                </span>
              </h3>
              <p>
                {!tailscale.installed
                  ? 'Instala Tailscale en esta PC para obtener una URL HTTPS fija (*.ts.net) y conectarte desde cualquier red.'
                  : !tailscale.running
                    ? `Inicia sesión en la app de Tailscale (estado: ${tailscale.backendState}) y pulsa Verificar.`
                    : [
                        tailscale.ipv4 ? `IP: ${tailscale.ipv4}` : null,
                        tailscale.dnsName ? `Host: ${tailscale.dnsName}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'Conectado a tu red Tailscale'}
              </p>
            </div>
            {tailscale.installed && tailscale.running && (
              <div className="settings-row__control">
                <fieldset aria-label="Modo de acceso Tailscale" className="ui-segmented">
                  <button
                    type="button"
                    aria-pressed={selectedTailscaleMode === 'off'}
                    className="ui-segmented__item"
                    disabled={tailscaleBusy || saving || loading}
                    onClick={() => void handleSelectTailscaleMode('off')}
                  >
                    {selectedTailscaleMode === 'off' && (
                      <SegmentedIndicator group="settings-remote-tailscale-mode" />
                    )}
                    <span>Solo VPN</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={selectedTailscaleMode === 'serve'}
                    className="ui-segmented__item"
                    disabled={tailscaleBusy || saving || loading}
                    onClick={() => void handleSelectTailscaleMode('serve')}
                  >
                    {selectedTailscaleMode === 'serve' && (
                      <SegmentedIndicator group="settings-remote-tailscale-mode" />
                    )}
                    <span>Serve (HTTPS privado)</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={selectedTailscaleMode === 'funnel'}
                    className="ui-segmented__item"
                    disabled={tailscaleBusy || saving || loading}
                    onClick={() => void handleSelectTailscaleMode('funnel')}
                  >
                    {selectedTailscaleMode === 'funnel' && (
                      <SegmentedIndicator group="settings-remote-tailscale-mode" />
                    )}
                    <span>Funnel (HTTPS público)</span>
                  </button>
                </fieldset>
              </div>
            )}
          </div>

          <div className="remote-tab__tailscale-details">
            {!tailscale.installed && (
              <div className="remote-tab__urls">
                <h4 className="remote-tab__urls-title">Instalación rápida (PowerShell)</h4>
                <div className="remote-tab__url-row">
                  <code className="remote-tab__url">winget install Tailscale.Tailscale</code>
                  <button
                    type="button"
                    className="secondary-button remote-tab__copy-btn"
                    onClick={() => void handleCopyValue('winget install Tailscale.Tailscale')}
                  >
                    {copiedTarget === 'winget install Tailscale.Tailscale' ? 'Copiado' : 'Copiar'}
                  </button>
                </div>
              </div>
            )}

            {tailscale.installed && tailscale.running && tailscale.httpsUrl && (
              <div className="remote-tab__urls">
                <h4 className="remote-tab__urls-title">URL HTTPS fija activa</h4>
                <div className="remote-tab__url-row">
                  <code className="remote-tab__url">{tailscale.httpsUrl}</code>
                  <button
                    type="button"
                    className="secondary-button remote-tab__copy-btn"
                    onClick={() => void handleCopyValue(tailscale.httpsUrl!)}
                  >
                    {copiedTarget === tailscale.httpsUrl ? 'Copiado' : 'Copiar'}
                  </button>
                </div>
              </div>
            )}

            {tailscale.installed && tailscale.running && (
              <p className="remote-tab__hint">
                Con Funnel (HTTPS público) no necesitas instalar Tailscale en el teléfono. Los teléfonos ya emparejados sincronizan esta URL automáticamente al conectarse.
              </p>
            )}

            {tailscale.approvalUrl && (
              <div className="remote-tab__callout" data-tone="warning">
                <p className="remote-tab__hint">
                  Tu tailnet requiere aprobar Serve/Funnel una única vez desde el navegador:
                </p>
                <div className="remote-tab__url-row">
                  <code className="remote-tab__url">{tailscale.approvalUrl}</code>
                  <button
                    type="button"
                    className="secondary-button remote-tab__copy-btn"
                    onClick={() => void handleCopyValue(tailscale.approvalUrl!)}
                  >
                    {copiedTarget === tailscale.approvalUrl ? 'Enlace copiado' : 'Copiar enlace'}
                  </button>
                </div>
              </div>
            )}

            {(tailscaleError || tailscale.lastError) && (
              <p className="remote-tab__hint" data-tone="failed">
                {tailscaleError || tailscale.lastError}
              </p>
            )}
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">
                <label htmlFor="remote-public-url">URL fija externa (opcional)</label>
              </h3>
              <p>Opcional: ingresa manualmente una URL HTTPS fija de Tailscale o túnel externo.</p>
            </div>
            <div className="settings-row__control">
              <div className="remote-tab__public-url-actions">
                <input
                  id="remote-public-url"
                  type="url"
                  className="ui-field remote-tab__public-url-input"
                  placeholder="https://mi-pc.tailxxxx.ts.net"
                  value={publicUrlInput}
                  disabled={saving || loading || tailscaleBusy}
                  onChange={(e) => setPublicUrlInput(e.target.value)}
                />
                <button
                  type="button"
                  className="secondary-button remote-tab__btn"
                  disabled={saving || loading || tailscaleBusy}
                  onClick={() => void handleSavePublicUrl()}
                >
                  Guardar URL
                </button>
                {publicUrlSavedNotice && (
                  <span className="remote-tab__save-feedback">Guardado</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="remote-pairing-heading">
        <h2 id="remote-pairing-heading" className="settings-group__title">
          Emparejar dispositivo Android
        </h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Código QR y clave temporal</h3>
              <p>Genera un token temporal de un solo uso (5 minutos) para vincular la app móvil por LAN o Tailscale.</p>
            </div>
            <div className="settings-row__control">
              <button
                type="button"
                className="primary-button remote-tab__btn"
                disabled={pairingLoading || loading}
                onClick={handleGeneratePairing}
              >
                {pairingLoading ? 'Generando…' : 'Generar código QR'}
              </button>
            </div>
          </div>

          {pairing && (
            <div className="remote-tab__pairing-panel">
              {qrRenderState.qr ? (
                <div className="remote-tab__qr-col">
                  <div
                    className="remote-tab__qr-frame"
                    data-expired={remainingSeconds <= 0 ? 'true' : 'false'}
                  >
                    <svg
                      role="img"
                      aria-label="Código QR de emparejamiento remoto"
                      className="remote-tab__qr-svg"
                      viewBox={`-4 -4 ${qrRenderState.qr.size + 8} ${qrRenderState.qr.size + 8}`}
                      shapeRendering="crispEdges"
                    >
                      <path d={qrRenderState.qr.svgPath} fill="currentColor" />
                    </svg>
                  </div>
                  <div className="remote-tab__uri-actions">
                    <button
                      type="button"
                      className="secondary-button remote-tab__copy-btn"
                      onClick={() => void handleCopyValue(pairing.uri)}
                    >
                      {copiedTarget === pairing.uri ? 'Enlace copiado' : 'Copiar enlace'}
                    </button>
                    <button
                      type="button"
                      className="secondary-button remote-tab__copy-btn"
                      disabled={pairingLoading || loading}
                      onClick={() => void handleGeneratePairing()}
                    >
                      Nuevo código
                    </button>
                  </div>
                </div>
              ) : (
                qrRenderState.qrError && (
                  <p className="settings-note" data-tone="failed">{qrRenderState.qrError}</p>
                )
              )}

              <div className="remote-tab__pairing-meta">
                <div className="remote-tab__code-box">
                  <div>
                    <div className="remote-tab__code-label">Código de 6 dígitos</div>
                    <code className="remote-tab__code">{pairing.code}</code>
                  </div>
                  <span className="remote-tab__ttl" data-expired={remainingSeconds <= 0 ? 'true' : 'false'}>
                    {remainingSeconds > 0
                      ? `Expira en ${formatCountdown(remainingSeconds)}`
                      : 'Código expirado · Genera uno nuevo'}
                  </span>
                </div>

                {candidateUrls.length > 0 && (
                  <div className="remote-tab__urls">
                    <h4 className="remote-tab__urls-title">Direcciones LAN / Tailscale detectadas</h4>
                    {candidateUrls.map((url) => (
                      <div key={url} className="remote-tab__url-row">
                        <code className="remote-tab__url">{url}</code>
                        <button
                          type="button"
                          className="secondary-button remote-tab__copy-btn"
                          onClick={() => void handleCopyValue(url)}
                        >
                          {copiedTarget === url ? 'Copiado' : 'Copiar'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {pairing.secret && (
                  <div className="remote-tab__urls">
                    <h4 className="remote-tab__urls-title">Secret (conexión manual)</h4>
                    <div className="remote-tab__url-row">
                      <code className="remote-tab__url">{pairing.secret}</code>
                      <button
                        type="button"
                        className="secondary-button remote-tab__copy-btn"
                        onClick={() => void handleCopyValue(pairing.secret)}
                      >
                        {copiedTarget === pairing.secret ? 'Copiado' : 'Copiar'}
                      </button>
                    </div>
                  </div>
                )}

                <div className="remote-tab__urls">
                  <h4 className="remote-tab__urls-title">Emulador Android (adb reverse)</h4>
                  <div className="remote-tab__url-row">
                    <code className="remote-tab__url">{emuPairCommand}</code>
                    <button
                      type="button"
                      className="secondary-button remote-tab__copy-btn"
                      onClick={() => void handleCopyValue(emuPairCommand)}
                    >
                      {copiedTarget === emuPairCommand ? 'Copiado' : 'Copiar'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="settings-group" aria-labelledby="remote-devices-heading">
        <div className="remote-tab__group-head">
          <h2 id="remote-devices-heading" className="settings-group__title">
            Dispositivos emparejados ({devices.length})
          </h2>
          <button
            type="button"
            className="secondary-button remote-tab__copy-btn"
            disabled={loading}
            onClick={() => void loadSnapshot()}
          >
            Actualizar
          </button>
        </div>
        <div className="ui-card">
          {devices.length === 0 ? (
            <div className="ui-card__row settings-row">
              <div className="settings-row__copy">
                <h3 className="settings-row__title">No hay dispositivos emparejados</h3>
                <p>Cuando vincules un teléfono Android aparecerá aquí para poder administrarlo o revocar su acceso.</p>
              </div>
            </div>
          ) : (
            devices.map((device) => (
              <div key={device.id} className="ui-card__row settings-row">
                <div className="settings-row__copy">
                  <h3 className="settings-row__title remote-tab__device-title">
                    <span>{device.name}</span>
                    <span className="settings-badge" data-tone="accent">
                      {formatPlatformLabel(device.platform)}
                    </span>
                    {device.connected && (
                      <span className="settings-badge" data-tone="running">Conectado</span>
                    )}
                  </h3>
                  <p>Última actividad: {formatLastSeen(device.lastSeenUnixMs)}</p>
                </div>
                <div className="settings-row__control">
                  <button
                    type="button"
                    className="danger-button remote-tab__btn"
                    disabled={revokingId === device.id}
                    aria-label={`Revocar ${device.name}`}
                    onClick={() => void handleRevokeDevice(device.id)}
                  >
                    {revokingId === device.id ? 'Revocando…' : 'Revocar'}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="settings-group" aria-labelledby="remote-mobile-update-heading">
        <div className="remote-tab__group-head">
          <h2 id="remote-mobile-update-heading" className="settings-group__title">
            Actualizaciones móviles (LAN)
          </h2>
          <button
            type="button"
            className="secondary-button remote-tab__copy-btn"
            disabled={loading}
            onClick={() => void loadSnapshot()}
          >
            Actualizar
          </button>
        </div>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">
                <span>APK publicado</span>
                <span
                  className="settings-badge"
                  data-tone={mobileUpdateAvailable ? 'running' : 'neutral'}
                >
                  {mobileUpdateAvailable ? 'Publicado' : 'Sin APK'}
                </span>
              </h3>
              {mobileUpdateAvailable && mobileUpdate ? (
                <>
                  {mobileMetaParts.length > 0 && <p>{mobileMetaParts.join(' · ')}</p>}
                  {mobileShaPreview && (
                    <p>
                      SHA-256:{' '}
                      <code title={mobileUpdate.sha256 ?? undefined}>{mobileShaPreview}</code>
                    </p>
                  )}
                  {mobileReleaseNotes && <p>{mobileReleaseNotes}</p>}
                </>
              ) : (
                <p>
                  Sin APK publicado. Al colocar una compilación en la carpeta del feed local (
                  <code>npm run release:local</code> desde el proyecto móvil), se notifica
                  automáticamente a los dispositivos Android conectados en la LAN.
                </p>
              )}
            </div>
          </div>

          {((mobileUpdateAvailable && mobileDownloadPath) || mobileFeedDir) && (
            <div className="remote-tab__status-urls">
              {mobileUpdateAvailable && mobileDownloadPath && (
                <div className="remote-tab__urls">
                  <h4 className="remote-tab__urls-title">Endpoint de descarga</h4>
                  <div className="remote-tab__url-row">
                    <code className="remote-tab__url">{mobileDownloadPath}</code>
                    <button
                      type="button"
                      className="secondary-button remote-tab__copy-btn"
                      onClick={() => void handleCopyValue(mobileDownloadPath)}
                    >
                      {copiedTarget === mobileDownloadPath ? 'Copiado' : 'Copiar'}
                    </button>
                  </div>
                </div>
              )}

              {mobileFeedDir && (
                <div className="remote-tab__urls">
                  <h4 className="remote-tab__urls-title">Carpeta del feed local</h4>
                  <div className="remote-tab__url-row">
                    <code className="remote-tab__url" title={mobileFeedDir}>
                      {mobileFeedDir}
                    </code>
                    <button
                      type="button"
                      className="secondary-button remote-tab__copy-btn"
                      onClick={() => void handleCopyValue(mobileFeedDir)}
                    >
                      {copiedTarget === mobileFeedDir ? 'Copiado' : 'Copiar'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </>
  );
};
