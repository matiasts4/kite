use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;
use std::sync::OnceLock;
use std::time::Duration;

pub const OPENCODE_GO_DEFAULT_BASE_URL: &str = "https://opencode.ai/inference/go/openai/v1";
pub const OPENAI_DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
pub const ANTHROPIC_DEFAULT_BASE_URL: &str = "https://api.anthropic.com/v1";
pub const XAI_DEFAULT_BASE_URL: &str = "https://api.x.ai/v1";
pub const GEMINI_DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
pub const DEEPSEEK_DEFAULT_BASE_URL: &str = "https://api.deepseek.com/v1";
pub const KIMI_DEFAULT_BASE_URL: &str = "https://api.moonshot.cn/v1";
pub const VERCEL_DEFAULT_BASE_URL: &str = "https://ai-gateway.vercel.sh/v1";
pub const CLOUDFLARE_DEFAULT_BASE_URL: &str = "https://api.cloudflare.com/client/v4/accounts";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GatewayKind {
    OpenCodeGo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DirectEligibility {
    OfficialApiKey,
    OfficialGateway(GatewayKind),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FastLaneIneligible {
    pub provider: String,
    pub reason: String,
}

impl fmt::Display for FastLaneIneligible {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Fast Lane ineligible for '{}': {}",
            self.provider, self.reason
        )
    }
}

