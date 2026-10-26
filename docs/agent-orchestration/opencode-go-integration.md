# OpenCode Go en el Asistente Zed

Estado: **Opción A implementada** (HTTP OpenAI-compatible). La Opción C (ACP) queda documentada como trabajo futuro y **no** está implementada.

## Decisión

Zed usa la suscripción OpenCode Go a través del gateway HTTP oficial:

```text
https://opencode.ai/inference/go/openai/v1/chat/completions
```

No se usa `https://opencode.ai/inference/v1` ni `/inference/openai/v1`: esas rutas pertenecen a Console pay-as-you-go y, con una API key de Go, responden `402 Payment Required`.

## Contrato verificado

| Elemento | Valor |
| --- | --- |
| Auth | `Authorization: Bearer oc_sk_...` |
| Sesión | `x-opencode-session: ses_...` obligatorio en **cada** request |
| Catálogo del plan | `GET https://opencode.ai/zen/go/v1/models` |
| Consumo | `GET https://opencode.ai/zen/go/v1/usage` |
| Sin header de sesión | `400` |
| Ruta pay-as-you-go con key Go | `402` |

El header de sesión se usa para routing y prompt caching. Debe ser estable por conversación y sobrevivir reinicios de la app.

### Familias de modelos

El gateway Go expone modelos de varias familias. Zed usa Chat Completions, así que solo son válidos los modelos servidos por esa API:

- **Compatibles con Chat Completions:** DeepSeek V4.1 Flash/Pro, Kimi K3/K2.7, MiniMax M3/M3.1, GLM 5.x, Qwen 3.x, MiMo, Hy3, Step 5.
- **Requieren Responses API:** GPT-6/5.x, Grok 4.7, Muse Spark.
- **Requieren API nativa:** Claude Haiku 5.5 (Anthropic Messages), Gemini 4 Argon (Google).

Por eso `isOpenCodeGoChatCompatibleModel()` excluye los prefijos `gpt-`, `grok-`, `claude-`, `gemini-` y `muse-`. Si en el futuro Zed necesita esos modelos, hay que agregar un cliente Responses/Anthropic/Gemini; no alcanza con cambiar el `model`.

## Implementación

### Credenciales

El token se resuelve en Rust, no en el webview, mediante `resolve_opencode_go_api_key()` en `src-tauri/src/quota/opencode.rs`. Reutiliza las mismas fuentes que el monitor de cuotas:

1. `~/.kite/opencode-go-quota.json` (key guardada desde la UI de cuotas).
2. `OPENCODE_API_KEY` en el entorno.
3. `provider.opencode-go.options.apiKey` en `opencode.json`/`opencode.jsonc`.
4. Tabla `credential` de `opencode.db` (`integration_id = opencode-go`).
5. `auth.json` legacy (`opencode-go`).

Solo se aceptan credenciales de tipo API key. Una sesión OAuth de Console no sirve para Go.

El comando `opencode_go_credential_status` devuelve `{ available, source }` sin exponer el token. La UI lo muestra en la tarjeta de OpenCode Go.

`proxy_operator_http` acepta `credentialProvider: "opencode"`. Si el request no trae `Authorization`:

- resuelve el token en Rust y lo inyecta como `Bearer`;
- si no hay credencial, devuelve `401` con un mensaje accionable;
- si falta `x-opencode-session`, genera uno efímero (la UI siempre manda el estable).

### Sesión

`getOrCreateOpenCodeSessionId()` en `src/lib/operator/operatorConfig.ts` genera `ses_kite_<uuid>` la primera vez y lo persiste en `opencodeSessionId`. `resolvePlannerProvider` y `callOpenAICompatibleEndpoint` lo envían como `x-opencode-session`.

### Catálogo

`fetchOpenCodeGoModels()` consulta `https://opencode.ai/zen/go/v1/models` y filtra las familias incompatibles con Chat Completions. El resultado se cachea con la misma clave que el catálogo de OpenCode (`opencode`). El botón “Actualizar lista” de Zed usa este catálogo, no `${baseUrl}/models` (que en Go devuelve 404).

`resolveVerifiedModel()` ya no pone en cuarentena IDs desconocidos de OpenCode: el catálogo vivo es la fuente de verdad. Antes, elegir `kimi-k3` o `minimax-m3` se reemplazaba silenciosamente por `deepseek-v4.1-flash`.

### Migración

`loadOperatorConfig()` migra automáticamente:

- `https://opencode.ai/inference/v1` → `https://opencode.ai/inference/go/openai/v1`;
- `https://opencode.ai/inference/openai/v1` → la ruta Go;
- `deepseek-v4.1-coder` (ya no existe en el catálogo) → `deepseek-v4.1-flash`.

## Verificación manual

```powershell
opencode auth list
opencode models | Select-String '^opencode-go/'

# 200
curl.exe -s -o NUL -w "%{http_code}" https://opencode.ai/zen/go/v1/usage `
  -H "Authorization: Bearer $env:OPENCODE_API_KEY"

# 200 con header; 400 sin header; 402 en /inference/v1
curl.exe -s -o NUL -w "%{http_code}" `
  -X POST https://opencode.ai/inference/go/openai/v1/chat/completions `
  -H "Authorization: Bearer $env:OPENCODE_API_KEY" `
  -H "Content-Type: application/json" `
  -H "x-opencode-session: ses_kite_manual" `
  -d '{\"model\":\"deepseek-v4.1-flash\",\"messages\":[{\"role\":\"user\",\"content\":\"OK\"}],\"max_tokens\":1}'
```

En la app: Configuración → Asistente Zed → OpenCode Go → **Probar OpenCode Go**. El resultado debe mostrar latencia y `deepseek-v4.1-flash` (o el modelo elegido).

## Futuro: Opción C (ACP)

`opencode acp` expone OpenCode como agente Agent Client Protocol por stdio (JSON-RPC). Ventajas sobre HTTP:

- sesiones nativas, tools y permisos gestionados por OpenCode;
- reutiliza todas las credenciales del CLI sin duplicar la key;
- streaming de deltas y approvals con el modelo de ACP.

Trabajo necesario:

1. Cliente JSON-RPC persistente (hoy `src-tauri/src/acp.rs` es un parser line-based orientado a `antigravity-acp`).
2. Ciclo de vida del proceso por workspace y reconexión.
3. Mapeo de `session/request_permission` al contrato de approvals de Kite.
4. Persistencia de `sessionId` y `cwd` por thread.
5. Fallback a HTTP si ACP no está disponible.

No se implementa en esta iteración. Cuando se retome, el punto de entrada es `opencode acp` con `cwd` absoluto y credenciales ya resueltas por `opencode auth login`.
