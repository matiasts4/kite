use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Deterministic fast token estimator (~4 chars per token).
///
/// Using character-aligned ceil division avoids pulling heavy BPE tokenizers
/// into memory while staying consistent across pre/post savings ratios.
pub fn estimate_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    text.chars().count().div_ceil(4)
}

/// Compute lowercase hex SHA-256 digest of arbitrary UTF-8 text.
pub fn sha256_hex(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}

/// Compute a truncated 16-hex-char SHA-256 identifier (64 bits, compact for markers).
pub fn short_hash(text: &str) -> String {
    let full = sha256_hex(text);
    full[..16].to_string()
}

/// Canonical savings summary produced by every compression or reuse operation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SavingsReceipt {
    pub raw_tokens: usize,
    pub compressed_tokens: usize,
    pub tokens_saved: usize,
    pub strategy: String,
    pub cache_hit: bool,
    pub ccr_hash: Option<String>,
}

impl SavingsReceipt {
    pub fn new(raw: &str, compressed: &str, strategy: impl Into<String>) -> Self {
        let raw_tokens = estimate_tokens(raw);
        let compressed_tokens = estimate_tokens(compressed);
        Self {
            raw_tokens,
            compressed_tokens,
            tokens_saved: raw_tokens.saturating_sub(compressed_tokens),
            strategy: strategy.into(),
            cache_hit: false,
            ccr_hash: None,
        }
    }

    pub fn savings_percent(&self) -> f64 {
        if self.raw_tokens == 0 {
            return 0.0;
        }
        (self.tokens_saved as f64 / self.raw_tokens as f64) * 100.0
    }
}