impl std::error::Error for FastLaneIneligible {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FastLaneEndpoint {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    pub eligibility: DirectEligibility,
    pub session_header: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeMessage {
    pub role: NativeRole,
    pub content: String,
    pub tool_call_id: Option<String>,
    pub tool_calls: Vec<NativeToolCall>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeToolDef {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeStreamChunk {
    TextDelta(String),
    ReasoningDelta(String),
    ToolCallStart { id: String, name: String },
    ToolCallDelta { id: String, arguments_delta: String },
    Usage(NativeUsage),
    Done,
    RateLimited {
        retry_after_ms: Option<u64>,
        message: String,
    },
    Error(String),
}

#[derive(Debug, Clone)]
pub struct NativeTurnRequest {
    pub endpoint: FastLaneEndpoint,
    pub system_prompt: Option<String>,
    pub messages: Vec<NativeMessage>,
    pub tools: Vec<NativeToolDef>,
    pub max_tokens: Option<u32>,
}

/// Shared connection-pooled reqwest client for all Fast Lane HTTPS/SSE turns.
pub fn shared_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .pool_max_idle_per_host(16)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn ineligible(provider: &str, reason: impl Into<String>) -> FastLaneIneligible {
    FastLaneIneligible {
        provider: provider.trim().to_string(),
        reason: reason.into(),
    }
}

fn is_disallowed_consumer_auth(auth_norm: &str) -> bool {
    const EXACT_DISALLOWED: &[&str] = &[
        "oauth",
        "oauth2",
        "oidc",
        "cookie",
        "cookies",
        "subscription",
        "claude_subscription",
        "codex_oauth",
        "chatgpt_oauth",
        "claude_oauth",
        "gemini_oauth",
        "google_oauth",
        "consumer",
        "consumer_subscription",
        "cli",
        "cli_session",
        "daemon",
        "acp",
        "session_cookie",
        "browser_cookie",
        "claude_pro",
        "claude_max",
        "chatgpt_plus",
        "pro",
        "max",
        "plus",
        "web",
        "jwt",
    ];
    if EXACT_DISALLOWED.contains(&auth_norm) {
        return true;
    }
    const DISALLOWED_SUBSTRINGS: &[&str] = &[
        "oauth",
        "cookie",
        "subscription",
        "consumer",
        "browser",
        "session_token",
    ];
    DISALLOWED_SUBSTRINGS
        .iter()
        .any(|needle| auth_norm.contains(needle))
}

fn is_official_api_key_auth(auth_norm: &str) -> bool {
    matches!(
        auth_norm,
        "api_key" | "api-key" | "apikey" | "official_api_key" | "api_token" | "api-token"
    )
}

fn is_opencode_go_auth(auth_norm: &str) -> bool {
    matches!(
        auth_norm,
        "opencode_go" | "opencode-go" | "gateway" | "official_gateway"
    )
}

fn is_opencode_go_gateway_url(url: &str) -> bool {
    let lower = url.trim().trim_end_matches('/').to_ascii_lowercase();
    lower.starts_with("https://opencode.ai/inference/go/")
        || lower == "https://opencode.ai/inference/go"
}

fn is_opencode_payg_only_url(url: &str) -> bool {
    let lower = url
        .trim()
        .trim_end_matches('/')
        .trim_end_matches("/chat/completions")
        .to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "https://opencode.ai/inference/v1"
            | "https://opencode.ai/inference/openai/v1"
            | "https://api.opencode.ai/v1"
    )
}

fn validate_endpoint_url(provider: &str, raw_url: &str) -> Result<String, FastLaneIneligible> {
    let trimmed = raw_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(ineligible(provider, "Base URL cannot be empty"));
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(ineligible(
            provider,
            "Base URL must not contain whitespace or control characters",
        ));
    }

    let lower = trimmed.to_ascii_lowercase();
    let is_https = lower.starts_with("https://") && trimmed.len() > "https://".len();
    let is_loopback_http = lower.starts_with("http://127.0.0.1:")
        || lower.starts_with("http://127.0.0.1/")
        || lower == "http://127.0.0.1"
        || lower.starts_with("http://localhost:")
        || lower.starts_with("http://localhost/")
        || lower == "http://localhost"
        || lower.starts_with("http://[::1]:")
        || lower.starts_with("http://[::1]/")
        || lower == "http://[::1]";

    if !is_https && !is_loopback_http {
        return Err(ineligible(
            provider,
            "Base URL must use HTTPS (or loopback http://127.0.0.1 for local tests)",
        ));
    }

    let after_scheme = if lower.starts_with("https://") {
        &trimmed["https://".len()..]
    } else {
        &trimmed["http://".len()..]
    };
    let host_part = after_scheme.split('/').next().unwrap_or("");
    if host_part.is_empty() || host_part.starts_with(':') {
        return Err(ineligible(provider, "Base URL is missing a valid host"));
    }

    Ok(trimmed.to_string())
}

/// Resolves and strictly validates whether a provider + credential pair is
/// eligible for the Native Rust Fast Lane.
///
/// Consumer subscriptions, OAuth logins, browser cookies, and consumer-only CLI
/// drivers (Antigravity, Cursor, Codex OAuth, Claude Pro/Max) are rejected so
/// they always remain on Phase 2 official daemons.
pub fn resolve_fast_lane_endpoint(
    provider: &str,
    model: &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
    auth_kind: &str,
    session_id: Option<&str>,
) -> Result<FastLaneEndpoint, FastLaneIneligible> {
    let provider_trimmed = provider.trim();
    if provider_trimmed.is_empty() {
        return Err(ineligible(provider, "Provider identifier is required"));
    }
    let provider_norm = provider_trimmed.to_ascii_lowercase();
    let auth_norm = auth_kind.trim().to_ascii_lowercase();

    // 1. Consumer-only drivers stay strictly on Phase 2 official daemons.
    if matches!(
        provider_norm.as_str(),
        "antigravity" | "agy" | "cursor" | "cursor-agent" | "codex" | "claude" | "claude-code"
    ) {
        return Err(ineligible(
            provider_trimmed,
            format!(
                "Consumer/CLI driver '{}' is not eligible for Direct Fast Lane and stays on Phase 2 official daemons",
                provider_trimmed
            ),
        ));
    }

    // 2. Reject consumer subscription / OAuth / cookie auth kinds regardless of provider.
    if auth_norm.is_empty() {
        return Err(ineligible(
            provider_trimmed,
            "auth_kind is required; only explicit official API keys or OpenCode Go gateway credentials are eligible",
        ));
    }
    if is_disallowed_consumer_auth(&auth_norm) {
        return Err(ineligible(
            provider_trimmed,
            format!(
                "Auth kind '{}' uses consumer subscription/OAuth/cookie credentials and stays on Phase 2 official daemons",
                auth_kind.trim()
            ),
        ));
    }

    // 3. Require non-empty model and API key.
    let model_trimmed = model.trim();
    if model_trimmed.is_empty() {
        return Err(ineligible(provider_trimmed, "Model identifier cannot be empty"));
    }
    let key_trimmed = api_key.unwrap_or("").trim();
    if key_trimmed.is_empty() {
        return Err(ineligible(
            provider_trimmed,
            "Official API key or gateway token is required and cannot be empty",
        ));
    }

    // 4. Resolve OpenCode Go official gateway vs official direct API key endpoints.
    let custom_url = base_url.map(str::trim).filter(|s| !s.is_empty());

    let is_opencode_alias = matches!(
        provider_norm.as_str(),
        "opencode_go" | "opencode-go" | "opencode" | "open-code"
    );
    if is_opencode_alias {
        let auth_ok = is_opencode_go_auth(&auth_norm) || is_official_api_key_auth(&auth_norm);
        if !auth_ok {
            return Err(ineligible(
                provider_trimmed,
                format!("Unsupported auth_kind '{}' for OpenCode Go", auth_kind.trim()),
            ));
        }

        let explicit_go_provider = matches!(provider_norm.as_str(), "opencode_go" | "opencode-go");
        let explicit_go_auth = is_opencode_go_auth(&auth_norm);
        let explicit_go_url = custom_url.is_some_and(is_opencode_go_gateway_url);

        if !explicit_go_provider && !explicit_go_auth && !explicit_go_url {
            return Err(ineligible(
                provider_trimmed,
                "Plain 'opencode' without auth_kind='opencode_go' or an OpenCode Go gateway URL stays on Phase 2 official daemons",
            ));
        }

        if let Some(url) = custom_url {
            if is_opencode_payg_only_url(url) {
                return Err(ineligible(
                    provider_trimmed,
                    "Pay-as-you-go OpenCode inference URL is incompatible with OpenCode Go gateway credentials",
                ));
            }
        }

        let resolved_url =
            validate_endpoint_url(provider_trimmed, custom_url.unwrap_or(OPENCODE_GO_DEFAULT_BASE_URL))?;
        let session_header = session_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        return Ok(FastLaneEndpoint {
            provider: "opencode_go".to_string(),
            base_url: resolved_url,
            model: model_trimmed.to_string(),
            api_key: key_trimmed.to_string(),
            eligibility: DirectEligibility::OfficialGateway(GatewayKind::OpenCodeGo),
            session_header,
        });
    }

    if !is_official_api_key_auth(&auth_norm) {
        return Err(ineligible(
            provider_trimmed,
            format!(
                "Auth kind '{}' is not an explicit official API key; consumer credentials stay on Phase 2 official daemons",
                auth_kind.trim()
            ),
        ));
    }

    let (canonical_provider, default_base_url) = match provider_norm.as_str() {
        "openai" => ("openai", OPENAI_DEFAULT_BASE_URL),
        "anthropic" => ("anthropic", ANTHROPIC_DEFAULT_BASE_URL),
        "xai" | "x-ai" | "grok" => ("xai", XAI_DEFAULT_BASE_URL),
        "gemini" | "google" => ("gemini", GEMINI_DEFAULT_BASE_URL),
        "deepseek" => ("deepseek", DEEPSEEK_DEFAULT_BASE_URL),
        "kimi" | "moonshot" => ("kimi", KIMI_DEFAULT_BASE_URL),
        "vercel" => ("vercel", VERCEL_DEFAULT_BASE_URL),
        "cloudflare" => ("cloudflare", CLOUDFLARE_DEFAULT_BASE_URL),
        other => {
            return Err(ineligible(
                provider_trimmed,
                format!(
                    "Provider '{}' is not an officially supported Fast Lane HTTPS API",
                    other
                ),
            ));
        }
    };

    let resolved_url =
        validate_endpoint_url(provider_trimmed, custom_url.unwrap_or(default_base_url))?;

    Ok(FastLaneEndpoint {
        provider: canonical_provider.to_string(),
        base_url: resolved_url,
        model: model_trimmed.to_string(),
        api_key: key_trimmed.to_string(),
        eligibility: DirectEligibility::OfficialApiKey,
        session_header: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_consumer_subscriptions_and_oauth_drivers() {
        let cases = [
            ("antigravity", "oauth", Some("ya29.consumer")),
            ("antigravity", "api_key", Some("ya29.consumer")),
            ("agy", "subscription", Some("tok")),
            ("cursor", "cookie", Some("WorkosCursorSessionToken")),
            ("cursor", "api_key", Some("tok")),
            ("claude", "claude_subscription", Some("sk-ant-oat01-xyz")),
            ("claude-code", "oauth", Some("sk-ant-oat01-xyz")),
            ("anthropic", "claude_subscription", Some("sk-ant-oat01-xyz")),
            ("codex", "codex_oauth", Some("eyJ.oauth")),
            ("openai", "codex_oauth", Some("eyJ.oauth")),
            ("openai", "oauth", Some("eyJ.oauth")),
            ("openai", "subscription", Some("eyJ.sub")),
            ("openai", "cookie", Some("sess=abc")),
            ("gemini", "oauth", Some("ya29.abc")),
            ("opencode", "oauth", Some("tok")),
            ("opencode", "api_key", Some("tok")),
        ];

        for (provider, auth_kind, key) in cases {
            let res =
                resolve_fast_lane_endpoint(provider, "test-model", key, None, auth_kind, None);
            assert!(
                res.is_err(),
                "expected rejection for provider={provider}, auth_kind={auth_kind}"
            );
            let err = res.unwrap_err();
            assert!(!err.reason.is_empty());
            assert!(err.to_string().contains("Fast Lane ineligible"));
        }

        let agy_err = resolve_fast_lane_endpoint(
            "antigravity",
            "gemini-2.5-pro",
            Some("tok"),
            None,
            "oauth",
            None,
        )
        .unwrap_err();
        assert!(agy_err.reason.contains("Phase 2 official daemons"));

        let cursor_err = resolve_fast_lane_endpoint(
            "cursor",
            "sonnet",
            Some("tok"),
            None,
            "cookie",
            None,
        )
        .unwrap_err();
        assert!(cursor_err.reason.contains("Phase 2 official daemons"));
    }

    #[test]
    fn rejects_missing_key_model_or_insecure_url() {
        assert!(
            resolve_fast_lane_endpoint("openai", "gpt-5", None, None, "api_key", None).is_err()
        );
        assert!(
            resolve_fast_lane_endpoint("openai", "gpt-5", Some("   "), None, "api_key", None)
                .is_err()
        );
        assert!(
            resolve_fast_lane_endpoint("openai", "  ", Some("sk-123"), None, "api_key", None)
                .is_err()
        );
        assert!(resolve_fast_lane_endpoint(
            "openai",
            "gpt-5",
            Some("sk-123"),
            Some("http://api.openai.com/v1"),
            "api_key",
            None
        )
        .is_err());
        assert!(resolve_fast_lane_endpoint(
            "openai",
            "gpt-5",
            Some("sk-123"),
            Some("http://127.0.0.1:8080/v1"),
            "api_key",
            None
        )
        .is_ok());
    }

    #[test]
    fn accepts_official_api_keys_with_defaults() {
        let expected = [
            ("openai", "openai", OPENAI_DEFAULT_BASE_URL),
            ("anthropic", "anthropic", ANTHROPIC_DEFAULT_BASE_URL),
            ("xai", "xai", XAI_DEFAULT_BASE_URL),
            ("grok", "xai", XAI_DEFAULT_BASE_URL),
            ("gemini", "gemini", GEMINI_DEFAULT_BASE_URL),
            ("deepseek", "deepseek", DEEPSEEK_DEFAULT_BASE_URL),
            ("kimi", "kimi", KIMI_DEFAULT_BASE_URL),
            ("vercel", "vercel", VERCEL_DEFAULT_BASE_URL),
            ("cloudflare", "cloudflare", CLOUDFLARE_DEFAULT_BASE_URL),
        ];

        for (raw_provider, canon, default_url) in expected {
            let ep = resolve_fast_lane_endpoint(
                raw_provider,
                "model-1",
                Some("key-123"),
                None,
                "api_key",
                Some("ignored-session"),
            )
            .unwrap_or_else(|e| panic!("expected ok for {raw_provider}: {e}"));
            assert_eq!(ep.provider, canon);
            assert_eq!(ep.base_url, default_url);
            assert_eq!(ep.model, "model-1");
            assert_eq!(ep.api_key, "key-123");
            assert_eq!(ep.eligibility, DirectEligibility::OfficialApiKey);
            assert_eq!(ep.session_header, None);
        }
    }

    #[test]
    fn accepts_opencode_go_gateway_and_attaches_session_header() {
        let ep1 = resolve_fast_lane_endpoint(
            "opencode_go",
            "glm-5",
            Some("ocg-key"),
            None,
            "opencode_go",
            Some("ses_kite_abc"),
        )
        .unwrap();
        assert_eq!(ep1.provider, "opencode_go");
        assert_eq!(ep1.base_url, OPENCODE_GO_DEFAULT_BASE_URL);
        assert_eq!(
            ep1.eligibility,
            DirectEligibility::OfficialGateway(GatewayKind::OpenCodeGo)
        );
        assert_eq!(ep1.session_header.as_deref(), Some("ses_kite_abc"));

        let ep2 = resolve_fast_lane_endpoint(
            "opencode",
            "kimi-k2.5",
            Some("ocg-key"),
            None,
            "opencode_go",
            Some("ses_2"),
        )
        .unwrap();
        assert_eq!(
            ep2.eligibility,
            DirectEligibility::OfficialGateway(GatewayKind::OpenCodeGo)
        );
        assert_eq!(ep2.session_header.as_deref(), Some("ses_2"));

        let ep3 = resolve_fast_lane_endpoint(
            "opencode",
            "glm-5",
            Some("ocg-key"),
            Some(OPENCODE_GO_DEFAULT_BASE_URL),
            "api_key",
            None,
        )
        .unwrap();
        assert_eq!(
            ep3.eligibility,
            DirectEligibility::OfficialGateway(GatewayKind::OpenCodeGo)
        );
        assert_eq!(ep3.session_header, None);

        // Reject pay-as-you-go route under opencode_go gateway
        assert!(resolve_fast_lane_endpoint(
            "opencode_go",
            "glm-5",
            Some("ocg-key"),
            Some("https://opencode.ai/inference/v1"),
            "opencode_go",
            Some("ses_3"),
        )
        .is_err());
    }

    #[test]
    fn shared_http_client_is_singleton() {
        let a = shared_http_client() as *const reqwest::Client;
        let b = shared_http_client() as *const reqwest::Client;
        assert_eq!(a, b);
    }
}
