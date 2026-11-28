use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub const DEFAULT_REMOTE_PORT: u16 = 17420;
pub const PAIRING_TTL_SECS: u64 = 300;
const MAX_PAIRING_ATTEMPTS: u8 = 8;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub id: String,
    pub name: String,
    pub platform: String,
    #[serde(alias = "token_hash_sha256", alias = "tokenHash")]
    pub token_hash_sha256: String,
    #[serde(alias = "created_at_unix_ms")]
    pub created_at_unix_ms: i64,
    #[serde(alias = "last_seen_unix_ms")]
    pub last_seen_unix_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairedDeviceInfo {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub created_at_unix_ms: i64,
    pub last_seen_unix_ms: i64,
    #[serde(default)]
    pub connected: bool,
}

impl From<&PairedDevice> for PairedDeviceInfo {
    fn from(d: &PairedDevice) -> Self {
        Self {
            id: d.id.clone(),
            name: d.name.clone(),
            platform: d.platform.clone(),
            created_at_unix_ms: d.created_at_unix_ms,
            last_seen_unix_ms: d.last_seen_unix_ms,
            connected: false,
        }
    }
}

fn default_port() -> u16 { DEFAULT_REMOTE_PORT }
fn default_bind_mode() -> String { "lan".to_string() }
fn default_tailscale_mode() -> String { "off".to_string() }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGatewayConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_bind_mode", alias = "bind_mode")]
    pub bind_mode: String,
    #[serde(default, alias = "auto_start")]
    pub auto_start: bool,
    #[serde(default, alias = "public_url")]
    pub public_url: Option<String>,
    #[serde(default = "default_tailscale_mode", alias = "tailscale_mode")]
    pub tailscale_mode: String,
    #[serde(default)]
    pub devices: Vec<PairedDevice>,
}

