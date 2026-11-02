import { openExternalLink } from '../terminalLinkNav';
import {
  saveProviderCredential,
  deleteProviderCredential,
  getProviderCredentials,
  type CredentialStatusItem,
} from '../ipc';
import { PROVIDERS } from './types';

export interface ProviderConnectionMethodMeta {
  providerId: string;
  name: string;
  vendor: string;
  cliCommand?: string;
  cliInstallCommand?: string;
  cliDocUrl?: string;
  apiKeyProviderKey: string;
  apiKeyPlaceholder: string;
  apiKeyHelp: string;
  envVars: string[];
  portalUrl: string;
  portalLabel: string;
  supportsCli: boolean;
  supportsApiKey: boolean;
}

export const PROVIDER_CONNECTION_METHODS: Record<string, ProviderConnectionMethodMeta> = {
  [PROVIDERS.ANTIGRAVITY]: {
    providerId: PROVIDERS.ANTIGRAVITY,
    name: 'Antigravity',
    vendor: 'Google',
    cliCommand: 'agy auth login',
    cliInstallCommand: 'irm https://antigravity.google/cli/install.ps1 | iex',
    cliDocUrl: 'https://antigravity.google/docs/cli',
    apiKeyProviderKey: 'gemini',
    apiKeyPlaceholder: 'AIzaSy...',
    apiKeyHelp: 'Clave de Google Gemini API o Google AI Studio para acceder a modelos Gemini Pro/Flash.',
    envVars: ['GEMINI_API_KEY'],
    portalUrl: 'https://aistudio.google.com/app/apikey',
    portalLabel: 'Google AI Studio',
    supportsCli: true,
    supportsApiKey: true,
  },
  [PROVIDERS.CLAUDE]: {
    providerId: PROVIDERS.CLAUDE,
    name: 'Claude Code',
    vendor: 'Anthropic',
    cliCommand: 'claude login',
    cliInstallCommand: 'irm https://claude.ai/install.ps1 | iex',
    cliDocUrl: 'https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview',
    apiKeyProviderKey: 'claude',
    apiKeyPlaceholder: 'sk-ant-api03-...',
    apiKeyHelp: 'Clave de Anthropic API o token de Claude Code.',
    envVars: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_TOKEN', 'ANTHROPIC_OAUTH_TOKEN'],
    portalUrl: 'https://console.anthropic.com/settings/keys',
    portalLabel: 'Anthropic Console',
    supportsCli: true,
    supportsApiKey: true,
  },
  [PROVIDERS.CODEX]: {
    providerId: PROVIDERS.CODEX,
    name: 'Codex',
    vendor: 'OpenAI',
    cliCommand: 'codex login',
    cliInstallCommand: 'irm https://chatgpt.com/codex/install.ps1 | iex',
    cliDocUrl: 'https://platform.openai.com/docs/guides/codex',
    apiKeyProviderKey: 'codex',
    apiKeyPlaceholder: 'sk-proj-...',
    apiKeyHelp: 'Clave de OpenAI API o token de sesión de ChatGPT Codex.',
    envVars: ['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN'],
    portalUrl: 'https://platform.openai.com/api-keys',
    portalLabel: 'OpenAI Platform',
    supportsCli: true,
    supportsApiKey: true,
  },
  [PROVIDERS.GROK]: {
    providerId: PROVIDERS.GROK,
    name: 'Grok Build',
    vendor: 'xAI',
    cliCommand: 'grok login',
    cliInstallCommand: 'irm https://x.ai/cli/install.ps1 | iex',
    cliDocUrl: 'https://x.ai/api',
    apiKeyProviderKey: 'grok',
    apiKeyPlaceholder: 'xai-...',
    apiKeyHelp: 'Clave de API de xAI Grok (o SuperGrok CLI).',
    envVars: ['XAI_API_KEY', 'GROK_API_KEY'],
    portalUrl: 'https://console.x.ai/',
    portalLabel: 'xAI Console',
    supportsCli: true,
    supportsApiKey: true,
  },
  [PROVIDERS.OPENCODE]: {
    providerId: PROVIDERS.OPENCODE,
    name: 'OpenCode',
    vendor: 'OpenCode',
    cliCommand: 'opencode auth login opencode-go',
    cliInstallCommand: 'npm install -g opencode-ai',
    cliDocUrl: 'https://opencode.ai/docs',
    apiKeyProviderKey: 'opencode',
    apiKeyPlaceholder: 'opencode_go_...',
    apiKeyHelp: 'API Key de OpenCode Go para monitoreo oficial de cuotas.',
    envVars: ['OPENCODE_API_KEY'],
    portalUrl: 'https://opencode.ai/auth',
    portalLabel: 'OpenCode Platform',
    supportsCli: true,
    supportsApiKey: true,
  },
  [PROVIDERS.CURSOR]: {
    providerId: PROVIDERS.CURSOR,
    name: 'Cursor',
    vendor: 'Cursor',
    cliCommand: 'cursor-agent login',
    cliInstallCommand: 'irm https://cursor.com/install?win32=true | iex',
    cliDocUrl: 'https://cursor.com/docs',
    apiKeyProviderKey: 'cursor',
    apiKeyPlaceholder: 'cur_...',
    apiKeyHelp: 'Sesión local de Cursor IDE o credenciales de cursor-agent.',
    envVars: [],
    portalUrl: 'https://cursor.com/settings',
    portalLabel: 'Cursor Dashboard',
    supportsCli: true,
    supportsApiKey: false,
  },
  [PROVIDERS.DEEPSEEK]: {
    providerId: PROVIDERS.DEEPSEEK,
    name: 'DeepSeek',
    vendor: 'DeepSeek',
    apiKeyProviderKey: 'deepseek',
    apiKeyPlaceholder: 'sk-...',
    apiKeyHelp: 'Clave de DeepSeek API para modelos V3 y R1.',
    envVars: ['DEEPSEEK_API_KEY'],
    portalUrl: 'https://platform.deepseek.com/api_keys',
    portalLabel: 'DeepSeek Platform',
    supportsCli: false,
    supportsApiKey: true,
  },
  [PROVIDERS.KIMI]: {
    providerId: PROVIDERS.KIMI,
    name: 'Kimi Code',
    vendor: 'Moonshot AI',
    cliCommand: 'kimi login',
    cliInstallCommand: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex',
    cliDocUrl: 'https://platform.moonshot.cn/docs',
    apiKeyProviderKey: 'kimi',
    apiKeyPlaceholder: 'sk-...',
    apiKeyHelp: 'Clave de Moonshot AI o Kimi Code.',
    envVars: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
    portalUrl: 'https://platform.moonshot.cn/console/api-keys',
    portalLabel: 'Moonshot Open Platform',
    supportsCli: true,
    supportsApiKey: true,
  },
  [PROVIDERS.COPILOT]: {
    providerId: PROVIDERS.COPILOT,
    name: 'GitHub Copilot',
    vendor: 'GitHub',
    cliCommand: 'gh copilot auth',
    cliInstallCommand: 'winget install --id GitHub.Copilot --exact',
    cliDocUrl: 'https://docs.github.com/copilot',
    apiKeyProviderKey: 'copilot',
    apiKeyPlaceholder: 'ghp_...',
    apiKeyHelp: 'Autenticación mediante GitHub CLI (gh copilot auth) o token de acceso personal.',
    envVars: ['GITHUB_TOKEN', 'GH_TOKEN'],
    portalUrl: 'https://github.com/settings/copilot',
    portalLabel: 'GitHub Copilot',
    supportsCli: true,
    supportsApiKey: false,
  },
  [PROVIDERS.DROID]: {
    providerId: PROVIDERS.DROID,
    name: 'Factory Droid',
    vendor: 'Factory',
    cliCommand: 'factory login',
    cliInstallCommand: 'irm https://app.factory.ai/cli/windows | iex',
    cliDocUrl: 'https://docs.factory.ai',
    apiKeyProviderKey: 'droid',
    apiKeyPlaceholder: 'fac_...',
    apiKeyHelp: 'Credenciales del entorno de Factory Droid en ~/.factory.',
    envVars: [],
    portalUrl: 'https://app.factory.ai',
    portalLabel: 'Factory Droid',
    supportsCli: true,
    supportsApiKey: false,
  },
  [PROVIDERS.QODER]: {
    providerId: PROVIDERS.QODER,
    name: 'Qoder',
    vendor: 'Qoder',
    cliCommand: 'qodercli',
    cliDocUrl: 'https://qoder.ai/docs',
    apiKeyProviderKey: 'qoder',
    apiKeyPlaceholder: 'qod_...',
    apiKeyHelp: 'Registros locales de ejecución de Qoder CLI.',
    envVars: [],
    portalUrl: 'https://qoder.ai',
    portalLabel: 'Qoder Platform',
    supportsCli: true,
    supportsApiKey: false,
  },
};

