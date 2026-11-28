use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::OnceLock;

const MAX_URL_LENGTH: usize = 2048;

const SENSITIVE_GOOGLE_SUBDOMAINS: &[&str] = &[
    "mail.google.com",
    "docs.google.com",
    "drive.google.com",
    "calendar.google.com",
    "chat.google.com",
    "contacts.google.com",
    "photos.google.com",
    "meet.google.com",
    "keep.google.com",
    "admin.google.com",
    "myaccount.google.com",
    "accounts.google.com",
    "console.cloud.google.com",
];

const IDP_DOMAINS: &[&str] = &[
    "accounts.google.com",
    "login.microsoftonline.com",
    "login.live.com",
    "appleid.apple.com",
    "auth0.com",
    "okta.com",
    "oktapreview.com",
    "onelogin.com",
    "duosecurity.com",
    "amazoncognito.com",
    "clerk.accounts.dev",
    "accounts.clerk.dev",
    "login.salesforce.com",
    "id.atlassian.com",
];

const PAYMENT_DOMAINS: &[&str] = &[
    "checkout.stripe.com",
    "pay.stripe.com",
    "buy.stripe.com",
    "js.stripe.com",
    "checkout.shopify.com",
    "shop.app",
    "pay.google.com",
    "checkout.paddle.com",
    "checkout.lemonsqueezy.com",
    "checkout.razorpay.com",
    "checkout.square.site",
    "secure.2checkout.com",
];

