//! `kite-ctx` — Zero-ML modular context optimization and token-reuse engine.
//!
//! Designed as a standalone Cargo workspace crate so both the `kite` CLI binary
//! and the `kite-code` desktop application share one low-footprint SQLite store
//! without spawning per-agent Python processes or HTTP proxies.

pub mod audit;
pub mod browser_cache;
pub mod browser_recipes;
pub mod ccr_store;
pub mod cmd_filters;
pub mod crusher;
pub mod discover;
pub mod error;
pub mod hooks;
pub mod kv_aligner;
pub mod ledger;
pub mod lossless;
pub mod mcp_proxy;
pub mod pipeline;
pub mod read_cache;
pub mod shared_ctx;
pub mod store;
pub mod tokens;

use std::path::Path;
use std::time::Instant;

use serde::{Deserialize, Serialize};

pub use audit::{
    audit_host_prompts, fix_host_prompts, PromptAuditFinding, PromptAuditFixResult,
    PromptAuditSummary,
};
pub use browser_cache::{
    canonicalize_route, compute_ax_hashes, extract_origin, parse_ax_snapshot_text,
    redact_sensitive_browser_text, AxNode, BrowserReadCache, BrowserReadMode, BrowserSnapshotInput,
    BrowserSnapshotOutcome, BrowserSnapshotResult,
};
pub use browser_recipes::{
    BrowserActionStep, BrowserRecipe, BrowserRecipeStore, LocatorSpec, RecipeLookupResult,
};
pub use ccr_store::{CcrEntry, CcrRetrieveResult, CcrStore, DEFAULT_RETRIEVE_MAX_CHARS};
pub use cmd_filters::{
    apply_custom_filter_rules, canonical_command_label, filter_command_output,
    filter_command_output_with_ccr, load_custom_filter_rules, normalize_bin_name,
    resolve_subcommand_for_bin, resolve_subcommand_index, CustomFilterRule, FilterOutput,
};

pub const MAX_EXEC_OUTPUT_CHARS: usize = 16_000;
pub use crusher::{CrushResult, CrusherConfig, DataPattern, SmartCrusher};
pub use discover::{discover_from_host, scan_command_strings, DiscoverCandidate, DiscoverySummary};
pub use error::{CtxError, Result};
pub use hooks::{
    apply_agent_setup, evaluate_hook_input, evaluate_pre_tool_use_json, resolve_home_dir,
    rewrite_hook_command, AgentTarget, HookInstallAction,
};
pub use kv_aligner::{
    evaluate_net_cost, scan_volatile_tokens, CacheEconomics, KvAligner, LiveZonePlan,
    NetCostDecision, VolatileCategory, VolatileFinding,
};
pub use ledger::{
    normalize_feature_name, AgentBreakdown, CategoryBreakdown, FeatureBreakdown, LedgerEventInput,
    ModelBreakdown, MonitorSnapshot, QuotaPreservation, SavingsLedger, TotalsSummary,
};
pub use lossless::{compact_lossless, elide_svg_and_style_noise, strip_ansi, LosslessStrategy};
pub use mcp_proxy::{
    compress_mcp_jsonrpc_line, compress_mcp_jsonrpc_line_stateful, run_mcp_stdio_proxy,
    McpProxySessionState, McpToolCallMeta, DEFAULT_MCP_MIN_BYTES,
};
pub use pipeline::{detect_content_kind, CompressedPayload, CompressionStrategy, ContentKind};
pub use read_cache::{ReadCache, ReadMode, ReadResult, ReadStatus};
pub use shared_ctx::{ContextScope, SharedContextStore, SharedEntry, ToolCacheEntry};
pub use store::{
    default_db_path, now_unix_secs, ContextStore, CURRENT_SCHEMA_VERSION, ENV_DB_PATH,
};
pub use tokens::{estimate_tokens, sha256_hex, short_hash, SavingsReceipt};

/// Result produced by [`ContextEngine::pack_voice_context_with_budget`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VoiceContextPack {
    pub text: String,
    pub original_tokens: usize,
    pub compressed_tokens: usize,
    pub ccr_hash: Option<String>,
}

/// Top-level coordinator wrapping all context optimization subsystems on a shared [`ContextStore`].
#[derive(Clone)]
pub struct ContextEngine {
    store: ContextStore,
    ccr: CcrStore,
    reads: ReadCache,
    shared: SharedContextStore,
    kv: KvAligner,
    ledger: SavingsLedger,
    browser_cache: BrowserReadCache,
    browser_recipes: BrowserRecipeStore,
}