export function getProviderConnectionMeta(providerId: string): ProviderConnectionMethodMeta | null {
  return PROVIDER_CONNECTION_METHODS[providerId] ?? null;
}

export function openProviderPortal(providerId: string): boolean {
  const meta = getProviderConnectionMeta(providerId);
  if (!meta?.portalUrl) return false;
  openExternalLink(meta.portalUrl);
  return true;
}

export function spawnProviderLoginTerminal(providerId: string): boolean {
  if (typeof window === 'undefined') return false;
  const meta = getProviderConnectionMeta(providerId);
  if (!meta?.cliCommand) return false;

  void navigator.clipboard?.writeText(meta.cliCommand).catch(() => {});
  window.dispatchEvent(new CustomEvent('kite:navigate-mode', { detail: 'code' }));
  return true;
}

export async function saveVaultApiKey(providerId: string, apiKey: string): Promise<boolean> {
  const meta = getProviderConnectionMeta(providerId);
  const targetKey = meta?.apiKeyProviderKey ?? providerId;
  const res = await saveProviderCredential(targetKey, apiKey.trim());
  return res.success;
}

export async function removeVaultApiKey(providerId: string): Promise<boolean> {
  const meta = getProviderConnectionMeta(providerId);
  const targetKey = meta?.apiKeyProviderKey ?? providerId;
  const res = await deleteProviderCredential(targetKey);
  return res.success;
}

export async function fetchVaultCredentials(): Promise<Record<string, CredentialStatusItem>> {
  const res = await getProviderCredentials();
  const map: Record<string, CredentialStatusItem> = {};
  if (res.success && res.credentials) {
    for (const item of res.credentials) {
      map[item.provider] = item;
    }
  }
  return map;
}