impl Default for RemoteGatewayConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_REMOTE_PORT,
            bind_mode: default_bind_mode(),
            auto_start: false,
            public_url: None,
            tailscale_mode: default_tailscale_mode(),
            devices: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct PairingSession {
    pub code: String,
    pub secret: String,
    pub expires_at_unix_ms: i64,
    pub failed_attempts: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    pub uri: String,
    pub code: String,
    pub secret: String,
    pub host: String,
    pub hosts: Vec<String>,
    pub port: u16,
    pub candidate_urls: Vec<String>,
    pub host_name: String,
    pub expires_at_unix_ms: i64,
    pub ttl_secs: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairError {
    BadRequest(String),
    Unauthorized(String),
    Gone(String),
}

struct AuthState {
    config: RemoteGatewayConfig,
    active_pairing: Option<PairingSession>,
}

pub struct AuthStore {
    config_path: PathBuf,
    state: Mutex<AuthState>,
}

impl AuthStore {
    pub fn default_path() -> PathBuf {
        crate::persist::roaming_app_dir().join("remote-gateway.json")
    }

    pub fn new(config_path: PathBuf) -> Self {
        let mut config = load_config_from_disk(&config_path);
        if config.port == 0 { config.port = DEFAULT_REMOTE_PORT; }
        if config.bind_mode != "lan" && config.bind_mode != "loopback" {
            config.bind_mode = default_bind_mode();
        }
        config.tailscale_mode = crate::remote::tailscale::normalize_tailscale_mode(&config.tailscale_mode)
            .unwrap_or_else(|_| default_tailscale_mode());
        config.public_url = config
            .public_url
            .as_deref()
            .and_then(|u| crate::remote::tailscale::validate_public_url(u).ok().flatten());
        Self { config_path, state: Mutex::new(AuthState { config, active_pairing: None }) }
    }

    fn lock_state(&self) -> MutexGuard<'_, AuthState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn config_snapshot(&self) -> RemoteGatewayConfig {
        self.lock_state().config.clone()
    }

    pub fn configure(
        &self,
        enabled: Option<bool>,
        port: Option<u16>,
        bind_mode: Option<String>,
        auto_start: Option<bool>,
    ) -> Result<RemoteGatewayConfig, String> {
        self.configure_full(enabled, port, bind_mode, auto_start, None, None)
    }

    pub fn configure_full(
        &self,
        enabled: Option<bool>,
        port: Option<u16>,
        bind_mode: Option<String>,
        auto_start: Option<bool>,
        public_url: Option<String>,
        tailscale_mode: Option<String>,
    ) -> Result<RemoteGatewayConfig, String> {
        let validated_public_url = match public_url {
            Some(raw) => Some(crate::remote::tailscale::validate_public_url(&raw)?),
            None => None,
        };
        let validated_tailscale_mode = match tailscale_mode {
            Some(raw) => Some(crate::remote::tailscale::normalize_tailscale_mode(&raw)?),
            None => None,
        };

        let mut guard = self.lock_state();
        if let Some(p) = port {
            if p == 0 { return Err("Port must be between 1 and 65535.".to_string()); }
            guard.config.port = p;
        }
        if let Some(mode) = bind_mode {
            let norm = mode.trim().to_ascii_lowercase();
            if norm != "lan" && norm != "loopback" {
                return Err("bindMode must be 'lan' or 'loopback'.".to_string());
            }
            guard.config.bind_mode = norm;
        }
        if let Some(flag) = enabled { guard.config.enabled = flag; }
        if let Some(flag) = auto_start { guard.config.auto_start = flag; }
        if let Some(next_public_url) = validated_public_url {
            guard.config.public_url = next_public_url;
        }
        if let Some(next_ts_mode) = validated_tailscale_mode {
            guard.config.tailscale_mode = next_ts_mode;
        }
        save_config_to_disk(&self.config_path, &guard.config)?;
        Ok(guard.config.clone())
    }

    pub fn create_pairing(&self, actual_port: Option<u16>) -> Result<PairingInfo, String> {
        self.create_pairing_with_urls(actual_port, None, None, None)
    }

    pub fn create_pairing_with_urls(
        &self,
        actual_port: Option<u16>,
        tailscale_https_url: Option<&str>,
        public_url: Option<&str>,
        tailscale_ipv4: Option<&str>,
    ) -> Result<PairingInfo, String> {
        self.create_pairing_with_ttl_and_urls(
            actual_port,
            PAIRING_TTL_SECS,
            tailscale_https_url,
            public_url,
            tailscale_ipv4,
        )
    }

    pub fn create_pairing_with_ttl(&self, actual_port: Option<u16>, ttl_secs: u64) -> Result<PairingInfo, String> {
        self.create_pairing_with_ttl_and_urls(actual_port, ttl_secs, None, None, None)
    }

    pub fn create_pairing_with_ttl_and_urls(
        &self,
        actual_port: Option<u16>,
        ttl_secs: u64,
        tailscale_https_url: Option<&str>,
        public_url: Option<&str>,
        tailscale_ipv4: Option<&str>,
    ) -> Result<PairingInfo, String> {
        let (bind_mode, port, cfg_public_url) = {
            let guard = self.lock_state();
            (
                guard.config.bind_mode.clone(),
                actual_port.filter(|&p| p > 0).unwrap_or(guard.config.port),
                guard.config.public_url.clone(),
            )
        };
        let effective_public_url = public_url.or(cfg_public_url.as_deref());
        let detected_hosts = detect_candidate_hosts(&bind_mode);
        let hosts = build_pairing_host_entries(
            &bind_mode,
            &detected_hosts,
            tailscale_https_url,
            effective_public_url,
            tailscale_ipv4,
        );
        let candidate_urls = build_candidate_urls(
            &bind_mode,
            port,
            &detected_hosts,
            tailscale_https_url,
            effective_public_url,
            tailscale_ipv4,
        );
        let host = hosts.first().cloned().unwrap_or_else(|| "127.0.0.1".to_string());
        let name = host_name();
        let code = generate_six_digit_code();
        let secret = generate_hex_secret_16();
        let expires_at_unix_ms = now_unix_ms() + (ttl_secs as i64) * 1000;
        let mut qr_name = name.clone();
        let mut qr_hosts = hosts.clone();
        let mut uri = build_pairing_uri(&host, port, &qr_hosts, &code, &secret, &qr_name);
        if uri.len() > 213 && qr_name.len() > 12 {
            qr_name = qr_name.chars().take(12).collect();
            uri = build_pairing_uri(&host, port, &qr_hosts, &code, &secret, &qr_name);
        }
        while uri.len() > 213 && qr_hosts.len() > 2 {
            qr_hosts.pop();
            uri = build_pairing_uri(&host, port, &qr_hosts, &code, &secret, &qr_name);
        }
        self.lock_state().active_pairing = Some(PairingSession {
            code: code.clone(),
            secret: secret.clone(),
            expires_at_unix_ms,
            failed_attempts: 0,
        });
        Ok(PairingInfo { uri, code, secret, host, hosts, port, candidate_urls, host_name: name, expires_at_unix_ms, ttl_secs })
    }

    pub fn has_active_pairing(&self) -> bool {
        let now = now_unix_ms();
        let mut guard = self.lock_state();
        match guard.active_pairing.as_ref() {
            Some(s) if now <= s.expires_at_unix_ms => true,
            Some(_) => { guard.active_pairing = None; false }
            None => false,
        }
    }

    pub fn verify_and_consume_pairing(
        &self,
        code: &str,
        secret: &str,
        device_name: &str,
        platform: &str,
    ) -> Result<(PairedDeviceInfo, String), PairError> {
        let trimmed_name = device_name.trim();
        if trimmed_name.is_empty() || trimmed_name.chars().count() > 128 {
            return Err(PairError::BadRequest("deviceName must be between 1 and 128 characters.".into()));
        }
        let norm_platform = platform.trim().to_ascii_lowercase();
        if !matches!(norm_platform.as_str(), "android" | "ios" | "web") {
            return Err(PairError::BadRequest("platform must be 'android', 'ios', or 'web'.".into()));
        }

        let now = now_unix_ms();
        let mut guard = self.lock_state();
        let Some(session) = guard.active_pairing.as_mut() else {
            return Err(PairError::Gone("No active pairing session. Generate a new QR code.".into()));
        };
        if now > session.expires_at_unix_ms {
            guard.active_pairing = None;
            return Err(PairError::Gone("Pairing session expired. Generate a new QR code.".into()));
        }

        let code_ok = constant_time_eq(code.trim().as_bytes(), session.code.as_bytes());
        let secret_ok = constant_time_eq(secret.trim().as_bytes(), session.secret.as_bytes());
        if !(code_ok & secret_ok) {
            session.failed_attempts = session.failed_attempts.saturating_add(1);
            if session.failed_attempts >= MAX_PAIRING_ATTEMPTS { guard.active_pairing = None; }
            return Err(PairError::Unauthorized("Invalid pairing code or secret.".into()));
        }

        guard.active_pairing = None;
        let device_token = generate_hex_token_32();
        let device = PairedDevice {
            id: Uuid::new_v4().to_string(),
            name: trimmed_name.to_string(),
            platform: norm_platform,
            token_hash_sha256: sha256_hex(device_token.as_bytes()),
            created_at_unix_ms: now,
            last_seen_unix_ms: now,
        };
        let info = PairedDeviceInfo::from(&device);
        guard.config.devices.push(device);
        if let Err(err) = save_config_to_disk(&self.config_path, &guard.config) {
            guard.config.devices.pop();
            return Err(PairError::BadRequest(format!("Failed to persist paired device: {err}")));
        }
        Ok((info, device_token))
    }

    pub fn verify_device_token(&self, token: &str) -> Option<PairedDeviceInfo> {
        let (info, should_persist) = self.verify_device_token_no_io(token)?;
        if should_persist {
            let _ = self.flush_config_to_disk();
        }
        Some(info)
    }

    pub fn verify_device_token_no_io(&self, token: &str) -> Option<(PairedDeviceInfo, bool)> {
        let trimmed = token.trim();
        if trimmed.is_empty() { return None; }
        let candidate_hash = sha256_hex(trimmed.as_bytes());
        let candidate_bytes = candidate_hash.as_bytes();
        let now = now_unix_ms();

        let mut guard = self.lock_state();
        let mut matched_idx: Option<usize> = None;
        for (idx, device) in guard.config.devices.iter().enumerate() {
            if constant_time_eq(candidate_bytes, device.token_hash_sha256.as_bytes()) && matched_idx.is_none() {
                matched_idx = Some(idx);
            }
        }
        let idx = matched_idx?;
        let should_persist = now.saturating_sub(guard.config.devices[idx].last_seen_unix_ms) >= 60_000;
        guard.config.devices[idx].last_seen_unix_ms = now;
        let info = PairedDeviceInfo::from(&guard.config.devices[idx]);
        Some((info, should_persist))
    }

    pub fn flush_config_to_disk(&self) -> Result<(), String> {
        let cfg = self.lock_state().config.clone();
        save_config_to_disk(&self.config_path, &cfg)
    }

    pub fn list_devices(&self) -> Vec<PairedDeviceInfo> {
        self.lock_state().config.devices.iter().map(PairedDeviceInfo::from).collect()
    }

    pub fn device_count(&self) -> usize {
        self.lock_state().config.devices.len()
    }

    pub fn revoke_device(&self, device_id: &str) -> Result<bool, String> {
        let target = device_id.trim();
        if target.is_empty() { return Err("deviceId is required.".to_string()); }
        let mut guard = self.lock_state();
        let before = guard.config.devices.len();
        guard.config.devices.retain(|d| d.id != target);
        let removed = guard.config.devices.len() != before;
        if removed { save_config_to_disk(&self.config_path, &guard.config)?; }
        Ok(removed)
    }

    #[cfg(test)]
    pub(crate) fn expire_active_pairing_for_test(&self) {
        if let Some(session) = self.lock_state().active_pairing.as_mut() {
            session.expires_at_unix_ms = now_unix_ms() - 1000;
        }
    }
}