const CAPTCHA_DOMAINS: &[&str] = &[
    "challenges.cloudflare.com",
    "hcaptcha.com",
    "newassets.hcaptcha.com",
    "www.recaptcha.net",
    "recaptcha.net",
    "arkoselabs.com",
    "funcaptcha.com",
    "geetest.com",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SensitivePageKind {
    SignIn,
    Payment,
    Captcha,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyDecision {
    Allow,
    Ask {
        reason: String,
        rule_hint: String,
    },
    Deny {
        reason: String,
    },
    PauseForUser {
        kind: SensitivePageKind,
        reason: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JsEvalPolicy {
    Ask,
    Allow,
    Deny,
}

impl Default for JsEvalPolicy {
    fn default() -> Self {
        Self::Ask
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainRule {
    pub pattern: String,
    pub decision: PolicyDecision,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActuationPolicy {
    #[serde(default)]
    pub rules: Vec<DomainRule>,
    #[serde(default = "default_true")]
    pub auto_allow_discovered_loopback: bool,
    #[serde(default)]
    pub js_eval_policy: JsEvalPolicy,
    #[serde(default)]
    pub allow_cross_origin_iframes: bool,
}

impl Default for BrowserActuationPolicy {
    fn default() -> Self {
        Self {
            rules: Vec::new(),
            auto_allow_discovered_loopback: true,
            js_eval_policy: JsEvalPolicy::Ask,
            allow_cross_origin_iframes: false,
        }
    }
}

/// Parses an HTTP/HTTPS URL into `(scheme, normalized_host, port)`.
/// Rejects non-http(s) schemes, control/whitespace characters, userinfo (`@`), and invalid ports.
pub fn parse_origin_and_port(url: &str) -> Option<(String, String, u16)> {
    let raw = url.trim();
    if raw.is_empty()
        || raw.len() > MAX_URL_LENGTH
        || raw.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return None;
    }

    let (scheme, rest) = split_http_scheme(raw)?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() || authority.contains('@') {
        return None;
    }

    let (host, port) = parse_host_and_port(authority, scheme)?;
    if host.is_empty() {
        return None;
    }
    Some((scheme.to_string(), host, port))
}

fn split_http_scheme(raw: &str) -> Option<(&'static str, &str)> {
    let idx = raw.find("://")?;
    let scheme = &raw[..idx];
    let rest = &raw[idx + 3..];
    if scheme.eq_ignore_ascii_case("https") {
        Some(("https", rest))
    } else if scheme.eq_ignore_ascii_case("http") {
        Some(("http", rest))
    } else {
        None
    }
}

fn parse_host_and_port(authority: &str, scheme: &str) -> Option<(String, u16)> {
    let default_port = if scheme == "https" { 443 } else { 80 };

    if let Some(after_bracket) = authority.strip_prefix('[') {
        let close = after_bracket.find(']')?;
        let ipv6_raw = &after_bracket[..close];
        let ipv6 = Ipv6Addr::from_str(ipv6_raw).ok()?;
        let remainder = &after_bracket[close + 1..];
        let port = if remainder.is_empty() {
            default_port
        } else if let Some(port_str) = remainder.strip_prefix(':') {
            parse_valid_port(port_str)?
        } else {
            return None;
        };
        return Some((ipv6.to_string(), port));
    }

    let mut parts = authority.split(':');
    let host_raw = parts.next()?;
    let port_opt = parts.next();
    if parts.next().is_some() {
        return None;
    }

    let port = match port_opt {
        Some(port_str) => parse_valid_port(port_str)?,
        None => default_port,
    };

    let normalized_host = normalize_host(host_raw);
    if normalized_host.is_empty() || normalized_host.contains(['[', ']']) {
        return None;
    }
    Some((normalized_host, port))
}

fn parse_valid_port(port_str: &str) -> Option<u16> {
    if port_str.is_empty() || !port_str.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let port = port_str.parse::<u16>().ok()?;
    if port == 0 {
        return None;
    }
    Some(port)
}

fn normalize_host(host: &str) -> String {
    host.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

/// Returns `true` when `host` identifies a local loopback address (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`).
pub fn is_loopback_host(host: &str) -> bool {
    let normalized = normalize_host(host);
    if normalized.is_empty() {
        return false;
    }
    if normalized == "localhost" || normalized.ends_with(".localhost") {
        return true;
    }
    if let Ok(v4) = Ipv4Addr::from_str(&normalized) {
        return v4.is_loopback();
    }
    if let Ok(v6) = Ipv6Addr::from_str(&normalized) {
        if v6.is_loopback() {
            return true;
        }
        if let Some(mapped) = v6.to_ipv4_mapped() {
            return mapped.is_loopback();
        }
    }
    false
}

/// Returns `true` for cloud metadata endpoints, link-local ranges, and unspecified addresses (`169.254.*`, `100.100.100.200`, `metadata.google.internal`, `0.0.0.0`).
pub fn is_ssrf_or_metadata_target(url: &str) -> bool {
    let raw = url.trim();
    if raw.is_empty() {
        return false;
    }

    let authority = match split_http_scheme(raw) {
        Some((_, rest)) => rest.split(['/', '?', '#']).next().unwrap_or(""),
        None => return false,
    };

    // Inspect the host even when userinfo (`@`) is present to prevent `localhost@169.254.169.254` bypasses.
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let host_raw = if let Some(inner) = host_port.strip_prefix('[') {
        inner.split(']').next().unwrap_or("")
    } else {
        host_port.split(':').next().unwrap_or("")
    };
    let host = normalize_host(host_raw);
    if host.is_empty() {
        return false;
    }

    if host == "metadata.google.internal"
        || host.ends_with(".metadata.google.internal")
        || host == "metadata.goog"
        || host == "metadata.azure.internal"
        || host == "metadata"
        || host == "instance-data"
    {
        return true;
    }

    if let Some(v4) = parse_ipv4_flexible(&host) {
        return is_blocked_ipv4(v4);
    }

    if let Ok(v6) = Ipv6Addr::from_str(&host) {
        if v6.is_unspecified() {
            return true;
        }
        let segments = v6.segments();
        // Link-local fe80::/10
        if (segments[0] & 0xffc0) == 0xfe80 {
            return true;
        }
        // AWS IPv6 IMDS fd00:ec2::254
        if segments == [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254] {
            return true;
        }
        if let Some(mapped) = v6.to_ipv4_mapped() {
            return is_blocked_ipv4(mapped);
        }
    }

    false
}

fn is_blocked_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    // 169.254.0.0/16 (link-local / AWS/GCP/Azure IMDS)
    if ip.is_link_local() {
        return true;
    }
    // 100.100.100.200 (Alibaba Cloud metadata)
    if octets == [100, 100, 100, 200] {
        return true;
    }
    // 0.0.0.0/8 (unspecified network)
    if octets[0] == 0 {
        return true;
    }
    false
}

fn parse_ipv4_flexible(host: &str) -> Option<Ipv4Addr> {
    if let Ok(v4) = Ipv4Addr::from_str(host) {
        return Some(v4);
    }
    // Catch single-integer or hex-integer IPv4 SSRF bypasses (e.g. 2852039166 or 0xa9fea9fe).
    if let Some(hex) = host.strip_prefix("0x") {
        if !hex.is_empty() && hex.len() <= 8 {
            if let Ok(num) = u32::from_str_radix(hex, 16) {
                return Some(Ipv4Addr::from(num));
            }
        }
    } else if !host.contains('.') && host.bytes().all(|b| b.is_ascii_digit()) {
        if let Ok(num) = host.parse::<u32>() {
            return Some(Ipv4Addr::from(num));
        }
    }
    // Catch octal/hex dotted quads such as 0251.0376.0251.0376.
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() == 4 {
        let mut octets = [0u8; 4];
        for (idx, part) in parts.iter().enumerate() {
            let val = if let Some(hex) = part.strip_prefix("0x") {
                u32::from_str_radix(hex, 16).ok()?
            } else if part.len() > 1 && part.starts_with('0') {
                u32::from_str_radix(part, 8).ok()?
            } else {
                part.parse::<u32>().ok()?
            };
            if val > 255 {
                return None;
            }
            octets[idx] = val as u8;
        }
        return Some(Ipv4Addr::from(octets));
    }
    None
}

fn host_matches_suffix(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{domain}"))
}

/// Detects authentication (OAuth/SSO), payment, or CAPTCHA pages from URL, title, and AX text.
pub fn detect_sensitive_page(
    url: &str,
    title: Option<&str>,
    ax_text_hint: Option<&str>,
) -> Option<SensitivePageKind> {
    let (_, host, _) = parse_origin_and_port(url)?;
    let lower_url = url.to_ascii_lowercase();
    let lower_title = title.unwrap_or("").to_ascii_lowercase();
    let lower_ax = ax_text_hint.unwrap_or("").to_ascii_lowercase();
    let combined_text = format!("{lower_title}\n{lower_ax}");

    // 1. CAPTCHA / anti-bot gates
    if CAPTCHA_DOMAINS.iter().any(|d| host_matches_suffix(&host, d))
        || lower_url.contains("/captcha")
        || lower_url.contains("recaptcha")
        || lower_url.contains("hcaptcha")
        || lower_url.contains("turnstile")
        || combined_text.contains("verify you are human")
        || combined_text.contains("i am not a robot")
        || combined_text.contains("i'm not a robot")
        || combined_text.contains("complete the captcha")
        || combined_text.contains("cloudflare turnstile")
        || (combined_text.contains("just a moment") && combined_text.contains("cloudflare"))
    {
        return Some(SensitivePageKind::Captcha);
    }

    // 2. Payment processors & card collection
    let is_paypal_checkout =
        host_matches_suffix(&host, "paypal.com") && lower_url.contains("checkout");
    if PAYMENT_DOMAINS.iter().any(|d| host_matches_suffix(&host, d))
        || is_paypal_checkout
        || lower_url.contains("/checkout/pay")
        || lower_url.contains("/billing/payment")
        || lower_url.contains("/payment-method")
        || combined_text.contains("card number")
        || combined_text.contains("credit or debit card")
        || combined_text.contains("credit card")
        || combined_text.contains("security code") && combined_text.contains("expir")
        || combined_text.contains("cvv")
        || combined_text.contains("cvc")
    {
        return Some(SensitivePageKind::Payment);
    }

    // 3. Identity providers, OAuth/SSO, and MFA/auth gates
    let is_idp_host = IDP_DOMAINS.iter().any(|d| host_matches_suffix(&host, d))
        || host.starts_with("sso.")
        || host.starts_with("login.")
        || host.starts_with("auth.");
    let is_known_portal_auth = (host_matches_suffix(&host, "github.com")
        && (lower_url.contains("/login") || lower_url.contains("/sessions")))
        || (host_matches_suffix(&host, "gitlab.com") && lower_url.contains("/users/sign_in"))
        || (host_matches_suffix(&host, "discord.com") && lower_url.contains("/oauth2"))
        || (host_matches_suffix(&host, "slack.com") && lower_url.contains("/openid"))
        || (host_matches_suffix(&host, "paypal.com") && lower_url.contains("/signin"));
    let is_oauth_protocol = lower_url.contains("/oauth/authorize")
        || lower_url.contains("/oauth2/authorize")
        || lower_url.contains("/oauth2/v2/auth")
        || lower_url.contains("/login/oauth")
        || lower_url.contains("/openid-connect/auth")
        || lower_url.contains("/saml/sso")
        || lower_url.contains("/saml2/")
        || (lower_url.contains("client_id=") && lower_url.contains("redirect_uri="));
    let is_non_loopback_auth_path = !is_loopback_host(&host)
        && (lower_url.contains("/signin")
            || lower_url.contains("/sign-in")
            || lower_url.contains("/sso/login"));

    let has_sensitive_auth_text = combined_text.contains("sign in with google")
        || combined_text.contains("sign in with github")
        || combined_text.contains("sign in with microsoft")
        || combined_text.contains("sign in with apple")
        || combined_text.contains("continue with google")
        || combined_text.contains("single sign-on")
        || combined_text.contains("two-factor authentication")
        || combined_text.contains("multi-factor authentication")
        || combined_text.contains("one-time password")
        || combined_text.contains("enter verification code");

    if is_idp_host
        || is_known_portal_auth
        || is_oauth_protocol
        || is_non_loopback_auth_path
        || has_sensitive_auth_text
    {
        return Some(SensitivePageKind::SignIn);
    }

    None
}

fn sensitive_pause_reason(kind: SensitivePageKind, host: &str) -> String {
    match kind {
        SensitivePageKind::SignIn => {
            format!("Paused for user sign-in / OAuth handoff on {host}")
        }
        SensitivePageKind::Payment => {
            format!("Paused for user payment verification on {host}")
        }
        SensitivePageKind::Captcha => {
            format!("Paused for user CAPTCHA / anti-bot verification on {host}")
        }
    }
}

fn is_sensitive_google_subdomain(host: &str) -> bool {
    SENSITIVE_GOOGLE_SUBDOMAINS.iter().any(|d| *d == host)
}

#[derive(Debug)]
struct ParsedRulePattern {
    scheme: Option<String>,
    wildcard_subdomains: bool,
    host: String,
    port: Option<u16>,
}

fn parse_rule_pattern(pattern: &str) -> Option<ParsedRulePattern> {
    let mut raw = pattern.trim().to_ascii_lowercase();
    if raw.is_empty() {
        return None;
    }

    let scheme = if let Some(rest) = raw.strip_prefix("https://") {
        raw = rest.to_string();
        Some("https".to_string())
    } else if let Some(rest) = raw.strip_prefix("http://") {
        raw = rest.to_string();
        Some("http".to_string())
    } else {
        None
    };

    let authority = raw.split(['/', '?', '#']).next().unwrap_or("").trim();
    if authority.is_empty() {
        return None;
    }

    let (wildcard_subdomains, host_port) = if let Some(rest) = authority.strip_prefix("*.") {
        (true, rest)
    } else {
        (false, authority)
    };

    let (host, port) = if let Some(after_bracket) = host_port.strip_prefix('[') {
        let close = after_bracket.find(']')?;
        let ipv6 = normalize_host(&after_bracket[..close]);
        let rem = &after_bracket[close + 1..];
        let port = if rem.is_empty() {
            None
        } else if let Some(p) = rem.strip_prefix(':') {
            Some(parse_valid_port(p)?)
        } else {
            return None;
        };
        (ipv6, port)
    } else if host_port.matches(':').count() == 1 {
        let mut parts = host_port.split(':');
        let h = normalize_host(parts.next()?);
        let p = parse_valid_port(parts.next()?)?;
        (h, Some(p))
    } else if host_port.contains(':') {
        // Bare IPv6 literal without brackets (e.g. `::1`)
        let ipv6 = Ipv6Addr::from_str(host_port).ok()?;
        (ipv6.to_string(), None)
    } else {
        (normalize_host(host_port), None)
    };

    if host.is_empty() {
        return None;
    }

    Some(ParsedRulePattern {
        scheme,
        wildcard_subdomains,
        host,
        port,
    })
}

fn rule_matches(rule_pattern: &str, scheme: &str, host: &str, port: u16) -> bool {
    let Some(parsed) = parse_rule_pattern(rule_pattern) else {
        return false;
    };

    if let Some(ref req_scheme) = parsed.scheme {
        if req_scheme != scheme {
            return false;
        }
    }

    if let Some(req_port) = parsed.port {
        if req_port != port {
            return false;
        }
    }

    // Strict per-port / exact-host isolation for loopback hosts unless wildcarded (`*.localhost`).
    if is_loopback_host(&parsed.host) || is_loopback_host(host) {
        if parsed.wildcard_subdomains {
            return host.ends_with(&format!(".{}", parsed.host));
        }
        return host == parsed.host;
    }

    // General google.com / cloud.google.com rules must NEVER grant access to sensitive subdomains.
    let is_general_google = (parsed.host == "google.com" || parsed.host == "cloud.google.com")
        && is_sensitive_google_subdomain(host);
    if is_general_google {
        return false;
    }

    if parsed.wildcard_subdomains {
        host.ends_with(&format!(".{}", parsed.host))
    } else {
        host == parsed.host || host.ends_with(&format!(".{}", parsed.host))
    }
}

fn format_rule_hint(host: &str, port: u16, scheme: &str) -> String {
    let is_default_port = (scheme == "http" && port == 80) || (scheme == "https" && port == 443);
    let display_host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    if is_loopback_host(host) || !is_default_port {
        format!("{display_host}:{port}")
    } else {
        display_host
    }
}

fn find_highest_priority_rule<'a>(
    rules: &'a [DomainRule],
    scheme: &str,
    host: &str,
    port: u16,
) -> Option<&'a PolicyDecision> {
    let mut matched_ask: Option<&PolicyDecision> = None;
    let mut matched_allow: Option<&PolicyDecision> = None;

    for rule in rules {
        if !rule_matches(&rule.pattern, scheme, host, port) {
            continue;
        }
        match &rule.decision {
            PolicyDecision::Deny { .. } => return Some(&rule.decision),
            PolicyDecision::Ask { .. } => {
                if matched_ask.is_none() {
                    matched_ask = Some(&rule.decision);
                }
            }
            PolicyDecision::Allow => {
                if matched_allow.is_none() {
                    matched_allow = Some(&rule.decision);
                }
            }
            PolicyDecision::PauseForUser { .. } => {}
        }
    }

    matched_ask.or(matched_allow)
}

/// Evaluates whether agent navigation to `url` is allowed, needs confirmation, pauses for user auth, or is denied.
/// Precedence: SSRF/invalid -> explicit Deny -> PauseForUser (always on OAuth/SSO/payment/CAPTCHA) ->
/// explicit Ask -> explicit Allow -> discovered loopback auto-allow -> default Ask.
pub fn evaluate_navigation_url(
    url: &str,
    policy: &BrowserActuationPolicy,
    discovered_loopback_ports: &[u16],
) -> PolicyDecision {
    if is_ssrf_or_metadata_target(url) {
        return PolicyDecision::Deny {
            reason: "Blocked SSRF, link-local, or cloud metadata target".to_string(),
        };
    }

    let Some((scheme, host, port)) = parse_origin_and_port(url) else {
        return PolicyDecision::Deny {
            reason: "Blocked invalid or non-http(s) navigation URL".to_string(),
        };
    };

    let matched_rule = find_highest_priority_rule(&policy.rules, &scheme, &host, port);
    if let Some(PolicyDecision::Deny { reason }) = matched_rule {
        return PolicyDecision::Deny {
            reason: reason.clone(),
        };
    }

    if let Some(kind) = detect_sensitive_page(url, None, None) {
        return PolicyDecision::PauseForUser {
            kind,
            reason: sensitive_pause_reason(kind, &host),
        };
    }

    if let Some(decision) = matched_rule {
        return decision.clone();
    }

    if policy.auto_allow_discovered_loopback
        && is_loopback_host(&host)
        && discovered_loopback_ports.contains(&port)
    {
        return PolicyDecision::Allow;
    }

    let rule_hint = format_rule_hint(&host, port, &scheme);
    PolicyDecision::Ask {
        reason: format!("Browser actuation on {rule_hint} requires approval"),
        rule_hint,
    }
}

/// Evaluates whether arbitrary JavaScript evaluation (`eval`) is allowed on `url`.
pub fn evaluate_js_eval(url: &str, policy: &BrowserActuationPolicy) -> PolicyDecision {
    if is_ssrf_or_metadata_target(url) {
        return PolicyDecision::Deny {
            reason: "Blocked JavaScript evaluation on SSRF or metadata target".to_string(),
        };
    }

    let Some((scheme, host, port)) = parse_origin_and_port(url) else {
        return PolicyDecision::Deny {
            reason: "Blocked JavaScript evaluation on invalid or non-http(s) URL".to_string(),
        };
    };

    if let Some(PolicyDecision::Deny { reason }) =
        find_highest_priority_rule(&policy.rules, &scheme, &host, port)
    {
        return PolicyDecision::Deny {
            reason: reason.clone(),
        };
    }

    if let Some(kind) = detect_sensitive_page(url, None, None) {
        return PolicyDecision::PauseForUser {
            kind,
            reason: sensitive_pause_reason(kind, &host),
        };
    }

    let rule_hint = format_rule_hint(&host, port, &scheme);
    match policy.js_eval_policy {
        JsEvalPolicy::Deny => PolicyDecision::Deny {
            reason: "JavaScript evaluation is denied by browser policy".to_string(),
        },
        JsEvalPolicy::Ask => PolicyDecision::Ask {
            reason: format!("JavaScript evaluation on {rule_hint} requires user approval"),
            rule_hint,
        },
        JsEvalPolicy::Allow => {
            if let Some(PolicyDecision::Ask { reason, rule_hint }) =
                find_highest_priority_rule(&policy.rules, &scheme, &host, port)
            {
                PolicyDecision::Ask {
                    reason: reason.clone(),
                    rule_hint: rule_hint.clone(),
                }
            } else {
                PolicyDecision::Allow
            }
        }
    }
}

fn is_sensitive_header_name(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "authorization"
            | "proxy-authorization"
            | "cookie"
            | "set-cookie"
            | "x-api-key"
            | "api-key"
            | "x-auth-token"
            | "x-access-token"
            | "x-refresh-token"
            | "x-csrf-token"
            | "x-xsrf-token"
            | "x-session-token"
            | "x-secret-key"
            | "x-amz-security-token"
            | "x-goog-api-key"
            | "private-token"
    ) || lower.contains("secret")
        || lower.contains("password")
        || lower.contains("passwd")
        || lower.contains("token")
        || lower.contains("cookie")
        || lower.contains("api-key")
        || lower.contains("api_key")
        || lower.contains("apikey")
        || lower.contains("credential")
}

/// Redacts sensitive HTTP header values (`Authorization`, `Cookie`, API keys, tokens, etc.).
pub fn scrub_headers(
    headers: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut scrubbed = serde_json::Map::with_capacity(headers.len());
    for (key, value) in headers {
        if is_sensitive_header_name(key) {
            scrubbed.insert(
                key.clone(),
                serde_json::Value::String("[REDACTED]".to_string()),
            );
        } else {
            let next_value = match value {
                serde_json::Value::String(text) => {
                    serde_json::Value::String(scrub_text_secrets(text))
                }
                other => other.clone(),
            };
            scrubbed.insert(key.clone(), next_value);
        }
    }
    scrubbed
}

fn secret_patterns() -> &'static Vec<(Regex, &'static str)> {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            (
                Regex::new(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}")
                    .expect("valid auth scheme regex"),
                "$1 [REDACTED]",
            ),
            (
                Regex::new(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")
                    .expect("valid jwt regex"),
                "[REDACTED]",
            ),
            (
                Regex::new(r"\b(?:sk_(?:live|test)_[A-Za-z0-9]{12,}|pk_(?:live|test)_[A-Za-z0-9]{12,}|rk_(?:live|test)_[A-Za-z0-9]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pous]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,})\b")
                    .expect("valid api key regex"),
                "[REDACTED]",
            ),
            (
                Regex::new(r#"(?i)("(?:password|passwd|secret|api_key|apiKey|access_token|accessToken|refresh_token|refreshToken|client_secret|clientSecret|private_key|privateKey|id_token|idToken)"\s*:\s*)"[^"]*""#)
                    .expect("valid json secret regex"),
                r#"$1"[REDACTED]""#,
            ),
            (
                Regex::new(r"(?i)\b(Authorization|Proxy-Authorization|Set-Cookie|Cookie|X-Api-Key|X-Auth-Token)\s*:\s*[^\r\n;]+")
                    .expect("valid header text regex"),
                "$1: [REDACTED]",
            ),
            (
                Regex::new(r#"(?i)([?&](?:token|access_token|refresh_token|api_key|apikey|secret|password|passwd|client_secret)=)[^&\s"'<>]+"#)
                    .expect("valid query secret regex"),
                "$1[REDACTED]",
            ),
        ]
    })
}

/// Scrubs bearer/basic credentials, JWTs, API keys, cookies, and password fields from free-form text.
pub fn scrub_text_secrets(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }
    let mut out = input.to_string();
    for (regex, replacement) in secret_patterns() {
        out = regex.replace_all(&out, *replacement).into_owned();
    }
    out
}

/// Returns the browser policy file path, honoring `KITE_BROWSER_POLICY_PATH` or defaulting to `~/.kite/browser_policy.json`.
pub fn policy_file_path() -> PathBuf {
    if let Ok(override_path) = std::env::var("KITE_BROWSER_POLICY_PATH") {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    match home {
        Some(dir) => PathBuf::from(dir).join(".kite").join("browser_policy.json"),
        None => PathBuf::from(".kite").join("browser_policy.json"),
    }
}

/// Loads `BrowserActuationPolicy` from disk; returns default policy if the file does not exist yet.
pub fn load_policy_from_disk() -> Result<BrowserActuationPolicy, String> {
    let path = policy_file_path();
    if !path.exists() {
        return Ok(BrowserActuationPolicy::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("failed to read browser policy {}: {err}", path.display()))?;
    serde_json::from_str::<BrowserActuationPolicy>(&raw)
        .map_err(|err| format!("failed to parse browser policy {}: {err}", path.display()))
}

/// Persists `BrowserActuationPolicy` atomically to `policy_file_path()`.
pub fn save_policy_to_disk(policy: &BrowserActuationPolicy) -> Result<(), String> {
    let path = policy_file_path();
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|err| {
                format!(
                    "failed to create browser policy directory {}: {err}",
                    parent.display()
                )
            })?;
        }
    }
    let json = serde_json::to_string_pretty(policy)
        .map_err(|err| format!("failed to serialize browser policy: {err}"))?;
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, format!("{json}\n"))
        .map_err(|err| format!("failed to write browser policy {}: {err}", tmp_path.display()))?;
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
    fs::rename(&tmp_path, &path).map_err(|err| {
        let _ = fs::remove_file(&tmp_path);
        format!("failed to move browser policy into place {}: {err}", path.display())
    })?;
    Ok(())
}