impl ContextEngine {
    pub fn open_default() -> Result<Self> {
        Self::from_store(ContextStore::open_default()?)
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::from_store(ContextStore::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::from_store(ContextStore::open_in_memory()?)
    }

    fn from_store(store: ContextStore) -> Result<Self> {
        let ccr = CcrStore::new(store.clone());
        let reads = ReadCache::new(store.clone());
        let shared = SharedContextStore::new(store.clone());
        let kv = KvAligner::new(store.clone());
        let ledger = SavingsLedger::new(store.clone());
        let browser_cache = BrowserReadCache::new(store.clone());
        let browser_recipes = BrowserRecipeStore::new(store.clone());
        Ok(Self {
            store,
            ccr,
            reads,
            shared,
            kv,
            ledger,
            browser_cache,
            browser_recipes,
        })
    }

    pub fn store(&self) -> &ContextStore {
        &self.store
    }

    pub fn ccr(&self) -> &CcrStore {
        &self.ccr
    }

    pub fn reads(&self) -> &ReadCache {
        &self.reads
    }

    pub fn shared(&self) -> &SharedContextStore {
        &self.shared
    }

    pub fn kv(&self) -> &KvAligner {
        &self.kv
    }

    pub fn ledger(&self) -> &SavingsLedger {
        &self.ledger
    }

    pub fn browser_cache(&self) -> &BrowserReadCache {
        &self.browser_cache
    }

    pub fn browser_recipes(&self) -> &BrowserRecipeStore {
        &self.browser_recipes
    }

    /// Compress arbitrary text through `SmartCrusher` (JSON) or Stage-0 lossless folds,
    /// persisting a ledger event for observability.
    pub fn compress_text(
        &self,
        input: &str,
        kind_override: ContentKind,
        session_id: &str,
        agent: &str,
        provider: &str,
        model: &str,
    ) -> Result<CompressedPayload> {
        let start = Instant::now();
        let kind = match kind_override {
            ContentKind::Auto => detect_content_kind(input),
            explicit => explicit,
        };

        let (text, strategy, ccr_hash) = match kind {
            ContentKind::Json => {
                let crushed = SmartCrusher::default().crush(input, Some(&self.ccr))?;
                (crushed.output, crushed.stage.to_string(), crushed.ccr_hash)
            }
            other => {
                let compacted = compact_lossless(input, other);
                (compacted, format!("lossless:{other:?}"), None)
            }
        };

        let mut receipt = SavingsReceipt::new(input, &text, strategy);
        receipt.ccr_hash = ccr_hash;

        self.ledger.record(&LedgerEventInput {
            session_id: session_id.to_string(),
            agent: agent.to_string(),
            provider: provider.to_string(),
            model: model.to_string(),
            category: "compress".to_string(),
            command_or_tool: receipt.strategy.clone(),
            raw_tokens: receipt.raw_tokens,
            compressed_tokens: receipt.compressed_tokens,
            cache_hit: false,
            overhead_ms: start.elapsed().as_millis() as u64,
        })?;

        Ok(CompressedPayload {
            text,
            kind,
            receipt,
        })
    }

    /// Read a file with session SHA-256 deduplication and record telemetry.
    #[allow(clippy::too_many_arguments)]
    pub fn read_file_with_telemetry(
        &self,
        session_id: &str,
        path: impl AsRef<Path>,
        mode: ReadMode,
        fresh: bool,
        agent: &str,
        provider: &str,
        model: &str,
    ) -> Result<ReadResult> {
        let start = Instant::now();
        let res = self.reads.read_file(session_id, path, mode, fresh)?;
        self.ledger.record(&LedgerEventInput {
            session_id: session_id.to_string(),
            agent: agent.to_string(),
            provider: provider.to_string(),
            model: model.to_string(),
            category: "read".to_string(),
            command_or_tool: format!("read:{}", res.mode),
            raw_tokens: res.raw_tokens,
            compressed_tokens: res.delivered_tokens,
            cache_hit: res.deduplicated,
            overhead_ms: start.elapsed().as_millis() as u64,
        })?;
        Ok(res)
    }

    /// Filter captured command output, enforcing the universal Auto-CCR spill ceiling,
    /// and record ledger telemetry.
    #[allow(clippy::too_many_arguments)]
    pub fn filter_command_with_telemetry(
        &self,
        command: &[String],
        stdout: &str,
        stderr: &str,
        exit_code: i32,
        session_id: &str,
        agent: &str,
        provider: &str,
        model: &str,
    ) -> Result<FilterOutput> {
        let start = Instant::now();
        let raw_combined = cmd_filters::merge_streams(stdout, stderr);
        let raw_tokens = estimate_tokens(&raw_combined);
        let mut filtered =
            filter_command_output_with_ccr(command, stdout, stderr, exit_code, Some(&self.ccr));

        let cmd_label = cmd_filters::canonical_command_label(command);
        let label_for_ccr = if cmd_label.is_empty() {
            filtered.filter_name.to_string()
        } else {
            cmd_label.clone()
        };

        if filtered.text.chars().count() > MAX_EXEC_OUTPUT_CHARS {
            let source_for_ccr = if raw_combined.is_empty() {
                filtered.text.as_str()
            } else {
                raw_combined.as_str()
            };
            filtered.text = spill_oversized_exec_output(
                source_for_ccr,
                &filtered.text,
                &label_for_ccr,
                &self.ccr,
                MAX_EXEC_OUTPUT_CHARS,
            );
            filtered.compressed = filtered.text.len() < raw_combined.len();
        }

        let compressed_tokens = estimate_tokens(&filtered.text);

        self.ledger.record(&LedgerEventInput {
            session_id: session_id.to_string(),
            agent: agent.to_string(),
            provider: provider.to_string(),
            model: model.to_string(),
            category: "exec".to_string(),
            command_or_tool: label_for_ccr,
            raw_tokens,
            compressed_tokens,
            cache_hit: false,
            overhead_ms: start.elapsed().as_millis() as u64,
        })?;

        Ok(filtered)
    }

    /// Store a compressed inter-agent handoff and record telemetry.
    #[allow(clippy::too_many_arguments)]
    pub fn share_put_with_telemetry(
        &self,
        scope: ContextScope,
        scope_id: &str,
        key: &str,
        content: &str,
        source_agent: &str,
        source_provider: &str,
        tree_hash: Option<&str>,
        session_id: &str,
        model: &str,
    ) -> Result<SharedEntry> {
        let start = Instant::now();
        let entry = self.shared.put(
            scope,
            scope_id,
            key,
            content,
            source_agent,
            source_provider,
            tree_hash,
        )?;
        self.ledger.record(&LedgerEventInput {
            session_id: session_id.to_string(),
            agent: source_agent.to_string(),
            provider: source_provider.to_string(),
            model: model.to_string(),
            category: "share".to_string(),
            command_or_tool: "share:put".to_string(),
            raw_tokens: entry.original_tokens,
            compressed_tokens: entry.compressed_tokens,
            cache_hit: false,
            overhead_ms: start.elapsed().as_millis() as u64,
        })?;
        Ok(entry)
    }

    /// Retrieve a shared inter-agent handoff and record cache-reuse telemetry.
    #[allow(clippy::too_many_arguments)]
    pub fn share_get_with_telemetry(
        &self,
        scope: ContextScope,
        scope_id: &str,
        key: &str,
        full: bool,
        session_id: &str,
        agent: &str,
        provider: &str,
        model: &str,
    ) -> Result<Option<String>> {
        let start = Instant::now();
        let Some(entry) = self.shared.get_entry(scope, scope_id, key)? else {
            return Ok(None);
        };
        let text = if !full {
            entry.compressed_text.clone()
        } else {
            match self.ccr.retrieve(&entry.ccr_hash) {
                Ok(orig) => orig.original_text,
                Err(_) => entry.compressed_text.clone(),
            }
        };
        let compressed_tokens = if full {
            entry.original_tokens
        } else {
            entry.compressed_tokens
        };
        self.ledger.record(&LedgerEventInput {
            session_id: session_id.to_string(),
            agent: agent.to_string(),
            provider: provider.to_string(),
            model: model.to_string(),
            category: "share".to_string(),
            command_or_tool: if full {
                "share:get_full".to_string()
            } else {
                "share:get".to_string()
            },
            raw_tokens: entry.original_tokens,
            compressed_tokens,
            cache_hit: true,
            overhead_ms: start.elapsed().as_millis() as u64,
        })?;
        Ok(Some(text))
    }

    /// Retrieve a full or sliced CCR payload and record honest retrieval cost telemetry.
    #[allow(clippy::too_many_arguments)]
    pub fn retrieve_ccr_with_telemetry(
        &self,
        hash: &str,
        line_range: Option<(usize, usize)>,
        search: Option<&str>,
        session_id: &str,
        agent: &str,
        provider: &str,
        model: &str,
    ) -> Result<CcrRetrieveResult> {
        self.retrieve_ccr_with_options(
            hash,
            line_range,
            search,
            false,
            0,
            session_id,
            agent,
            provider,
            model,
        )
    }

    /// Retrieve a bounded, FTS5/BM25-searched, or forced-full CCR payload and record
    /// honest delivered token cost (`tokens_saved = 0`, `cache_hit = false`) so CCR
    /// never double-counts compression savings or inflates cache hit rate.
    #[allow(clippy::too_many_arguments)]
    pub fn retrieve_ccr_with_options(
        &self,
        hash: &str,
        line_range: Option<(usize, usize)>,
        search: Option<&str>,
        force_full: bool,
        context_lines: usize,
        session_id: &str,
        agent: &str,
        provider: &str,
        model: &str,
    ) -> Result<CcrRetrieveResult> {
        let start = Instant::now();
        let res = self.ccr.retrieve_filtered_with_options(
            hash,
            line_range,
            search,
            force_full,
            context_lines,
        )?;
        let delivered_tokens = estimate_tokens(&res.content);
        self.ledger.record(&LedgerEventInput {
            session_id: session_id.to_string(),
            agent: agent.to_string(),
            provider: provider.to_string(),
            model: model.to_string(),
            category: "ccr".to_string(),
            command_or_tool: "ccr:retrieve".to_string(),
            raw_tokens: delivered_tokens,
            compressed_tokens: delivered_tokens,
            cache_hit: false,
            overhead_ms: start.elapsed().as_millis() as u64,
        })?;
        Ok(res)
    }

    /// Look up cached compressed output for a HEAD-immutable read-only git command (`log`, `show`, `ls-files`).
    #[allow(clippy::too_many_arguments)]
    pub fn try_exec_tool_cache(
        &self,
        command: &[String],
        cwd: &Path,
        session_id: &str,
        agent: &str,
        provider: &str,
        model: &str,
    ) -> Result<Option<String>> {
        let Some((ws_root, state_hash, label, args_key)) =
            cacheable_git_exec_key(command, cwd)
        else {
            return Ok(None);
        };
        let start = Instant::now();
        let Some(hit) = self
            .shared
            .get_tool_cache(&ws_root, &state_hash, &label, &args_key)?
        else {
            return Ok(None);
        };
        let _ = self.ledger.record(&LedgerEventInput {
            session_id: session_id.to_string(),
            agent: agent.to_string(),
            provider: provider.to_string(),
            model: model.to_string(),
            category: "exec".to_string(),
            command_or_tool: format!("cache:{label}"),
            raw_tokens: hit.raw_tokens,
            compressed_tokens: hit.compressed_tokens,
            cache_hit: true,
            overhead_ms: start.elapsed().as_millis() as u64,
        });
        Ok(Some(hit.compressed_output))
    }

    /// Persist a filtered `exec` output into `tool_cache` if the command is HEAD-immutable.
    pub fn store_exec_tool_cache(
        &self,
        command: &[String],
        cwd: &Path,
        compressed_output: &str,
        raw_tokens: usize,
    ) -> Result<bool> {
        let Some((ws_root, state_hash, label, args_key)) =
            cacheable_git_exec_key(command, cwd)
        else {
            return Ok(false);
        };
        self.shared.put_tool_cache_prebuilt(
            &ws_root,
            &state_hash,
            &label,
            &args_key,
            compressed_output,
            raw_tokens,
        )?;
        Ok(true)
    }

    /// Compress an in-process runtime text segment (thread history turn, tool call output,
    /// or subagent handoff body) when it exceeds `max_chars` or contains compressible
    /// repetition, storing the full original in `ccr_store` with a `<<ccr:HASH>>` marker
    /// and preserving head + tail anchors.
    #[allow(clippy::too_many_arguments)]
    pub fn compress_runtime_segment(
        &self,
        text: &str,
        max_chars: usize,
        feature_key: &str,
        session_id: &str,
        agent: &str,
        provider: &str,
        model: &str,
    ) -> Result<String> {
        let trimmed = text.trim();
        let char_count = trimmed.chars().count();
        if char_count <= max_chars && trimmed.len() <= 800 {
            return Ok(trimmed.to_string());
        }

        let start = Instant::now();
        let kind = detect_content_kind(trimmed);
        let stage_one = match kind {
            ContentKind::Json => match SmartCrusher::default().crush(trimmed, Some(&self.ccr)) {
                Ok(crushed) => crushed.output,
                Err(_) => compact_lossless(trimmed, kind),
            },
            other => compact_lossless(trimmed, other),
        };

        let stage_chars = stage_one.chars().count();
        let final_text = if stage_chars <= max_chars {
            stage_one
        } else {
            let head_budget = (max_chars * 2 / 3).max(160);
            let tail_budget = (max_chars / 4).max(80);
            let head: String = stage_one.chars().take(head_budget).collect();
            let tail: String = stage_one
                .chars()
                .rev()
                .take(tail_budget)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            let preview = format!("{}\n...\n{}", head.trim_end(), tail.trim_start());
            let ccr_hash = self
                .ccr
                .put(trimmed, &preview, "runtime_segment", feature_key)
                .ok();
            let omitted_chars = char_count.saturating_sub(head_budget + tail_budget);
            match ccr_hash {
                Some(h) => format!(
                    "{}\n... [compressed {} chars by kite-ctx — run `kite ctx retrieve {} --search <term>` or `--lines N-M`] <<ccr:{}>> ...\n{}",
                    head.trim_end(),
                    omitted_chars,
                    h,
                    h,
                    tail.trim_start()
                ),
                None => format!(
                    "{}\n... [compressed {} chars by kite-ctx] ...\n{}",
                    head.trim_end(),
                    omitted_chars,
                    tail.trim_start()
                ),
            }
        };

        let raw_tokens = estimate_tokens(trimmed);
        let compressed_tokens = estimate_tokens(&final_text);
        if compressed_tokens < raw_tokens {
            let _ = self.ledger.record(&LedgerEventInput {
                session_id: session_id.to_string(),
                agent: agent.to_string(),
                provider: provider.to_string(),
                model: model.to_string(),
                category: "runtime".to_string(),
                command_or_tool: feature_key.to_string(),
                raw_tokens,
                compressed_tokens,
                cache_hit: false,
                overhead_ms: start.elapsed().as_millis() as u64,
            });
            Ok(final_text)
        } else {
            Ok(trimmed.to_string())
        }
    }

    /// Pack dynamic voice context under `CrusherConfig::voice()` (`< 250` tokens by default),
    /// applying Stage-0 lossless folding or Stage-1 JSON crushing followed by bounded head+tail fitting.
    pub fn pack_voice_context(&self, text: &str) -> Result<String> {
        self.pack_voice_context_with_budget(text, None)
            .map(|pack| pack.text)
    }

    /// Pack dynamic voice context with an optional explicit token ceiling (defaults to `CrusherConfig::voice().max_tokens`),
    /// returning the compressed text alongside original/compressed token counts and optional CCR hash.
    pub fn pack_voice_context_with_budget(
        &self,
        text: &str,
        max_tokens: Option<usize>,
    ) -> Result<VoiceContextPack> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(VoiceContextPack {
                text: String::new(),
                original_tokens: 0,
                compressed_tokens: 0,
                ccr_hash: None,
            });
        }