pub fn now_unix_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn host_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Kite Host".to_string())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    bytes_to_lower_hex(&Sha256::digest(bytes))
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() { return false; }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) { diff |= x ^ y; }
    diff == 0
}

fn bytes_to_lower_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

fn csprng_sha256_bytes() -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(Uuid::new_v4().as_bytes());
    hasher.update(Uuid::new_v4().as_bytes());
    hasher.finalize().into()
}

fn generate_hex_secret_16() -> String { bytes_to_lower_hex(&csprng_sha256_bytes()[..16]) }
fn generate_hex_token_32() -> String { bytes_to_lower_hex(&csprng_sha256_bytes()) }

fn generate_six_digit_code() -> String {
    const LIMIT: u32 = 4_294_000_000;
    loop {
        let b = *Uuid::new_v4().as_bytes();
        let val = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
        if val < LIMIT { return format!("{:06}", val % 1_000_000); }
    }
}

pub fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for &b in input.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            use std::fmt::Write as _;
            let _ = write!(&mut out, "%{b:02X}");
        }
    }
    out
}

pub fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn is_tailscale_ipv4_str(raw: &str) -> bool {
    raw.trim()
        .parse::<Ipv4Addr>()
        .ok()
        .is_some_and(is_tailscale_cgnat)
}

