import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  MobileUpdateStatus,
  RemoteGatewayStatus,
  RemotePairedDevice,
  RemotePairingSession,
  RemoteTailscaleStatus,
} from '../../../lib/ipc/remote';

const {
  mockGetStatus,
  mockConfigure,
  mockCreatePairing,
  mockListDevices,
  mockRevokeDevice,
  mockGetTailscaleStatus,
  mockConfigureTailscale,
} = vi.hoisted(() => ({
  mockGetStatus: vi.fn(),
  mockConfigure: vi.fn(),
  mockCreatePairing: vi.fn(),
  mockListDevices: vi.fn(),
  mockRevokeDevice: vi.fn(),
  mockGetTailscaleStatus: vi.fn(),
  mockConfigureTailscale: vi.fn(),
}));

vi.mock('../../../lib/ipc/remote', () => ({
  getRemoteGatewayStatus: mockGetStatus,
  configureRemoteGateway: mockConfigure,
  createRemotePairing: mockCreatePairing,
  listRemoteDevices: mockListDevices,
  revokeRemoteDevice: mockRevokeDevice,
  getRemoteTailscaleStatus: mockGetTailscaleStatus,
  configureRemoteTailscale: mockConfigureTailscale,
}));

import { RemoteTab } from './RemoteTab';

const BASE_STATUS: RemoteGatewayStatus = {
  enabled: false,
  running: false,
  port: 17420,
  bindMode: 'lan',
  autoStart: false,
  hostName: 'WORKSTATION',
  connectedClients: 0,
};

const INITIAL_DEVICES: RemotePairedDevice[] = [
  {
    id: 'dev-1',
    name: 'Pixel 9 Pro',
    platform: 'android',
    createdAtUnixMs: 1_760_000_000_000,
    lastSeenUnixMs: 1_760_001_000_000,
    connected: true,
  },
];