        let start = Instant::now();
        let original_tokens = estimate_tokens(trimmed);
        let config = CrusherConfig::voice();
        let kind = detect_content_kind(trimmed);
        let crusher = SmartCrusher::new(config);

        let (stage_one, mut ccr_hash) = match kind {
            ContentKind::Json => {
                let crushed = crusher.crush(trimmed, Some(&self.ccr))?;
                (crushed.output, crushed.ccr_hash)
            }
            other => (compact_lossless(trimmed, other), None),
        };

        let (final_text, fit_hash) =
            crusher.fit_budget(&stage_one, max_tokens, Some(&self.ccr), trimmed);
        if fit_hash.is_some() {
            ccr_hash = fit_hash;
        }
        let compressed_tokens = estimate_tokens(&final_text);

        let _ = self.ledger.record(&LedgerEventInput {
            session_id: "argos-voice".to_string(),
            agent: "Argos".to_string(),
            provider: "local".to_string(),
            model: "voice_pack".to_string(),
            category: "voice".to_string(),
            command_or_tool: "voice:pack".to_string(),
            raw_tokens: original_tokens,
            compressed_tokens,
            cache_hit: false,
            overhead_ms: start.elapsed().as_millis() as u64,
        });

        Ok(VoiceContextPack {
            text: final_text,
            original_tokens,
            compressed_tokens,
            ccr_hash,
        })
    }
}