fn push_unique_trimmed(out: &mut Vec<String>, seen: &mut HashSet<String>, raw: &str) {
    let normalized = raw.trim().trim_end_matches('/').to_string();
    if !normalized.is_empty() && seen.insert(normalized.clone()) {
        out.push(normalized);
    }
}

pub fn build_candidate_urls(
    bind_mode: &str,
    port: u16,
    detected_hosts: &[String],
    tailscale_https_url: Option<&str>,
    public_url: Option<&str>,
    tailscale_ipv4: Option<&str>,
) -> Vec<String> {
    let mut urls = Vec::new();
    let mut seen = HashSet::new();

    if bind_mode != "loopback" {
        for host in detected_hosts {
            let trimmed = host.trim();
            if trimmed.is_empty() || trimmed == "127.0.0.1" || is_tailscale_ipv4_str(trimmed) {
                continue;
            }
            push_unique_trimmed(&mut urls, &mut seen, &format!("http://{trimmed}:{port}"));
        }
    }

    if let Some(https_url) = tailscale_https_url {
        push_unique_trimmed(&mut urls, &mut seen, https_url);
    }
    if let Some(pub_url) = public_url {
        push_unique_trimmed(&mut urls, &mut seen, pub_url);
    }

    if bind_mode != "loopback" {
        if let Some(ts_ip) = tailscale_ipv4.map(str::trim).filter(|s| !s.is_empty()) {
            push_unique_trimmed(&mut urls, &mut seen, &format!("http://{ts_ip}:{port}"));
        }
        for host in detected_hosts {
            let trimmed = host.trim();
            if is_tailscale_ipv4_str(trimmed) {
                push_unique_trimmed(&mut urls, &mut seen, &format!("http://{trimmed}:{port}"));
            }
        }
    }

    if bind_mode == "loopback" || urls.is_empty() {
        push_unique_trimmed(&mut urls, &mut seen, &format!("http://127.0.0.1:{port}"));
    }

    urls
}

