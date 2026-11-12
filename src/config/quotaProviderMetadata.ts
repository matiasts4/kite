import { PROVIDERS } from '../lib/quota/types';

export interface ProviderMetaConfig {
  title: string;
  desc: string;
  source: string;
  loginCmd?: string;
  connectionType: 'cli_oauth' | 'local_rpc' | 'local_config' | 'api_key' | 'opencode_form';
  details: string;
}

export const PROVIDER_CONFIGS_ES: Record<string, ProviderMetaConfig> = {
  [PROVIDERS.ANTIGRAVITY]: {
    title: 'Google Antigravity Language Server',
    desc: 'Límites de modelos Gemini Pro, Ultra y Claude Sonnet a través del Language Server local.',
    source: 'language_server.exe (Conexión local por RPC Connect)',
    connectionType: 'local_rpc',
    details:
      'Se conecta automáticamente al proceso local `language_server.exe` en tu equipo mediante Connect RPC y token CSRF. No requiere iniciar sesión manualmente ni ingresar claves de API en la aplicación.',
  },
  [PROVIDERS.CURSOR]: {
    title: 'Cursor Agent & IDE',
    desc: 'Cuotas de modelos de Cursor (Auto y API), créditos incluidos y ciclo de facturación.',
    source: 'Cursor IDE (state.vscdb) o ~/.cursor/auth.json',
    loginCmd: 'cursor-agent login',
    connectionType: 'cli_oauth',
    details:
      'Detecta automáticamente la sesión autenticada de Cursor IDE desde su base de datos local o credenciales de CLI. Si no has iniciado sesión o tu token expiró, abre Cursor o ejecuta `cursor-agent login`.',
  },
  [PROVIDERS.GROK]: {
    title: 'xAI Grok CLI & Build',
    desc: 'Monitoreo de suscripción SuperGrok, créditos semanales y consumo de modelos Grok.',
    source: '~/.grok/auth.json',
    loginCmd: 'grok login',
    connectionType: 'cli_oauth',
    details:
      'Detecta las credenciales de sesión en `~/.grok/auth.json`. Nota importante de xAI: Si tu cuenta tiene configurado Privacy Mode como "Legacy (no storage)", xAI no expone el saldo de créditos vía API hasta activar el modo Privacy estándar en la consola de Grok.',
  },
  [PROVIDERS.QODER]: {
    title: 'Qoder CLI',
    desc: 'Créditos del plan y add-ons para Qoder CLI analizados en tiempo real.',
    source: '~/.qoder/logs/runs/*/qodercli.log',
    loginCmd: 'qodercli',
    connectionType: 'local_config',
    details:
      'Lee el uso de créditos y balance reportado por Qoder CLI en los registros locales de ejecución en `~/.qoder`. Ejecuta una sesión con `qodercli` para refrescar los datos de cuota.',
  },
  [PROVIDERS.CLAUDE]: {
    title: 'Claude Code (Anthropic)',
    desc: 'Sesión de 5 horas, límites semanales de Sonnet y cuota mensual de Claude Pro / Team.',
    source: '~/.claude/.credentials.json o ANTHROPIC_OAUTH_TOKEN',
    loginCmd: 'claude login',
    connectionType: 'cli_oauth',
    details:
      'Monitorea el endpoint OAuth oficial de Anthropic. Requiere haber iniciado sesión en Claude Code CLI ejecutando `claude login` o haber definido la variable de entorno ANTHROPIC_OAUTH_TOKEN.',
  },
  [PROVIDERS.CODEX]: {
    title: 'OpenAI Codex',
    desc: 'Rate limits de sesión de 5 horas, tope semanal y revisiones de código de ChatGPT / Codex.',
    source: '~/.codex/config.toml y ~/.codex/auth.json',
    loginCmd: 'codex login',
    connectionType: 'cli_oauth',
    details:
      'Consulta los límites oficiales mediante el backend de ChatGPT. Requiere haber ejecutado `codex login` en tu terminal para almacenar la sesión OAuth en `~/.codex/auth.json`.',
  },
  [PROVIDERS.KIMI]: {
    title: 'Moonshot Kimi Code',
    desc: 'Límite semanal, ventana de 5 horas y saldo de billetera booster de Kimi Code.',
    source: '~/.kimi-code/credentials/kimi-code.json',
    loginCmd: 'kimi login',
    connectionType: 'cli_oauth',
    details:
      'Lee las credenciales OAuth en `~/.kimi-code/credentials/kimi-code.json` y refresca el token automáticamente. Si el token de actualización expira o la sesión caduca, ejecuta `kimi login` en la terminal.',
  },
  [PROVIDERS.COPILOT]: {
    title: 'GitHub Copilot CLI',
    desc: 'Límites de peticiones y cuota de GitHub Copilot.',
    source: '~/.copilot/config.json',
    loginCmd: 'gh copilot auth',
    connectionType: 'cli_oauth',
    details:
      'Detecta la instalación de GitHub Copilot CLI en `~/.copilot` o la autenticación de la CLI de GitHub.',
  },
  [PROVIDERS.DROID]: {
    title: 'Factory Droid',
    desc: 'Créditos y asignaciones de equipo de Factory Droid.',
    source: '~/.factory/',
    connectionType: 'local_config',
    details:
      'Detecta la configuración y credenciales del entorno de Factory Droid en `~/.factory`.',
  },
  [PROVIDERS.DEEPSEEK]: {
    title: 'DeepSeek API',
    desc: 'Uso de tokens y saldo de API para modelos DeepSeek R1 y V3.',
    source: 'Variable de entorno DEEPSEEK_API_KEY',
    connectionType: 'api_key',
    details:
      'Requiere definir la variable de entorno `DEEPSEEK_API_KEY` en tu sistema operativo con una clave de API válida de DeepSeek. Kite consulta el saldo directamente a api.deepseek.com.',
  },
  [PROVIDERS.OPENCODE]: {
    title: 'OpenCode Go',
    desc: 'Ventanas de cuota de 5 horas, semanal y mensual de tu suscripción OpenCode Go.',
    source: 'OpenCode CLI (opencode.db / auth.json), OPENCODE_API_KEY o API key guardada en Kite',
    loginCmd: 'opencode auth login opencode-go',
    connectionType: 'opencode_form',
    details:
      'Kite detecta automáticamente la sesión de OpenCode. Si no la encuentra, ejecutá `opencode auth login opencode-go` o guardá una API key de OpenCode Go. La cookie y el workspace legacy ya no se usan: la API oficial de cuotas requiere una API key.',
  },
};