fn cacheable_git_exec_key(
    command: &[String],
    cwd: &Path,
) -> Option<(String, String, String, String)> {
    let first = command.first()?;
    if cmd_filters::normalize_bin_name(first) != "git" {
        return None;
    }
    let rest = &command[1..];
    let (sub_idx, sub) = cmd_filters::resolve_subcommand_for_bin("git", rest)?;
    if !matches!(sub.as_str(), "log" | "show" | "ls-files") {
        return None;
    }
    // Skip flags that inspect remote/working-tree/all refs beyond HEAD + index.
    let after_sub = &rest[sub_idx + 1..];
    let mut after_double_dash = false;
    let mut skip_next_val = false;
    for arg in after_sub {
        if after_double_dash {
            continue;
        }
        if skip_next_val {
            skip_next_val = false;
            continue;
        }
        if arg == "--" {
            after_double_dash = true;
            continue;
        }
        if matches!(
            arg.as_str(),
            "--all"
                | "--branches"
                | "--remotes"
                | "--tags"
                | "--glob"
                | "--with-tree"
                | "-o"
                | "--others"
                | "-m"
                | "--modified"
                | "-d"
                | "--deleted"
                | "-u"
                | "--untracked"
                | "--watch"
        ) || arg.starts_with("--with-tree=")
        {
            return None;
        }
        if arg.starts_with('-') {
            if matches!(
                arg.as_str(),
                "-n" | "--max-count"
                    | "--skip"
                    | "--since"
                    | "--after"
                    | "--until"
                    | "--before"
                    | "--author"
                    | "--committer"
                    | "--grep"
                    | "-S"
                    | "-G"
                    | "--format"
                    | "--pretty"
                    | "-L"
                    | "-U"
                    | "--unified"
            ) {
                skip_next_val = true;
            }
            continue;
        }
        // Only cache pure HEAD-anchored `log` / `show` calls (no arbitrary branch, stash, or range refs).
        if matches!(sub.as_str(), "log" | "show") {
            let is_hex_sha = arg.len() >= 4
                && arg.len() <= 40
                && arg.bytes().all(|b| b.is_ascii_hexdigit());
            if arg != "HEAD" && !is_hex_sha {
                return None;
            }
        }
    }

    let mut target_dir = cwd.to_path_buf();
    let mut i = 0usize;
    while i < rest.len() {
        if rest[i] == "-C" {
            if let Some(dir) = rest.get(i + 1) {
                let p = Path::new(dir);
                target_dir = if p.is_absolute() {
                    p.to_path_buf()
                } else {
                    target_dir.join(p)
                };
            }
            i += 2;
            continue;
        }
        i += 1;
    }

    let git_dir = resolve_git_dir(&target_dir)?;
    let common_dir = resolve_git_common_dir(&git_dir);
    let state_hash = git_head_and_index_fingerprint(&git_dir, &common_dir)?;
    let ws_base = git_dir.parent().unwrap_or(&target_dir);
    let ws_root = std::fs::canonicalize(ws_base)
        .unwrap_or_else(|_| ws_base.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/");
    let norm_cwd = std::fs::canonicalize(&target_dir)
        .unwrap_or_else(|_| target_dir.clone())
        .to_string_lossy()
        .replace('\\', "/");
    let label = cmd_filters::canonical_command_label(command);
    let args_key = format!("cwd:{norm_cwd}\u{0}{}", rest.join("\u{0}"));
    Some((ws_root, state_hash, label, args_key))
}

fn resolve_git_dir(start: &Path) -> Option<std::path::PathBuf> {
    for ancestor in start.ancestors().take(6) {
        let dot_git = ancestor.join(".git");
        if dot_git.is_dir() {
            return Some(dot_git);
        }
        if dot_git.is_file() {
            if let Ok(raw) = std::fs::read_to_string(&dot_git) {
                if let Some(rel) = raw.trim().strip_prefix("gitdir:") {
                    let p = Path::new(rel.trim());
                    return Some(if p.is_absolute() {
                        p.to_path_buf()
                    } else {
                        ancestor.join(p)
                    });
                }
            }
        }
    }
    None
}

fn resolve_git_common_dir(git_dir: &Path) -> std::path::PathBuf {
    let commondir_file = git_dir.join("commondir");
    if let Ok(raw) = std::fs::read_to_string(&commondir_file) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let p = Path::new(trimmed);
            return if p.is_absolute() {
                p.to_path_buf()
            } else {
                git_dir.join(p)
            };
        }
    }
    git_dir.to_path_buf()
}

