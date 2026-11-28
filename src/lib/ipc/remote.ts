import { invokeFlatCommand } from './core';
import type { ActionReceipt } from '../operator/contract';
import type { DraftTaskProposal } from '../operator/voice/voiceSessionStore';

export type RemoteBindMode = 'lan' | 'loopback';

export type RemoteTailscaleMode = 'off' | 'serve' | 'funnel';

export type RemoteDevicePlatform = 'android' | 'ios' | 'web';

export interface RemoteTailscaleStatus {
  installed: boolean;
  cliPath?: string | null;
  backendState: string;
  running: boolean;
  ipv4?: string | null;
  dnsName?: string | null;
  magicDnsSuffix?: string | null;
  funnelCapable: boolean;
  configuredMode: RemoteTailscaleMode;
  activeMode: RemoteTailscaleMode;
  httpsUrl?: string | null;
  directIpUrl?: string | null;
  approvalUrl?: string | null;
  lastError?: string | null;
}

export interface RemotePairedDevice {
  id: string;
  name: string;
  platform: RemoteDevicePlatform | string;
  createdAtUnixMs: number;
  lastSeenUnixMs: number;
  connected?: boolean;
}

export interface MobileUpdateStatus {
  available: boolean;
  feedDir: string;
  versionName: string | null;
  versionCode: number | null;
  filename: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  releaseNotes: string | null;
  publishedAtUnixMs: number | null;
  downloadPath: string;
}

export interface RemoteGatewayStatus {
  enabled: boolean;
  running?: boolean;
  port: number;
  bindMode: RemoteBindMode;
  autoStart: boolean;
  publicUrl?: string | null;
  tailscaleMode?: RemoteTailscaleMode;
  protocol?: string;
  hostName?: string;
  primaryHost?: string;
  candidateHosts?: string[];
  candidateUrls?: string[];
  connectedClients: number;
  deviceCount?: number;
  pairingActive?: boolean;
  lastError?: string | null;
  mobileUpdate?: MobileUpdateStatus;
  tailscale?: RemoteTailscaleStatus;
}

export interface ConfigureRemoteGatewayOptions {
  enabled?: boolean;
  port?: number;
  bindMode?: RemoteBindMode;
  autoStart?: boolean;
  publicUrl?: string;
  tailscaleMode?: RemoteTailscaleMode;
}

export interface RemotePairingSession {
  uri: string;
  code: string;
  secret: string;
  hostName: string;
  primaryHost: string;
  hosts: string[];
  port: number;
  candidateUrls?: string[];
  expiresAtUnixMs: number;
  ttlSecs?: number;
}

export interface RemoteArgosTurnReplySuccess {
  ok: true;
  turnId: string;
  transcript: string;
  reply: string;
  receipts: ActionReceipt[];
  proposal: DraftTaskProposal | null;
  strategy: string;
  durationMs: number;
  overallSuccess?: boolean;
  providerId?: string;
  model?: string;
}

export interface RemoteArgosTurnReplyError {
  ok: false;
  error: string;
  turnId?: string;
  transcript?: string;
  reply?: string;
  receipts?: ActionReceipt[];
  proposal?: null;
  strategy?: string;
  durationMs?: number;
}

export type RemoteArgosTurnReplyPayload =
  | RemoteArgosTurnReplySuccess
  | RemoteArgosTurnReplyError;

/**
 * Fetches the current configuration and live runtime state of the remote gateway.
 */
export async function getRemoteGatewayStatus(): Promise<RemoteGatewayStatus> {
  return invokeFlatCommand<RemoteGatewayStatus>('remote_gateway_status');
}

/**
 * Updates and persists remote gateway settings (enabled state, port, bind mode, auto-start).
 */
export async function configureRemoteGateway(
  opts: ConfigureRemoteGatewayOptions
): Promise<RemoteGatewayStatus> {
  return invokeFlatCommand<RemoteGatewayStatus>('remote_gateway_configure', {
    enabled: opts.enabled,
    port: opts.port,
    bindMode: opts.bindMode,
    autoStart: opts.autoStart,
    publicUrl: opts.publicUrl,
    tailscaleMode: opts.tailscaleMode,
  });
}

/**
 * Probes Tailscale CLI availability, node IP/MagicDNS identity, and Serve/Funnel state.
 */
export async function getRemoteTailscaleStatus(
  refresh = false
): Promise<RemoteTailscaleStatus> {
  return invokeFlatCommand<RemoteTailscaleStatus>('remote_gateway_tailscale_status', {
    refresh,
  });
}

/**
 * Configures and applies the requested Tailscale access mode ('off' | 'serve' | 'funnel').
 */
export async function configureRemoteTailscale(
  mode: RemoteTailscaleMode
): Promise<RemoteGatewayStatus> {
  return invokeFlatCommand<RemoteGatewayStatus>('remote_gateway_configure_tailscale', {
    mode,
  });
}

/**
 * Creates a short-lived single-use pairing session with QR URI, 6-digit code, and candidate URLs.
 */
export async function createRemotePairing(): Promise<RemotePairingSession> {
  return invokeFlatCommand<RemotePairingSession>('remote_gateway_create_pairing');
}

/**
 * Lists all paired remote devices authorized to access this desktop gateway.
 */
export async function listRemoteDevices(): Promise<RemotePairedDevice[]> {
  return invokeFlatCommand<RemotePairedDevice[]>('remote_gateway_list_devices');
}

/**
 * Revokes a paired device and disconnects any active WebSocket sessions for that device.
 */
export async function revokeRemoteDevice(deviceId: string): Promise<RemotePairedDevice[]> {
  const trimmed = deviceId.trim();
  if (!trimmed) {
    throw new Error('[IPC] revokeRemoteDevice requires a non-empty deviceId.');
  }
  return invokeFlatCommand<RemotePairedDevice[]>('remote_gateway_revoke_device', {
    deviceId: trimmed,
  });
}

/**
 * Sends the Argos voice-mode turn outcome back to the pending remote RPC request.
 */
export async function replyRemoteArgosTurn(
  requestId: string,
  payload: RemoteArgosTurnReplyPayload
): Promise<void> {
  const trimmed = requestId.trim();
  if (!trimmed) {
    throw new Error('[IPC] replyRemoteArgosTurn requires a non-empty requestId.');
  }
  return invokeFlatCommand<void>('remote_argos_turn_reply', {
    requestId: trimmed,
    payload,
  });
}