pub fn build_pairing_host_entries(
    bind_mode: &str,
    detected_hosts: &[String],
    tailscale_https_url: Option<&str>,
    public_url: Option<&str>,
    tailscale_ipv4: Option<&str>,
) -> Vec<String> {
    let mut hosts = Vec::new();
    let mut seen = HashSet::new();

    if bind_mode != "loopback" {
        for host in detected_hosts {
            let trimmed = host.trim();
            if trimmed.is_empty() || trimmed == "127.0.0.1" || is_tailscale_ipv4_str(trimmed) {
                continue;
            }
            push_unique_trimmed(&mut hosts, &mut seen, trimmed);
        }
    }

    if let Some(https_url) = tailscale_https_url {
        push_unique_trimmed(&mut hosts, &mut seen, https_url);
    }
    if let Some(pub_url) = public_url {
        push_unique_trimmed(&mut hosts, &mut seen, pub_url);
    }

    if bind_mode != "loopback" {
        if let Some(ts_ip) = tailscale_ipv4.map(str::trim).filter(|s| !s.is_empty()) {
            push_unique_trimmed(&mut hosts, &mut seen, ts_ip);
        }
        for host in detected_hosts {
            let trimmed = host.trim();
            if is_tailscale_ipv4_str(trimmed) {
                push_unique_trimmed(&mut hosts, &mut seen, trimmed);
            }
        }
    }

    if bind_mode == "loopback" || hosts.is_empty() {
        push_unique_trimmed(&mut hosts, &mut seen, "127.0.0.1");
    }

    hosts
}

pub fn build_pairing_uri(primary_host: &str, port: u16, hosts: &[String], code: &str, secret: &str, host_name: &str) -> String {
    let csv_hosts = if hosts.is_empty() {
        percent_encode(primary_host)
    } else {
        hosts.iter().map(|h| percent_encode(h)).collect::<Vec<_>>().join(",")
    };
    format!(
        "kite-remote://pair?v=1&host={}&port={}&hosts={}&code={}&secret={}&name={}",
        percent_encode(primary_host), port, csv_hosts, percent_encode(code), percent_encode(secret), percent_encode(host_name),
    )
}

pub fn is_tailscale_cgnat(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 100 && (64..=127).contains(&b)
}

pub fn parse_tailscale_ipv4_from_text(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    for raw in text.split(|c: char| !c.is_ascii_digit() && c != '.') {
        if raw.is_empty() || raw.matches('.').count() != 3 { continue; }
        if let Ok(ip) = raw.parse::<Ipv4Addr>() {
            if is_tailscale_cgnat(ip) && seen.insert(ip.to_string()) { found.push(ip.to_string()); }
        }
    }
    found
}

fn detect_primary_lan_ipv4() -> Option<Ipv4Addr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    match sock.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() && !ip.is_link_local() => Some(ip),
        _ => None,
    }
}

fn detect_tailscale_ipv4s() -> Vec<String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if let Ok(out) = std::process::Command::new("ipconfig").creation_flags(CREATE_NO_WINDOW).output() {
            return parse_tailscale_ipv4_from_text(&String::from_utf8_lossy(&out.stdout));
        }
        Vec::new()
    }
    #[cfg(not(windows))]
    {
        if let Ok(out) = std::process::Command::new("tailscale").args(["ip", "-4"]).output() {
            if out.status.success() { return parse_tailscale_ipv4_from_text(&String::from_utf8_lossy(&out.stdout)); }
        }
        Vec::new()
    }
}

pub fn detect_candidate_hosts(bind_mode: &str) -> Vec<String> {
    if bind_mode == "loopback" { return vec!["127.0.0.1".to_string()]; }
    let mut hosts = Vec::new();
    let mut seen = HashSet::new();
    if let Some(primary) = detect_primary_lan_ipv4() {
        if !is_tailscale_cgnat(primary) && seen.insert(primary.to_string()) { hosts.push(primary.to_string()); }
    }
    for ts in detect_tailscale_ipv4s() {
        if seen.insert(ts.clone()) { hosts.push(ts); }
    }
    if hosts.is_empty() {
        hosts.push(detect_primary_lan_ipv4().map(|ip| ip.to_string()).unwrap_or_else(|| "127.0.0.1".into()));
    }
    hosts
}

fn load_config_from_disk(path: &Path) -> RemoteGatewayConfig {
    std::fs::read_to_string(path).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

fn save_config_to_disk(path: &Path, config: &RemoteGatewayConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed creating config directory: {e}"))?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| format!("Failed serializing config: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| format!("Failed writing temp config: {e}"))?;
    if std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        std::fs::write(path, &json).map_err(|e| format!("Failed writing config: {e}"))?;
    }
    Ok(())
}