fn git_head_and_index_fingerprint(git_dir: &Path, common_dir: &Path) -> Option<String> {
    let head_path = git_dir.join("HEAD");
    let head_raw = std::fs::read_to_string(&head_path).ok()?;
    let head_trimmed = head_raw.trim();
    let mut parts = vec![head_trimmed.to_string()];

    if let Some(ref_rel) = head_trimmed.strip_prefix("ref:") {
        let trimmed_ref = ref_rel.trim();
        let local_ref = git_dir.join(trimmed_ref);
        let shared_ref = common_dir.join(trimmed_ref);
        if let Ok(ref_val) = std::fs::read_to_string(&local_ref) {
            parts.push(ref_val.trim().to_string());
        } else if let Ok(ref_val) = std::fs::read_to_string(&shared_ref) {
            parts.push(ref_val.trim().to_string());
        } else {
            parts.push(file_mtime_stamp(&shared_ref));
        }
        parts.push(file_mtime_stamp(&common_dir.join("packed-refs")));
    }
    parts.push(file_mtime_stamp(&git_dir.join("index")));
    Some(sha256_hex(&parts.join("|")))
}

fn file_mtime_stamp(path: &Path) -> String {
    match std::fs::metadata(path) {
        Ok(m) => {
            let nanos = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            format!("{}:{nanos}", m.len())
        }
        Err(_) => "missing".to_string(),
    }
}