describe('RemoteTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStatus.mockResolvedValue({ ...BASE_STATUS });
    mockListDevices.mockResolvedValue([...INITIAL_DEVICES]);
    mockConfigure.mockImplementation(async (opts) => ({
      ...BASE_STATUS,
      ...opts,
      running: opts.enabled ?? BASE_STATUS.enabled,
    }));
    mockRevokeDevice.mockImplementation(async (deviceId: string) =>
      INITIAL_DEVICES.filter((d) => d.id !== deviceId)
    );
    mockGetTailscaleStatus.mockResolvedValue({
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
    } satisfies RemoteTailscaleStatus);
    mockConfigureTailscale.mockImplementation(async (mode) => ({
      ...BASE_STATUS,
      tailscaleMode: mode,
    }));
  });

  it('renders gateway status, paired devices, and enables gateway on toggle', async () => {
    const user = userEvent.setup();
    render(<RemoteTab />);

    expect(await screen.findByText('Detenido')).toBeInTheDocument();
    expect(screen.getByText(/Puerto configurado 17420/i)).toBeInTheDocument();
    expect(screen.getByText('Pixel 9 Pro')).toBeInTheDocument();
    expect(screen.getByText('Android')).toBeInTheDocument();

    const toggle = screen.getByRole('switch', { name: 'Habilitar gateway remoto' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await user.click(toggle);

    await waitFor(() => {
      expect(mockConfigure).toHaveBeenCalledWith({ enabled: true });
    });
    expect(await screen.findByText('Activo')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('updates bind mode and port and validates invalid port input', async () => {
    const user = userEvent.setup();
    mockGetStatus.mockResolvedValue({
      ...BASE_STATUS,
      enabled: true,
      running: true,
      connectedClients: 2,
    });
    render(<RemoteTab />);

    expect(await screen.findByText(/2 clientes conectados/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Solo local' }));
    const portField = screen.getByLabelText('Puerto TCP');
    fireEvent.change(portField, { target: { value: '18420' } });

    await user.click(screen.getByRole('button', { name: 'Guardar configuración' }));

    await waitFor(() => {
      expect(mockConfigure).toHaveBeenCalledWith({
        port: 18420,
        bindMode: 'loopback',
        autoStart: false,
      });
    });
    expect(await screen.findByText('Guardado')).toBeInTheDocument();

    // Invalid port shows inline alert and does not call IPC
    fireEvent.change(portField, { target: { value: '80' } });
    await user.click(screen.getByRole('button', { name: 'Guardar configuración' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/1024 y 65535/i);
    expect(mockConfigure).toHaveBeenCalledTimes(1);
  });

  it('generates QR pairing SVG, 6-digit code, countdown, and candidate URLs', async () => {
    const user = userEvent.setup();
    const pairingSession: RemotePairingSession = {
      uri: 'kite-remote://pair?v=1&host=192.168.1.42&port=17420&hosts=192.168.1.42,100.64.0.9&code=482910&secret=0123456789abcdef0123456789abcdef&name=WORKSTATION',
      code: '482910',
      secret: '0123456789abcdef0123456789abcdef',
      hostName: 'WORKSTATION',
      primaryHost: '192.168.1.42',
      hosts: ['192.168.1.42', '100.64.0.9'],
      port: 17420,
      candidateUrls: ['http://192.168.1.42:17420', 'http://100.64.0.9:17420'],
      expiresAtUnixMs: Date.now() + 295_000,
    };
    mockCreatePairing.mockResolvedValue(pairingSession);

    render(<RemoteTab />);
    await screen.findByText('Detenido');

    await user.click(screen.getByRole('button', { name: 'Generar código QR' }));

    await waitFor(() => {
      expect(mockConfigure).toHaveBeenCalledWith({ enabled: true });
    });
    expect(await screen.findByText('482910')).toBeInTheDocument();
    const qrSvg = screen.getByRole('img', { name: /Código QR de emparejamiento/i });
    const pathEl = qrSvg.querySelector('path');
    expect(pathEl).not.toBeNull();
    expect(pathEl?.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);

    expect(screen.getByText(/Expira en 04:\d\d/)).toBeInTheDocument();
    expect(screen.getAllByText('http://192.168.1.42:17420').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('http://100.64.0.9:17420').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('0123456789abcdef0123456789abcdef')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copiar enlace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nuevo código' })).toBeInTheDocument();

    const copyWriteSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: copyWriteSpy },
    });
    await user.click(screen.getByRole('button', { name: 'Copiar enlace' }));
    expect(copyWriteSpy).toHaveBeenCalledWith(pairingSession.uri);
    expect(await screen.findByRole('button', { name: 'Enlace copiado' })).toBeInTheDocument();

    // Toggling off the gateway clears the active QR panel
    await user.click(screen.getByRole('switch', { name: 'Habilitar gateway remoto' }));
    await waitFor(() => {
      expect(screen.queryByRole('img', { name: /Código QR de emparejamiento/i })).not.toBeInTheDocument();
    });
  });

  it('revokes a paired device and updates the list', async () => {
    const user = userEvent.setup();
    render(<RemoteTab />);

    expect(await screen.findByText('Pixel 9 Pro')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Revocar Pixel 9 Pro' }));

    await waitFor(() => {
      expect(mockRevokeDevice).toHaveBeenCalledWith('dev-1');
    });
    await waitFor(() => {
      expect(screen.queryByText('Pixel 9 Pro')).not.toBeInTheDocument();
    });
    expect(screen.getByText('No hay dispositivos emparejados')).toBeInTheDocument();
  });

  it('displays visible inline error alert when IPC rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const user = userEvent.setup();
    mockGetStatus.mockRejectedValueOnce(new Error('Puerto 17420 ocupado por otro proceso'));

    render(<RemoteTab />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Puerto 17420 ocupado por otro proceso');

    await user.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    mockCreatePairing.mockRejectedValueOnce(new Error('El gateway remoto está deshabilitado'));
    await user.click(screen.getByRole('button', { name: 'Generar código QR' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'El gateway remoto está deshabilitado'
    );

    warnSpy.mockRestore();
  });

  it('displays published mobile APK metadata and refreshes snapshot on update click', async () => {
    const user = userEvent.setup();
    const publishedUpdate: MobileUpdateStatus = {
      available: true,
      feedDir: 'C:\\Users\\PC\\.kite\\mobile-updates',
      versionName: '1.4.2',
      versionCode: 42,
      filename: 'kite-mobile-v1.4.2.apk',
      sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789fedcba9',
      sizeBytes: 19_293_798,
      releaseNotes: 'Mejoras de reconexión LAN y sincronización de voz.',
      publishedAtUnixMs: 1_760_002_000_000,
      downloadPath: '/mobile/app/latest.apk',
    };
    mockGetStatus.mockResolvedValue({
      ...BASE_STATUS,
      enabled: true,
      running: true,
      mobileUpdate: publishedUpdate,
    });

    render(<RemoteTab />);

    const updateSection = await screen.findByRole('region', {
      name: 'Actualizaciones móviles (LAN)',
    });
    const scoped = within(updateSection);

    const badge = await scoped.findByText('Publicado');
    expect(badge).toHaveAttribute('data-tone', 'running');
    expect(scoped.getByText(/v1\.4\.2 \(build 42\)/)).toBeInTheDocument();
    expect(scoped.getByText(/kite-mobile-v1\.4\.2\.apk/)).toBeInTheDocument();
    expect(scoped.getByText(/18\.4 MB/)).toBeInTheDocument();
    expect(scoped.getByText('a1b2c3d4e5f6…edcba9')).toBeInTheDocument();
    expect(
      scoped.getByText('Mejoras de reconexión LAN y sincronización de voz.')
    ).toBeInTheDocument();
    expect(scoped.getByText('/mobile/app/latest.apk')).toBeInTheDocument();
    expect(scoped.getByText('C:\\Users\\PC\\.kite\\mobile-updates')).toBeInTheDocument();

    const copyWriteSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: copyWriteSpy },
    });
    const endpointRow = scoped.getByText('/mobile/app/latest.apk').closest('.remote-tab__url-row');
    expect(endpointRow).not.toBeNull();
    await user.click(within(endpointRow as HTMLElement).getByRole('button', { name: 'Copiar' }));
    expect(copyWriteSpy).toHaveBeenCalledWith('/mobile/app/latest.apk');

    const callsBeforeRefresh = mockGetStatus.mock.calls.length;
    await user.click(scoped.getByRole('button', { name: 'Actualizar' }));
    await waitFor(() => {
      expect(mockGetStatus.mock.calls.length).toBeGreaterThan(callsBeforeRefresh);
    });
  });

  it('displays empty-feed state and feedDir when mobileUpdate.available is false', async () => {
    mockGetStatus.mockResolvedValue({
      ...BASE_STATUS,
      mobileUpdate: {
        available: false,
        feedDir: 'C:\\Users\\PC\\.kite\\mobile-updates',
        versionName: null,
        versionCode: null,
        filename: null,
        sha256: null,
        sizeBytes: null,
        releaseNotes: null,
        publishedAtUnixMs: null,
        downloadPath: '/mobile/app/latest.apk',
      },
    });

    render(<RemoteTab />);

    const updateSection = await screen.findByRole('region', {
      name: 'Actualizaciones móviles (LAN)',
    });
    const scoped = within(updateSection);

    const badge = await scoped.findByText('Sin APK');
    expect(badge).toHaveAttribute('data-tone', 'neutral');
    expect(scoped.getByText(/npm run release:local/)).toBeInTheDocument();
    expect(scoped.getByText('C:\\Users\\PC\\.kite\\mobile-updates')).toBeInTheDocument();
    expect(scoped.queryByText('/mobile/app/latest.apk')).not.toBeInTheDocument();
  });

  it('falls back to Sin APK state cleanly when mobileUpdate is omitted', async () => {
    render(<RemoteTab />);

    const updateSection = await screen.findByRole('region', {
      name: 'Actualizaciones móviles (LAN)',
    });
    const scoped = within(updateSection);

    expect(await scoped.findByText('Sin APK')).toHaveAttribute('data-tone', 'neutral');
    expect(scoped.queryByText('Carpeta del feed local')).not.toBeInTheDocument();
  });

  it('copies feedDir via clipboard and falls back cleanly when clipboard API is unavailable', async () => {
    const user = userEvent.setup();
    const feedDir = 'C:\\Users\\PC\\.kite\\mobile-updates';
    mockGetStatus.mockResolvedValue({
      ...BASE_STATUS,
      mobileUpdate: {
        available: false,
        feedDir,
        versionName: null,
        versionCode: null,
        filename: null,
        sha256: null,
        sizeBytes: null,
        releaseNotes: null,
        publishedAtUnixMs: null,
        downloadPath: '/mobile/app/latest.apk',
      },
    });

    render(<RemoteTab />);

    const updateSection = await screen.findByRole('region', {
      name: 'Actualizaciones móviles (LAN)',
    });
    const feedDirNode = await within(updateSection).findByText(feedDir);
    const feedRow = feedDirNode.closest('.remote-tab__url-row');
    expect(feedRow).not.toBeNull();

    const copyWriteSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: copyWriteSpy },
    });

    const copyBtn = within(feedRow as HTMLElement).getByRole('button', { name: 'Copiar' });
    await user.click(copyBtn);

    expect(copyWriteSpy).toHaveBeenCalledWith(feedDir);
    expect(
      await within(feedRow as HTMLElement).findByRole('button', { name: 'Copiado' })
    ).toBeInTheDocument();

    // Also verify clean fallback when navigator.clipboard is unavailable
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    fireEvent.click(within(feedRow as HTMLElement).getByRole('button', { name: 'Copiado' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      within(feedRow as HTMLElement).getByRole('button', { name: 'Copiado' })
    ).toBeInTheDocument();
  });

  it('shows Tailscale install guidance when CLI is missing and refreshes on Verificar', async () => {
    const user = userEvent.setup();
    render(<RemoteTab />);

    const tsSection = await screen.findByRole('region', {
      name: 'Acceso externo (Tailscale)',
    });
    const scoped = within(tsSection);
    expect(scoped.getByText('No instalado')).toHaveAttribute('data-tone', 'warning');
    expect(scoped.getByText('winget install Tailscale.Tailscale')).toBeInTheDocument();

    mockGetTailscaleStatus.mockResolvedValueOnce({
      installed: true,
      cliPath: 'C:\\Program Files\\Tailscale\\tailscale.exe',
      backendState: 'NeedsLogin',
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
    });

    await user.click(scoped.getByRole('button', { name: 'Verificar' }));
    await waitFor(() => {
      expect(mockGetTailscaleStatus).toHaveBeenCalledWith(true);
    });
    expect(await scoped.findByText('Sesión pendiente')).toBeInTheDocument();
  });

  it('switches Tailscale mode to Funnel, renders approvalUrl, and saves/clears publicUrl', async () => {
    const user = userEvent.setup();
    const runningTs: RemoteTailscaleStatus = {
      installed: true,
      cliPath: 'C:\\Program Files\\Tailscale\\tailscale.exe',
      backendState: 'Running',
      running: true,
      ipv4: '100.88.14.9',
      dnsName: 'desktop-kite.tail1234.ts.net',
      magicDnsSuffix: 'tail1234.ts.net',
      funnelCapable: true,
      configuredMode: 'off',
      activeMode: 'off',
      httpsUrl: null,
      directIpUrl: 'http://100.88.14.9:17420',
      approvalUrl: 'https://login.tailscale.com/f/funnel?node=n12345',
      lastError: null,
    };
    mockGetStatus.mockResolvedValue({
      ...BASE_STATUS,
      enabled: true,
      running: true,
      publicUrl: 'https://existing.tail1234.ts.net',
      tailscaleMode: 'off',
      tailscale: runningTs,
    });
    mockConfigureTailscale.mockResolvedValueOnce({
      ...BASE_STATUS,
      enabled: true,
      running: true,
      tailscaleMode: 'funnel',
      tailscale: {
        ...runningTs,
        configuredMode: 'funnel',
        activeMode: 'funnel',
        httpsUrl: 'https://desktop-kite.tail1234.ts.net',
        approvalUrl: null,
      },
    });

    render(<RemoteTab />);
    const tsSection = await screen.findByRole('region', {
      name: 'Acceso externo (Tailscale)',
    });
    const scoped = within(tsSection);

    expect(await scoped.findByText('VPN privada')).toBeInTheDocument();
    expect(scoped.getByText(/100\.88\.14\.9/)).toBeInTheDocument();
    expect(scoped.getByText(/desktop-kite\.tail1234\.ts\.net/)).toBeInTheDocument();
    expect(
      scoped.getByText('https://login.tailscale.com/f/funnel?node=n12345')
    ).toBeInTheDocument();

    await user.click(scoped.getByRole('button', { name: 'Funnel (HTTPS público)' }));
    await waitFor(() => {
      expect(mockConfigureTailscale).toHaveBeenCalledWith('funnel');
    });
    expect(await scoped.findByText('Funnel público')).toBeInTheDocument();
    expect(
      scoped.getByText('https://desktop-kite.tail1234.ts.net')
    ).toBeInTheDocument();

    const publicUrlField = scoped.getByLabelText('URL fija externa (opcional)');
    expect(publicUrlField).toHaveValue('https://existing.tail1234.ts.net');
    fireEvent.change(publicUrlField, {
      target: { value: 'https://custom-kite.tail1234.ts.net' },
    });
    await user.click(scoped.getByRole('button', { name: 'Guardar URL' }));
    await waitFor(() => {
      expect(mockConfigure).toHaveBeenCalledWith({
        publicUrl: 'https://custom-kite.tail1234.ts.net',
      });
    });

    fireEvent.change(publicUrlField, { target: { value: '' } });
    await user.click(scoped.getByRole('button', { name: 'Guardar URL' }));
    await waitFor(() => {
      expect(mockConfigure).toHaveBeenCalledWith({ publicUrl: '' });
    });
  });
});