fn normalize_rule_pattern(pattern: &str) -> String {
    pattern.trim().trim_end_matches('/').to_ascii_lowercase()
}

/// Inserts or updates a domain rule in place using normalized pattern matching.
pub fn add_or_update_rule(
    policy: &mut BrowserActuationPolicy,
    pattern: &str,
    decision: PolicyDecision,
) {
    let normalized = normalize_rule_pattern(pattern);
    if normalized.is_empty() {
        return;
    }
    if let Some(existing) = policy
        .rules
        .iter_mut()
        .find(|rule| normalize_rule_pattern(&rule.pattern) == normalized)
    {
        existing.pattern = normalized;
        existing.decision = decision;
    } else {
        policy.rules.push(DomainRule {
            pattern: normalized,
            decision,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn parses_origins_and_ports_with_validation() {
        assert_eq!(
            parse_origin_and_port("http://localhost:5173/dashboard?tab=1"),
            Some(("http".to_string(), "localhost".to_string(), 5173))
        );
        assert_eq!(
            parse_origin_and_port("https://Example.COM/path"),
            Some(("https".to_string(), "example.com".to_string(), 443))
        );
        assert_eq!(
            parse_origin_and_port("http://[::1]:1420/"),
            Some(("http".to_string(), "::1".to_string(), 1420))
        );
        assert_eq!(parse_origin_and_port("file:///etc/passwd"), None);
        assert_eq!(parse_origin_and_port("javascript:alert(1)"), None);
        assert_eq!(parse_origin_and_port("http://localhost@evil.com/"), None);
        assert_eq!(parse_origin_and_port("http://localhost:0/"), None);
        assert_eq!(parse_origin_and_port("http://localhost:99999/"), None);
    }

    #[test]
    fn recognizes_loopback_hosts() {
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("app.localhost"));
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("127.0.0.42"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("[::1]"));
        assert!(!is_loopback_host("0.0.0.0"));
        assert!(!is_loopback_host("169.254.169.254"));
        assert!(!is_loopback_host("example.com"));
    }

    #[test]
    fn blocks_ssrf_and_metadata_targets_even_with_obfuscation() {
        assert!(is_ssrf_or_metadata_target("http://169.254.169.254/latest/meta-data/"));
        assert!(is_ssrf_or_metadata_target("http://169.254.170.2/v2/credentials"));
        assert!(is_ssrf_or_metadata_target("http://100.100.100.200/latest/meta-data/"));
        assert!(is_ssrf_or_metadata_target("http://metadata.google.internal/computeMetadata/v1/"));
        assert!(is_ssrf_or_metadata_target("http://metadata.google.internal./"));
        assert!(is_ssrf_or_metadata_target("http://localhost@169.254.169.254/"));
        assert!(is_ssrf_or_metadata_target("http://0xa9fea9fe/"));
        assert!(is_ssrf_or_metadata_target("http://2852039166/"));
        assert!(is_ssrf_or_metadata_target("http://[fe80::1]/"));
        assert!(is_ssrf_or_metadata_target("http://[fd00:ec2::254]/latest/api/token"));
        assert!(is_ssrf_or_metadata_target("http://0.0.0.0:8080/"));
        assert!(!is_ssrf_or_metadata_target("http://localhost:5173/"));
        assert!(!is_ssrf_or_metadata_target("https://example.com/"));

        let mut policy = BrowserActuationPolicy::default();
        add_or_update_rule(&mut policy, "169.254.169.254", PolicyDecision::Allow);
        let decision = evaluate_navigation_url("http://169.254.169.254/latest/meta-data/", &policy, &[]);
        assert!(matches!(decision, PolicyDecision::Deny { .. }));
    }

    #[test]
    fn enforces_strict_per_port_localhost_isolation() {
        let mut policy = BrowserActuationPolicy {
            auto_allow_discovered_loopback: false,
            ..Default::default()
        };
        add_or_update_rule(&mut policy, "localhost:5173", PolicyDecision::Allow);

        assert_eq!(
            evaluate_navigation_url("http://localhost:5173/app", &policy, &[]),
            PolicyDecision::Allow
        );
        let other_port = evaluate_navigation_url("http://localhost:8080/admin", &policy, &[]);
        assert!(matches!(
            other_port,
            PolicyDecision::Ask { ref rule_hint, .. } if rule_hint == "localhost:8080"
        ));

        // Bare localhost matches all ports on localhost, but not 127.0.0.1
        add_or_update_rule(&mut policy, "localhost", PolicyDecision::Allow);
        assert_eq!(
            evaluate_navigation_url("http://localhost:8080/admin", &policy, &[]),
            PolicyDecision::Allow
        );
        assert!(matches!(
            evaluate_navigation_url("http://127.0.0.1:8080/admin", &policy, &[]),
            PolicyDecision::Ask { .. }
        ));
    }

    #[test]
    fn enforces_deny_over_ask_over_allow_precedence() {
        let mut policy = BrowserActuationPolicy::default();
        add_or_update_rule(&mut policy, "example.com", PolicyDecision::Allow);
        policy.rules.push(DomainRule {
            pattern: "api.example.com".to_string(),
            decision: PolicyDecision::Ask {
                reason: "Confirm API mutation".to_string(),
                rule_hint: "api.example.com".to_string(),
            },
        });
        policy.rules.push(DomainRule {
            pattern: "admin.api.example.com".to_string(),
            decision: PolicyDecision::Deny {
                reason: "Admin blocked".to_string(),
            },
        });

        assert_eq!(
            evaluate_navigation_url("https://app.example.com/", &policy, &[]),
            PolicyDecision::Allow
        );
        assert!(matches!(
            evaluate_navigation_url("https://api.example.com/v1", &policy, &[]),
            PolicyDecision::Ask { .. }
        ));
        assert!(matches!(
            evaluate_navigation_url("https://admin.api.example.com/", &policy, &[]),
            PolicyDecision::Deny { .. }
        ));
    }

    #[test]
    fn excludes_sensitive_google_subdomains_from_general_rules() {
        let mut policy = BrowserActuationPolicy::default();
        add_or_update_rule(&mut policy, "google.com", PolicyDecision::Allow);
        add_or_update_rule(&mut policy, "cloud.google.com", PolicyDecision::Allow);

        assert_eq!(
            evaluate_navigation_url("https://www.google.com/search?q=rust", &policy, &[]),
            PolicyDecision::Allow
        );
        for sensitive in [
            "https://mail.google.com/mail/u/0/",
            "https://docs.google.com/document/d/1",
            "https://drive.google.com/drive/my-drive",
            "https://calendar.google.com/calendar/",
            "https://chat.google.com/",
            "https://console.cloud.google.com/iam-admin",
        ] {
            let decision = evaluate_navigation_url(sensitive, &policy, &[]);
            assert!(
                matches!(decision, PolicyDecision::Ask { .. }),
                "expected Ask for sensitive subdomain {sensitive}, got {decision:?}"
            );
        }

        // Explicit exact rule can still allow or deny a specific subdomain
        add_or_update_rule(&mut policy, "docs.google.com", PolicyDecision::Allow);
        assert_eq!(
            evaluate_navigation_url("https://docs.google.com/document/d/1", &policy, &[]),
            PolicyDecision::Allow
        );
    }

    #[test]
    fn pauses_for_user_on_sensitive_pages_even_when_domain_allowed() {
        let mut policy = BrowserActuationPolicy::default();
        add_or_update_rule(&mut policy, "github.com", PolicyDecision::Allow);
        add_or_update_rule(&mut policy, "stripe.com", PolicyDecision::Allow);
        add_or_update_rule(&mut policy, "challenges.cloudflare.com", PolicyDecision::Allow);

        assert!(matches!(
            evaluate_navigation_url("https://github.com/login", &policy, &[]),
            PolicyDecision::PauseForUser {
                kind: SensitivePageKind::SignIn,
                ..
            }
        ));
        assert!(matches!(
            evaluate_navigation_url("https://checkout.stripe.com/c/pay/cs_test_123", &policy, &[]),
            PolicyDecision::PauseForUser {
                kind: SensitivePageKind::Payment,
                ..
            }
        ));
        assert!(matches!(
            evaluate_navigation_url("https://challenges.cloudflare.com/turnstile", &policy, &[]),
            PolicyDecision::PauseForUser {
                kind: SensitivePageKind::Captcha,
                ..
            }
        ));
        assert_eq!(
            detect_sensitive_page(
                "http://localhost:5173/step",
                Some("Security Check"),
                Some("Please verify you are human to continue")
            ),
            Some(SensitivePageKind::Captcha)
        );
        assert_eq!(
            detect_sensitive_page(
                "http://localhost:5173/billing",
                Some("Checkout"),
                Some("Card number and CVV")
            ),
            Some(SensitivePageKind::Payment)
        );
    }

    #[test]
    fn auto_allows_discovered_loopback_ports_when_enabled() {
        let policy = BrowserActuationPolicy::default();
        assert_eq!(
            evaluate_navigation_url("http://localhost:5173/", &policy, &[5173]),
            PolicyDecision::Allow
        );
        assert!(matches!(
            evaluate_navigation_url("http://localhost:9000/", &policy, &[5173]),
            PolicyDecision::Ask { .. }
        ));

        let disabled = BrowserActuationPolicy {
            auto_allow_discovered_loopback: false,
            ..Default::default()
        };
        assert!(matches!(
            evaluate_navigation_url("http://localhost:5173/", &disabled, &[5173]),
            PolicyDecision::Ask { .. }
        ));
    }

    #[test]
    fn gates_js_eval_according_to_policy() {
        let mut policy = BrowserActuationPolicy::default();
        assert!(matches!(
            evaluate_js_eval("http://localhost:5173/", &policy),
            PolicyDecision::Ask { .. }
        ));

        policy.js_eval_policy = JsEvalPolicy::Allow;
        assert_eq!(
            evaluate_js_eval("http://localhost:5173/", &policy),
            PolicyDecision::Allow
        );
        assert!(matches!(
            evaluate_js_eval("https://checkout.stripe.com/pay", &policy),
            PolicyDecision::PauseForUser {
                kind: SensitivePageKind::Payment,
                ..
            }
        ));

        policy.js_eval_policy = JsEvalPolicy::Deny;
        assert!(matches!(
            evaluate_js_eval("http://localhost:5173/", &policy),
            PolicyDecision::Deny { .. }
        ));
    }

    #[test]
    fn scrubs_headers_and_text_secrets() {
        let mut headers = serde_json::Map::new();
        headers.insert(
            "Authorization".to_string(),
            serde_json::Value::String("Bearer secret-jwt-token".to_string()),
        );
        headers.insert(
            "Cookie".to_string(),
            serde_json::Value::String("sid=abc123; HttpOnly".to_string()),
        );
        headers.insert(
            "X-Api-Key".to_string(),
            serde_json::Value::String("sk_live_1234567890abcdef".to_string()),
        );
        headers.insert(
            "Content-Type".to_string(),
            serde_json::Value::String("application/json".to_string()),
        );

        let scrubbed = scrub_headers(&headers);
        assert_eq!(scrubbed["Authorization"], "[REDACTED]");
        assert_eq!(scrubbed["Cookie"], "[REDACTED]");
        assert_eq!(scrubbed["X-Api-Key"], "[REDACTED]");
        assert_eq!(scrubbed["Content-Type"], "application/json");

        let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
        let raw = format!(
            "Authorization: Bearer abcdef123456\njwt={jwt}\n{{\"password\":\"hunter2\",\"name\":\"alice\"}}\nhttps://app.local/cb?access_token=tok_secret_99&ok=1\nkey=ghp_1234567890abcdefghij123456"
        );
        let cleaned = scrub_text_secrets(&raw);
        assert!(!cleaned.contains("abcdef123456"));
        assert!(!cleaned.contains("dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"));
        assert!(!cleaned.contains("hunter2"));
        assert!(!cleaned.contains("tok_secret_99"));
        assert!(!cleaned.contains("ghp_1234567890abcdefghij123456"));
        assert!(cleaned.contains("\"name\":\"alice\""));
        assert!(cleaned.contains("&ok=1"));
    }

    #[test]
    fn persists_and_updates_policy_file() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let temp_dir = std::env::temp_dir().join(format!(
            "kite_browser_policy_test_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&temp_dir);
        let policy_path = temp_dir.join("nested").join("browser_policy.json");

        std::env::set_var("KITE_BROWSER_POLICY_PATH", &policy_path);

        let initial = load_policy_from_disk().expect("missing file loads default");
        assert!(initial.auto_allow_discovered_loopback);
        assert_eq!(initial.js_eval_policy, JsEvalPolicy::Ask);

        let mut updated = initial;
        add_or_update_rule(&mut updated, "localhost:5173/", PolicyDecision::Allow);
        add_or_update_rule(&mut updated, "LOCALHOST:5173", PolicyDecision::Deny {
            reason: "Revoked".to_string(),
        });
        assert_eq!(updated.rules.len(), 1);
        assert!(matches!(updated.rules[0].decision, PolicyDecision::Deny { .. }));

        save_policy_to_disk(&updated).expect("save policy");
        let reloaded = load_policy_from_disk().expect("reload policy");
        assert_eq!(reloaded, updated);

        std::env::remove_var("KITE_BROWSER_POLICY_PATH");
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