fn spill_oversized_exec_output(
    raw_source: &str,
    current_text: &str,
    label: &str,
    ccr: &CcrStore,
    max_chars: usize,
) -> String {
    let total_chars = current_text.chars().count();
    let lines: Vec<&str> = current_text.lines().collect();

    let head_budget = 4_500usize.min(max_chars / 3);
    let anomaly_budget = 3_500usize.min(max_chars / 4);
    let tail_budget = 3_500usize.min(max_chars / 4);

    let (head, head_end_idx, tail, tail_start_idx) = if lines.len() <= 2 {
        let head_str: String = current_text.chars().take(head_budget).collect();
        let tail_str: String = current_text
            .chars()
            .rev()
            .take(tail_budget)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        (head_str, 0, tail_str, lines.len())
    } else {
        let mut head_lines = Vec::new();
        let mut head_chars = 0usize;
        let mut h_idx = 0usize;
        while h_idx < lines.len() {
            let line = lines[h_idx];
            let next_len = line.chars().count() + 1;
            if !head_lines.is_empty() && head_chars + next_len > head_budget {
                break;
            }
            if head_lines.is_empty() && next_len > head_budget {
                head_lines.push(line.chars().take(head_budget).collect::<String>());
                h_idx += 1;
                break;
            }
            head_lines.push(line.to_string());
            head_chars += next_len;
            h_idx += 1;
        }

        let mut tail_lines = Vec::new();
        let mut tail_chars = 0usize;
        let mut t_idx = lines.len();
        while t_idx > h_idx {
            let line = lines[t_idx - 1];
            let next_len = line.chars().count() + 1;
            if !tail_lines.is_empty() && tail_chars + next_len > tail_budget {
                break;
            }
            if tail_lines.is_empty() && next_len > tail_budget {
                let clipped: String = line
                    .chars()
                    .rev()
                    .take(tail_budget)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                tail_lines.push(clipped);
                t_idx -= 1;
                break;
            }
            tail_lines.push(line.to_string());
            tail_chars += next_len;
            t_idx -= 1;
        }
        tail_lines.reverse();
        (head_lines.join("\n"), h_idx, tail_lines.join("\n"), t_idx)
    };

    let mut anomalies = Vec::new();
    let mut seen_anomalies = std::collections::HashSet::new();
    let mut anomaly_chars = 0usize;
    if tail_start_idx > head_end_idx {
        for line in &lines[head_end_idx..tail_start_idx] {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let lower = trimmed.to_ascii_lowercase();
            let is_signal = lower.contains("error")
                || lower.contains("failed")
                || lower.contains("panic")
                || lower.contains("exception")
                || lower.contains("fatal")
                || lower.contains("assertion");
            if is_signal && seen_anomalies.insert(trimmed.to_string()) {
                let clipped: String = trimmed.chars().take(280).collect();
                if anomaly_chars + clipped.len() + 1 > anomaly_budget {
                    break;
                }
                anomaly_chars += clipped.len() + 1;
                anomalies.push(clipped);
            }
        }
    }

    let mut preview = String::new();
    preview.push_str(head.trim_end());
    if !anomalies.is_empty() {
        preview.push_str("\n... [key error/failure signals from middle] ...\n");
        preview.push_str(&anomalies.join("\n"));
    }

    let raw_chars = raw_source.chars().count();
    let omitted_chars = raw_chars.saturating_sub(head.chars().count() + tail.chars().count());
    let omitted_tokens = omitted_chars / 4;
    let footer_preview = format!("{preview}\n...\n{}", tail.trim_start());
    let hash = ccr
        .put(raw_source, &footer_preview, "auto_ccr", label)
        .ok();

    match hash {
        Some(h) => preview.push_str(&format!(
            "\n... [kite-ctx auto-CCR spilled {omitted_chars} chars (~{omitted_tokens} tokens from {total_chars} filtered chars) — run `kite ctx retrieve {h} [--lines N-M] [--search <term>]` for full output] <<ccr:{h}>> ..."
        )),
        None => preview.push_str(&format!(
            "\n... [kite-ctx truncated {omitted_chars} chars] ..."
        )),
    }
    if !tail.trim().is_empty() {
        preview.push('\n');
        preview.push_str(tail.trim_start());
    }
    preview
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initializes_sqlite_schema_and_respects_path_override() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("nested").join("ctx.db");
        let engine = ContextEngine::open(&db_path).unwrap();
        assert_eq!(engine.store().db_path(), Some(db_path.as_path()));
        assert!(db_path.is_file());

        let table_count: i64 = engine
            .store()
            .with_conn(|conn| {
                let count = conn.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN (
                        'ccr_entries', 'read_records', 'shared_entries', 'tool_cache', 'kv_sessions', 'ledger_events'
                    )",
                    [],
                    |row| row.get(0),
                )?;
                Ok(count)
            })
            .unwrap();
        assert_eq!(table_count, 6);
    }

    #[test]
    fn detects_content_kinds_without_ml() {
        assert_eq!(
            detect_content_kind(r#"[{"id":1,"name":"a"}]"#),
            ContentKind::Json
        );
        assert_eq!(
            detect_content_kind("diff --git a/x.rs b/x.rs\nindex 123..456 100644\n@@ -1 +1 @@"),
            ContentKind::Diff
        );
        assert_eq!(
            detect_content_kind("src/a.rs:10:foo\nsrc/a.rs:12:bar\nsrc/b.rs:4:baz"),
            ContentKind::Grep
        );
    }

    #[test]
    fn end_to_end_engine_tracks_reads_compression_and_shared_handoffs() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sample.rs");
        std::fs::write(
            &file,
            "pub fn alpha() -> i32 {\n    1 + 1\n}\npub fn beta() -> i32 {\n    2 + 2\n}\n",
        )
        .unwrap();

        let engine = ContextEngine::open_in_memory().unwrap();
        let r1 = engine
            .read_file_with_telemetry(
                "s1",
                &file,
                ReadMode::Full,
                false,
                "Orion",
                "anthropic",
                "claude-sonnet-4-5",
            )
            .unwrap();
        assert!(!r1.deduplicated);

        let r2 = engine
            .read_file_with_telemetry(
                "s1",
                &file,
                ReadMode::Full,
                false,
                "Orion",
                "anthropic",
                "claude-sonnet-4-5",
            )
            .unwrap();
        assert!(r2.deduplicated);

        let snap = engine.ledger().snapshot(Some("s1")).unwrap();
        assert_eq!(snap.session.requests, 2);
        assert_eq!(snap.session.cache_hits, 1);

        let repeated = "alpha line\n".repeat(40);
        let shared = engine
            .share_put_with_telemetry(
                ContextScope::Project,
                "kite",
                "notes",
                &repeated,
                "Orion",
                "anthropic",
                None,
                "s1",
                "claude-sonnet-4-5",
            )
            .unwrap();
        assert!(shared.compressed_tokens < shared.original_tokens);

        let retrieved_shared = engine
            .share_get_with_telemetry(
                ContextScope::Project,
                "kite",
                "notes",
                false,
                "s1",
                "Orion",
                "anthropic",
                "claude-sonnet-4-5",
            )
            .unwrap()
            .unwrap();
        assert_eq!(retrieved_shared, shared.compressed_text);

        let ccr_slice = engine
            .retrieve_ccr_with_telemetry(
                &shared.ccr_hash,
                Some((1, 3)),
                None,
                "s1",
                "Orion",
                "anthropic",
                "claude-sonnet-4-5",
            )
            .unwrap();
        assert_eq!(ccr_slice.returned_lines, 3);

        let after = engine.ledger().snapshot(Some("s1")).unwrap();
        assert!(after.features.iter().any(|f| f.feature == "share:put"));
        assert!(after.features.iter().any(|f| f.feature == "share:get"));
        assert!(after.features.iter().any(|f| f.feature == "ccr:retrieve"));

        let oversized_turn = format!(
            "HEAD_ANCHOR: initial diagnosis\n{}\nTAIL_ANCHOR: final conclusion",
            "verbose log entry from compiler pass\n".repeat(120)
        );
        let compressed_turn = engine
            .compress_runtime_segment(
                &oversized_turn,
                400,
                "runtime:thread_history",
                "s1",
                "Orion",
                "anthropic",
                "claude-sonnet-4-5",
            )
            .unwrap();
        assert!(compressed_turn.contains("HEAD_ANCHOR: initial diagnosis"));
        assert!(compressed_turn.contains("TAIL_ANCHOR: final conclusion"));
        assert!(compressed_turn.len() < oversized_turn.len());

        let final_snap = engine.ledger().snapshot(Some("s1")).unwrap();
        assert!(final_snap
            .features
            .iter()
            .any(|f| f.feature == "runtime:thread_history"));
    }

    #[test]
    fn spills_oversized_exec_output_to_auto_ccr_and_normalizes_feature_labels() {
        let engine = ContextEngine::open_in_memory().unwrap();
        let mut huge = String::from("HEAD_LINE_1: boot sequence started\n");
        for i in 0..450 {
            if i == 220 {
                huge.push_str("ERROR: critical failure at module 220\n");
            } else {
                huge.push_str(&format!(
                    "diagnostic line {i:03}: verbose uncompressible payload token_{i}_alpha_beta_gamma\n"
                ));
            }
        }
        huge.push_str("TAIL_LINE_END: finished with status 1\n");

        let cmd = vec![
            "npx".to_string(),
            "--prefix".to_string(),
            "frontend".to_string(),
            "custom-tool".to_string(),
        ];
        let res = engine
            .filter_command_with_telemetry(
                &cmd,
                &huge,
                "",
                1,
                "s-auto-ccr",
                "Orion",
                "antigravity",
                "gemini-4",
            )
            .unwrap();

        assert!(res.text.chars().count() <= 16_000);
        assert!(res.text.contains("HEAD_LINE_1: boot sequence started"));
        assert!(res.text.contains("ERROR: critical failure at module 220"));
        assert!(res.text.contains("TAIL_LINE_END: finished with status 1"));
        assert!(res.text.contains("<<ccr:"));

        let marker_start = res.text.find("<<ccr:").unwrap() + 6;
        let marker_end = res.text[marker_start..].find(">>").unwrap() + marker_start;
        let hash = &res.text[marker_start..marker_end];
        let full = engine.ccr().retrieve(hash).unwrap();
        assert_eq!(full.original_text, huge);

        let snap = engine.ledger().snapshot(Some("s-auto-ccr")).unwrap();
        assert!(
            snap.features.iter().any(|f| f.feature == "exec:npx custom-tool"),
            "expected canonical feature label exec:npx custom-tool, got {:?}",
            snap.features
        );
    }

    #[test]
    fn packs_voice_context_below_250_tokens_with_lossless_and_crusher() {
        let engine = ContextEngine::open_in_memory().unwrap();
        let raw = format!(
            "Workspace: kite\nChanges:\n{}\n{}\nActive terminal: cargo test ok\n",
            "src\\lib\\operator\\index.ts\nsrc\\lib\\operator\\prompt.ts\nsrc\\lib\\operator\\contract.ts\n",
            "diagnostic verbose line from background worker\n".repeat(90)
        );
        let packed = engine.pack_voice_context(&raw).unwrap();
        let tokens = estimate_tokens(&packed);
        assert!(tokens < 250, "expected < 250 tokens, got {tokens}");
        assert!(packed.contains("Workspace: kite"));
        assert!(packed.contains("Active terminal: cargo test ok"));

        let pack_meta = engine.pack_voice_context_with_budget(&raw, Some(180)).unwrap();
        assert!(pack_meta.compressed_tokens <= 180);
        assert!(pack_meta.original_tokens > pack_meta.compressed_tokens);
    }

    #[test]
    fn caches_head_immutable_git_reads_and_invalidates_when_head_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        let git_dir = repo.join(".git");
        std::fs::create_dir_all(git_dir.join("refs").join("heads")).unwrap();
        std::fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(
            git_dir.join("refs").join("heads").join("main"),
            "1111111111111111111111111111111111111111\n",
        )
        .unwrap();

        let engine = ContextEngine::open_in_memory().unwrap();
        let cmd = vec!["git".into(), "log".into(), "-n".into(), "5".into()];

        assert!(engine
            .try_exec_tool_cache(&cmd, repo, "s-cache", "cli", "local", "gemini-4")
            .unwrap()
            .is_none());

        assert!(engine
            .store_exec_tool_cache(&cmd, repo, "abc1234 feat: initial\n", 400)
            .unwrap());

        let hit = engine
            .try_exec_tool_cache(&cmd, repo, "s-cache", "cli", "local", "gemini-4")
            .unwrap();
        assert_eq!(hit.as_deref(), Some("abc1234 feat: initial\n"));

        let snap = engine.ledger().snapshot(Some("s-cache")).unwrap();
        assert_eq!(snap.session.cache_hits, 1);
        assert!(snap.features.iter().any(|f| f.feature == "exec:cache:git log"));

        // Mutating branch ref must invalidate the tool cache immediately.
        std::fs::write(
            git_dir.join("refs").join("heads").join("main"),
            "2222222222222222222222222222222222222222\n",
        )
        .unwrap();
        assert!(engine
            .try_exec_tool_cache(&cmd, repo, "s-cache", "cli", "local", "gemini-4")
            .unwrap()
            .is_none());

        // Subdirectory cwd (`git ls-files` from `repo/src` vs `repo`) must not collide.
        let sub_dir = repo.join("src");
        std::fs::create_dir_all(&sub_dir).unwrap();
        let ls_cmd = vec!["git".into(), "ls-files".into()];
        assert!(engine
            .store_exec_tool_cache(&ls_cmd, &sub_dir, "lib.rs\n", 40)
            .unwrap());
        assert!(engine
            .try_exec_tool_cache(&ls_cmd, repo, "s-cache", "cli", "local", "gemini-4")
            .unwrap()
            .is_none());
        assert_eq!(
            engine
                .try_exec_tool_cache(&ls_cmd, &sub_dir, "s-cache", "cli", "local", "gemini-4")
                .unwrap()
                .as_deref(),
            Some("lib.rs\n")
        );

        // Mutable non-HEAD refs must bypass tool_cache.
        let origin_log = vec!["git".into(), "log".into(), "origin/main".into()];
        assert!(!engine
            .store_exec_tool_cache(&origin_log, repo, "origin commit\n", 40)
            .unwrap());
        let stash_show = vec!["git".into(), "show".into(), "stash@{0}".into()];
        assert!(!engine
            .store_exec_tool_cache(&stash_show, repo, "stash diff\n", 40)
            .unwrap());

        // Linked worktrees resolve refs via `commondir`.
        let wt_root = tmp.path().join("wt_checkout");
        let wt_git = git_dir.join("worktrees").join("wt1");
        std::fs::create_dir_all(&wt_root).unwrap();
        std::fs::create_dir_all(&wt_git).unwrap();
        std::fs::write(
            wt_root.join(".git"),
            format!("gitdir: {}\n", wt_git.display()),
        )
        .unwrap();
        std::fs::write(wt_git.join("commondir"), "../..\n").unwrap();
        std::fs::write(wt_git.join("HEAD"), "ref: refs/heads/wt-feat\n").unwrap();
        std::fs::write(
            git_dir.join("refs").join("heads").join("wt-feat"),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        )
        .unwrap();
        assert!(engine
            .store_exec_tool_cache(&cmd, &wt_root, "wt commit 1\n", 100)
            .unwrap());
        assert_eq!(
            engine
                .try_exec_tool_cache(&cmd, &wt_root, "s-cache", "cli", "local", "gemini-4")
                .unwrap()
                .as_deref(),
            Some("wt commit 1\n")
        );
        std::fs::write(
            git_dir.join("refs").join("heads").join("wt-feat"),
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
        )
        .unwrap();
        assert!(engine
            .try_exec_tool_cache(&cmd, &wt_root, "s-cache", "cli", "local", "gemini-4")
            .unwrap()
            .is_none());
    }

    #[test]
    fn browser_engine_accessors_and_shared_handoffs_round_trip() {
        let engine = ContextEngine::open_in_memory().unwrap();

        let handoff = engine
            .share_put_with_telemetry(
                ContextScope::Session,
                "s-handoff",
                "browser:tab:t1",
                "GET 200 https://localhost:5173/api/a 12ms\nGET 200 https://localhost:5173/api/a 12ms\nGET 200 https://localhost:5173/api/a 12ms\n",
                "Browser",
                "google",
                None,
                "s-handoff",
                "gemini-4",
            )
            .unwrap();
        let got = engine
            .share_get_with_telemetry(
                ContextScope::Session,
                "s-handoff",
                "browser:tab:t1",
                false,
                "s-handoff",
                "Orion",
                "google",
                "gemini-4",
            )
            .unwrap()
            .unwrap();
        assert_eq!(got, handoff.compressed_text);

        let origin_list = engine
            .browser_recipes()
            .list_for_origin("http://localhost:5173")
            .unwrap();
        assert!(origin_list.is_empty());

        let invalidated = engine.browser_cache().invalidate_tab("s-handoff", "t1").unwrap();
        assert_eq!(invalidated, 0);

        assert_eq!(
            detect_content_kind("RootWebArea \"Home\"\n  button \"Go\" [@e1]\n  link \"Docs\" [@e2]"),
            ContentKind::AxTree
        );
        assert_eq!(
            detect_content_kind("<html>\n<body>\n<div class=\"card\">hi</div>\n</body>\n</html>"),
            ContentKind::Dom
        );
        assert_eq!(
            detect_content_kind("GET 200 https://localhost:5173/a 10ms\nPOST 201 https://localhost:5173/b 20ms"),
            ContentKind::NetworkWaterfall
        );
    }
}
