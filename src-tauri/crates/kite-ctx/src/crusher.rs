use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::ccr_store::CcrStore;
use crate::error::Result;
use crate::tokens::{estimate_tokens, short_hash};

/// Detected structural role of a JSON array for anchor slot allocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataPattern {
    SearchResults,
    Logs,
    TimeSeries,
    Generic,
}

/// Configuration thresholds for Stage-1 lossless tabular compaction and Stage-2 anchor crushing.
#[derive(Debug, Clone)]
pub struct CrusherConfig {
    pub min_items_to_crush: usize,
    pub max_items_after_crush: usize,
    pub min_tokens_to_crush: usize,
    pub core_field_fraction: f64,
    pub lossless_min_savings_ratio: f64,
    pub max_flatten_inner_keys: usize,
    pub max_tokens: usize,
    pub head_ratio: f64,
    pub tail_ratio: f64,
}

impl Default for CrusherConfig {
    fn default() -> Self {
        Self {
            min_items_to_crush: 5,
            max_items_after_crush: 15,
            min_tokens_to_crush: 200,
            core_field_fraction: 0.80,
            lossless_min_savings_ratio: 0.15,
            max_flatten_inner_keys: 6,
            max_tokens: 4000,
            head_ratio: 0.65,
            tail_ratio: 0.25,
        }
    }
}

impl CrusherConfig {
    /// Tight voice-assistant configuration keeping dynamic context under ~220 tokens.
    pub fn voice() -> Self {
        Self {
            min_items_to_crush: 3,
            max_items_after_crush: 6,
            min_tokens_to_crush: 120,
            core_field_fraction: 0.80,
            lossless_min_savings_ratio: 0.15,
            max_flatten_inner_keys: 6,
            max_tokens: 220,
            head_ratio: 0.70,
            tail_ratio: 0.25,
        }
    }
}

/// Result returned by [`SmartCrusher`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrushResult {
    pub output: String,
    pub stage: &'static str,
    pub raw_tokens: usize,
    pub compressed_tokens: usize,
    pub ccr_hash: Option<String>,
}

/// Dual-stage JSON compressor:
/// 1. Stage 1 (Lossless): Tabular `[N]{col:type}` + `@col=["v0","v1"]` dictionary factoring.
/// 2. Stage 2 (Reversible Lossy): Statistical anchor selection (`front`/`middle`/`back` + anomalies)
///    paired with a `<<ccr:HASH>>` sentinel stored in [`CcrStore`].
pub struct SmartCrusher {
    config: CrusherConfig,
}

impl Default for SmartCrusher {
    fn default() -> Self {
        Self::new(CrusherConfig::default())
    }
}

impl SmartCrusher {
    pub fn new(config: CrusherConfig) -> Self {
        Self { config }
    }

    pub fn config(&self) -> &CrusherConfig {
        &self.config
    }

    /// Fit an already stage-compacted string within `max_tokens` using `head_ratio` and `tail_ratio`,
    /// spilling the full `original_for_ccr` into [`CcrStore`] when truncated.
    pub fn fit_budget(
        &self,
        compacted: &str,
        max_tokens_override: Option<usize>,
        ccr: Option<&CcrStore>,
        original_for_ccr: &str,
    ) -> (String, Option<String>) {
        let trimmed = compacted.trim();
        let budget = max_tokens_override.unwrap_or(self.config.max_tokens).max(1);
        if trimmed.is_empty() || estimate_tokens(trimmed) <= budget {
            return (trimmed.to_string(), None);
        }

        let max_chars = budget.saturating_mul(4).max(4);
        let ccr_hash = if max_chars >= 100 && !CcrStore::is_bare_marker(original_for_ccr) {
            ccr.and_then(|store| {
                let preview: String = trimmed.chars().take(240).collect();
                store
                    .put(original_for_ccr, &preview, "voice_pack", "voice_context")
                    .ok()
            })
        } else {
            None
        };

        let sentinel = match &ccr_hash {
            Some(hash) => format!("\n... <<ccr:{hash}>> ...\n"),
            None => "\n...\n".to_string(),
        };
        let sentinel_chars = sentinel.chars().count();
        if max_chars <= sentinel_chars + 8 {
            let clipped: String = trimmed.chars().take(max_chars).collect();
            return (clipped, ccr_hash);
        }

        let usable_chars = max_chars.saturating_sub(sentinel_chars);
        let ratio_sum = (self.config.head_ratio + self.config.tail_ratio).max(0.01);
        let head_budget = ((usable_chars as f64) * (self.config.head_ratio / ratio_sum)).floor() as usize;
        let tail_budget = usable_chars.saturating_sub(head_budget);

        let head: String = trimmed.chars().take(head_budget).collect();
        let tail: String = trimmed
            .chars()
            .rev()
            .take(tail_budget)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();

        let packed = format!("{}{}{}", head.trim_end(), sentinel, tail.trim_start());
        if estimate_tokens(&packed) <= budget {
            (packed, ccr_hash)
        } else {
            let clipped: String = packed.chars().take(max_chars).collect();
            (clipped, ccr_hash)
        }
    }

    pub fn crush(&self, raw_json: &str, ccr: Option<&CcrStore>) -> Result<CrushResult> {
        let raw_tokens = estimate_tokens(raw_json);
        let Ok(parsed) = serde_json::from_str::<Value>(raw_json.trim()) else {
            return Ok(CrushResult {
                output: raw_json.to_string(),
                stage: "passthrough",
                raw_tokens,
                compressed_tokens: raw_tokens,
                ccr_hash: None,
            });
        };

        let Some(items) = parsed.as_array() else {
            // Try compacting pretty JSON object, or crushing the largest array field inside an object.
            if let Some(obj_res) = self.try_crush_object_envelope(&parsed, raw_json, ccr)? {
                return Ok(obj_res);
            }
            let compact = serde_json::to_string(&parsed)?;
            let best = if compact.len() < raw_json.len() {
                compact
            } else {
                raw_json.to_string()
            };
            let compressed_tokens = estimate_tokens(&best);
            return Ok(CrushResult {
                output: best,
                stage: "compact_json",
                raw_tokens,
                compressed_tokens,
                ccr_hash: None,
            });
        };

        // Stage 1: Lossless tabular compaction when array is sufficiently small or within token budget.
        let stage1 = self.try_tabular_lossless(items, raw_json);
        let exceeds_budget = items.len() > self.config.max_items_after_crush
            && items.len() > self.config.min_items_to_crush
            && raw_tokens > self.config.min_tokens_to_crush;

        if !exceeds_budget {
            if let Some(encoded) = stage1 {
                let tokens = estimate_tokens(&encoded);
                return Ok(CrushResult {
                    output: encoded,
                    stage: "tabular_lossless",
                    raw_tokens,
                    compressed_tokens: tokens,
                    ccr_hash: None,
                });
            }
            let compact = serde_json::to_string(&parsed)?;
            let best = if compact.len() < raw_json.len() {
                compact
            } else {
                raw_json.to_string()
            };
            let tokens = estimate_tokens(&best);
            return Ok(CrushResult {
                output: best,
                stage: "compact_json",
                raw_tokens,
                compressed_tokens: tokens,
                ccr_hash: None,
            });
        }

        // Stage 2: If Stage 1 tabular lossless already reduces output below a modest cap (<= 40 items
        // and < 450 tokens), keep lossless! Otherwise perform statistical anchor selection + CCR.
        if let Some(ref encoded) = stage1 {
            let tokens = estimate_tokens(encoded);
            if items.len() <= 40 && tokens <= 450 {
                return Ok(CrushResult {
                    output: encoded.clone(),
                    stage: "tabular_lossless",
                    raw_tokens,
                    compressed_tokens: tokens,
                    ccr_hash: None,
                });
            }
        }

        let selected = self.select_anchors(items);
        let omitted = items.len().saturating_sub(selected.len());

        let selected_values: Vec<Value> = selected.iter().map(|&idx| items[idx].clone()).collect();
        let preview_body = self
            .try_tabular_lossless(&selected_values, raw_json)
            .unwrap_or_else(|| {
                serde_json::to_string(&selected_values).unwrap_or_else(|_| "[]".to_string())
            });

        let hash = if let Some(store) = ccr {
            store.put(raw_json, &preview_body, "crusher_anchors", "json")?
        } else {
            short_hash(raw_json)
        };

        let sentinel = format!(
            "\n<<ccr:{hash} omitted={omitted} total={}>>",
            items.len()
        );
        let output = format!("{preview_body}{sentinel}");
        let compressed_tokens = estimate_tokens(&output);

        Ok(CrushResult {
            output,
            stage: "statistical_anchors_ccr",
            raw_tokens,
            compressed_tokens,
            ccr_hash: Some(hash),
        })
    }

    fn try_crush_object_envelope(
        &self,
        parsed: &Value,
        raw_json: &str,
        ccr: Option<&CcrStore>,
    ) -> Result<Option<CrushResult>> {
        let Some(obj) = parsed.as_object() else {
            return Ok(None);
        };
        let Some((target_key, target_arr)) = obj
            .iter()
            .filter_map(|(k, v)| v.as_array().map(|a| (k, a)))
            .max_by_key(|(_, a)| a.len())
        else {
            return Ok(None);
        };
        if target_arr.len() <= self.config.min_items_to_crush {
            return Ok(None);
        }

        let inner_raw = serde_json::to_string(target_arr)?;
        let inner_crush = self.crush(&inner_raw, ccr)?;
        if inner_crush.compressed_tokens >= inner_crush.raw_tokens {
            return Ok(None);
        }

        let mut header_parts = Vec::new();
        for (k, v) in obj {
            if k != target_key {
                header_parts.push(format!("{k}: {}", serde_json::to_string(v)?));
            }
        }
        let prefix = if header_parts.is_empty() {
            String::new()
        } else {
            format!("{}\n", header_parts.join(" | "))
        };
        let output = format!("{prefix}{target_key}:\n{}", inner_crush.output);
        let raw_tokens = estimate_tokens(raw_json);
        let compressed_tokens = estimate_tokens(&output);
        Ok(Some(CrushResult {
            output,
            stage: inner_crush.stage,
            raw_tokens,
            compressed_tokens,
            ccr_hash: inner_crush.ccr_hash,
        }))
    }

    /// Stage 1 lossless tabular encoding (`[N]{col:type}` + `@col=["v0","v1"]` dictionary factoring).
    pub fn try_tabular_lossless(&self, items: &[Value], raw_for_budget: &str) -> Option<String> {
        if items.len() < 3 {
            return None;
        }
        let flattened: Option<Vec<Map<String, Value>>> = items
            .iter()
            .map(|v| flatten_one_level(v.as_object()?, self.config.max_flatten_inner_keys))
            .collect();
        let rows = flattened?;

        let n = rows.len();
        let mut key_counts: BTreeMap<String, usize> = BTreeMap::new();
        for row in &rows {
            for k in row.keys() {
                *key_counts.entry(k.clone()).or_insert(0) += 1;
            }
        }
        if key_counts.is_empty() {
            return None;
        }

        let core_threshold = ((n as f64) * self.config.core_field_fraction).ceil() as usize;
        let columns: Vec<String> = key_counts
            .iter()
            .filter(|(_, &cnt)| cnt >= core_threshold.max(1))
            .map(|(k, _)| k.clone())
            .collect();
        if columns.is_empty() {
            return None;
        }
        // Only emit tabular encoding if every key present across rows is covered (lossless!).
        if columns.len() != key_counts.len() {
            return None;
        }

        let mut col_types = Vec::with_capacity(columns.len());
        for col in &columns {
            let inferred = infer_column_type(&rows, col);
            col_types.push(format!("{col}:{inferred}"));
        }

        // Dictionary factoring for repeated string columns.
        let mut legends: Vec<String> = Vec::new();
        let mut factored_cols: HashMap<usize, HashMap<String, usize>> = HashMap::new();
        for (col_idx, col) in columns.iter().enumerate() {
            if let Some((legend, map)) = try_factor_column(&rows, col) {
                legends.push(legend);
                factored_cols.insert(col_idx, map);
            }
        }

        let mut out = Vec::with_capacity(n + legends.len() + 2);
        out.push(format!("[{n}]{{{}}}", col_types.join(",")));
        for legend in legends {
            out.push(legend);
        }
        for row in &rows {
            let mut cells = Vec::with_capacity(columns.len());
            for (col_idx, col) in columns.iter().enumerate() {
                match row.get(col) {
                    None => cells.push(String::new()),
                    Some(Value::String(s)) => {
                        if let Some(idx) = factored_cols.get(&col_idx).and_then(|m| m.get(s)) {
                            cells.push(idx.to_string());
                        } else {
                            cells.push(format_csv_string(s));
                        }
                    }
                    Some(val) => cells.push(format_csv_scalar(val)),
                }
            }
            out.push(cells.join(","));
        }

        let candidate = out.join("\n");
        let baseline_len = serde_json::to_string(items)
            .map(|s| s.len())
            .unwrap_or(raw_for_budget.len());
        let saved = baseline_len.saturating_sub(candidate.len());
        if (saved as f64) >= (baseline_len as f64) * self.config.lossless_min_savings_ratio {
            Some(candidate)
        } else {
            None
        }
    }

    fn select_anchors(&self, items: &[Value]) -> Vec<usize> {
        let total = items.len();
        let budget = self.config.max_items_after_crush.min(total);
        if total <= budget {
            return (0..total).collect();
        }

        let pattern = detect_data_pattern(items);
        let (front_ratio, mid_ratio, back_ratio) = match pattern {
            DataPattern::SearchResults => (0.60, 0.25, 0.15),
            DataPattern::Logs => (0.15, 0.25, 0.60),
            DataPattern::TimeSeries => (0.45, 0.10, 0.45),
            DataPattern::Generic => (0.35, 0.30, 0.35),
        };

        let front_n = ((budget as f64) * front_ratio).round().max(1.0) as usize;
        let back_n = ((budget as f64) * back_ratio).round().max(1.0) as usize;
        let mut selected_set: HashSet<usize> = HashSet::new();

        for i in 0..front_n.min(total) {
            selected_set.insert(i);
        }
        for i in total.saturating_sub(back_n)..total {
            selected_set.insert(i);
        }

        let remaining_budget = budget.saturating_sub(selected_set.len());
        let mid_budget = remaining_budget.max(((budget as f64) * mid_ratio).round() as usize);

        if mid_budget > 0 && selected_set.len() < budget {
            let scores = score_middle_candidates(items);
            let mut candidates: Vec<(usize, f64)> = (0..total)
                .filter(|idx| !selected_set.contains(idx))
                .map(|idx| (idx, scores[idx]))
                .collect();
            candidates.sort_by(|a, b| {
                b.1.partial_cmp(&a.1)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| a.0.cmp(&b.0))
            });

            // Deduplicate identical serialized items when filling middle slots.
            let mut seen_hashes: HashSet<String> = selected_set
                .iter()
                .map(|&idx| short_hash(&items[idx].to_string()))
                .collect();

            for (idx, _) in candidates {
                if selected_set.len() >= budget {
                    break;
                }
                let h = short_hash(&items[idx].to_string());
                if seen_hashes.insert(h) {
                    selected_set.insert(idx);
                }
            }
        }

        let mut indices: Vec<usize> = selected_set.into_iter().collect();
        indices.sort_unstable();
        indices
    }
}

fn flatten_one_level(obj: &Map<String, Value>, max_inner: usize) -> Option<Map<String, Value>> {
    let mut flat = Map::new();
    for (k, v) in obj {
        match v {
            Value::Object(inner) if !inner.is_empty() && inner.len() <= max_inner => {
                for (ik, iv) in inner {
                    if iv.is_object() || iv.is_array() {
                        return None;
                    }
                    flat.insert(format!("{k}.{ik}"), iv.clone());
                }
            }
            Value::Object(_) | Value::Array(_) => return None,
            _ => {
                flat.insert(k.clone(), v.clone());
            }
        }
    }
    Some(flat)
}

fn infer_column_type(rows: &[Map<String, Value>], col: &str) -> String {
    let mut missing = false;
    let mut kind: Option<&'static str> = None;

    for row in rows {
        match row.get(col) {
            None => missing = true,
            Some(Value::Null) => missing = true,
            Some(val) => {
                let k = match val {
                    Value::Bool(_) => "bool",
                    Value::Number(n) if n.is_i64() || n.is_u64() => "int",
                    Value::Number(_) => "num",
                    Value::String(_) => "str",
                    _ => "json",
                };
                kind = match kind {
                    None => Some(k),
                    Some(prev) if prev == k => Some(prev),
                    Some("int") if k == "num" => Some("num"),
                    Some("num") if k == "int" => Some("num"),
                    Some(_) => Some("any"),
                };
            }
        }
    }

    let base = kind.unwrap_or("null");
    if missing {
        format!("{base}?")
    } else {
        base.to_string()
    }
}

fn try_factor_column(
    rows: &[Map<String, Value>],
    col: &str,
) -> Option<(String, HashMap<String, usize>)> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    let mut str_rows = 0usize;
    let mut raw_bytes = 0usize;

    for row in rows {
        if let Some(Value::String(s)) = row.get(col) {
            str_rows += 1;
            raw_bytes += s.len();
            *counts.entry(s.as_str()).or_insert(0) += 1;
        }
    }

    if str_rows < 4 || counts.is_empty() || counts.len() * 2 > str_rows {
        return None;
    }

    let mut vocab: Vec<(&str, usize)> = counts.into_iter().collect();
    vocab.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));

    let legend_items: Vec<String> = vocab
        .iter()
        .map(|(s, _)| serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\"")))
        .collect();
    let legend = format!("@{col}=[{}]", legend_items.join(","));

    let mut index_bytes = 0usize;
    let mut mapping = HashMap::with_capacity(vocab.len());
    for (idx, (val, freq)) in vocab.into_iter().enumerate() {
        index_bytes += idx.to_string().len() * freq;
        mapping.insert(val.to_string(), idx);
    }

    if legend.len() + index_bytes + 4 < raw_bytes {
        Some((legend, mapping))
    } else {
        None
    }
}

fn format_csv_string(s: &str) -> String {
    if s.is_empty() {
        return "\"\"".to_string();
    }
    if s == "null"
        || s.contains(',')
        || s.contains('"')
        || s.contains('\n')
        || s.contains('\r')
    {
        let escaped = s.replace('"', "\"\"");
        format!("\"{escaped}\"")
    } else {
        s.to_string()
    }
}

fn format_csv_scalar(val: &Value) -> String {
    match val {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => format_csv_string(s),
        other => format_csv_string(&other.to_string()),
    }
}

fn detect_data_pattern(items: &[Value]) -> DataPattern {
    let Some(first) = items.first().and_then(Value::as_object) else {
        return DataPattern::Generic;
    };
    let keys: Vec<String> = first.keys().map(|k| k.to_ascii_lowercase()).collect();
    if keys
        .iter()
        .any(|k| k == "score" || k == "rank" || k == "relevance" || k == "url")
    {
        return DataPattern::SearchResults;
    }
    if keys
        .iter()
        .any(|k| k == "level" || k == "severity" || k == "message" || k == "logger")
    {
        return DataPattern::Logs;
    }
    if keys
        .iter()
        .any(|k| k == "timestamp" || k == "ts" || k == "time" || k == "date")
    {
        return DataPattern::TimeSeries;
    }
    DataPattern::Generic
}

/// Score array items by `0.4 * ValueUniqueness + 0.3 * NormalizedLength + 0.3 * StructuralUniqueness`
/// plus an anomaly boost for error/failure indicators so critical rows are preserved.
fn score_middle_candidates(items: &[Value]) -> Vec<f64> {
    let n = items.len().max(1);
    let mut kv_counts: HashMap<(String, String), usize> = HashMap::new();
    let mut key_counts: HashMap<String, usize> = HashMap::new();
    let mut lengths: Vec<usize> = Vec::with_capacity(n);

    for item in items {
        let serialized = item.to_string();
        lengths.push(serialized.len());
        if let Some(obj) = item.as_object() {
            for (k, v) in obj {
                *key_counts.entry(k.clone()).or_insert(0) += 1;
                *kv_counts.entry((k.clone(), v.to_string())).or_insert(0) += 1;
            }
        }
    }

    let max_len = (*lengths.iter().max().unwrap_or(&1)).max(1) as f64;
    let rare_key_threshold = ((n as f64) * 0.20).ceil() as usize;
    let common_key_threshold = ((n as f64) * 0.80).ceil() as usize;

    items
        .iter()
        .enumerate()
        .map(|(idx, item)| {
            let norm_len = (lengths[idx] as f64) / max_len;
            let (val_uniq, struct_uniq) = if let Some(obj) = item.as_object() {
                if obj.is_empty() {
                    (0.0, 0.0)
                } else {
                    let vu_sum: f64 = obj
                        .iter()
                        .map(|(k, v)| {
                            let c = kv_counts
                                .get(&(k.clone(), v.to_string()))
                                .copied()
                                .unwrap_or(1);
                            1.0 - (c as f64 / n as f64)
                        })
                        .sum();
                    let vu = vu_sum / obj.len() as f64;

                    let rare_present = obj
                        .keys()
                        .filter(|k| key_counts.get(*k).copied().unwrap_or(0) <= rare_key_threshold)
                        .count();
                    let common_missing = key_counts
                        .iter()
                        .filter(|(k, &cnt)| cnt >= common_key_threshold && !obj.contains_key(*k))
                        .count();
                    let su_denom = (obj.len() + common_missing).max(1) as f64;
                    let su = ((rare_present + common_missing) as f64 / su_denom).min(1.0);
                    (vu, su)
                }
            } else {
                (0.5, 0.0)
            };

            let anomaly_bonus = if is_anomaly_item(item) { 1.0 } else { 0.0 };
            0.4 * val_uniq + 0.3 * norm_len + 0.3 * struct_uniq + anomaly_bonus
        })
        .collect()
}

fn is_anomaly_item(item: &Value) -> bool {
    let lower = item.to_string().to_ascii_lowercase();
    lower.contains("\"error\"")
        || lower.contains("\"fatal\"")
        || lower.contains("\"panic\"")
        || lower.contains("\"exception\"")
        || lower.contains("failed")
        || lower.contains("\"status\":5")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::ContextStore;

    #[test]
    fn encodes_uniform_json_array_as_tabular_with_dictionary_factoring() {
        let rows: Vec<Value> = (0..10)
            .map(|i| {
                serde_json::json!({
                    "id": i,
                    "path": if i % 2 == 0 { "src/crates/kite-ctx/src/lossless.rs" } else { "src/crates/kite-ctx/src/crusher.rs" },
                    "status": "ok"
                })
            })
            .collect();
        let raw = serde_json::to_string_pretty(&rows).unwrap();
        let crusher = SmartCrusher::default();
        let res = crusher.crush(&raw, None).unwrap();

        assert_eq!(res.stage, "tabular_lossless");
        assert!(res.output.starts_with("[10]{id:int,path:str,status:str}"));
        assert!(res.output.contains("@path=["));
        assert!(res.compressed_tokens < res.raw_tokens);
    }

    #[test]
    fn preserves_anomalies_and_writes_ccr_marker_for_large_arrays() {
        let mut rows = Vec::new();
        for i in 0..80 {
            if i == 37 {
                rows.push(serde_json::json!({
                    "seq": i,
                    "level": "error",
                    "service": "worker",
                    "message": "fatal panic in scheduler loop"
                }));
            } else {
                rows.push(serde_json::json!({
                    "seq": i,
                    "level": "info",
                    "service": "worker",
                    "message": "heartbeat ok"
                }));
            }
        }
        let raw = serde_json::to_string(&rows).unwrap();
        let store = ContextStore::open_in_memory().unwrap();
        let ccr = CcrStore::new(store);
        let crusher = SmartCrusher::default();

        let res = crusher.crush(&raw, Some(&ccr)).unwrap();
        assert_eq!(res.stage, "statistical_anchors_ccr");
        assert!(res.output.contains("fatal panic in scheduler loop"));
        assert!(res.output.contains("<<ccr:"));
        let hash = res.ccr_hash.expect("ccr hash present");
        let recovered = ccr.retrieve(&hash).unwrap();
        assert_eq!(recovered.original_text, raw);
    }

    #[test]
    fn voice_config_uses_tight_ratios_and_caps_budget() {
        let cfg = CrusherConfig::voice();
        assert_eq!(cfg.max_tokens, 220);
        assert!((cfg.head_ratio - 0.70).abs() < f64::EPSILON);
        assert!((cfg.tail_ratio - 0.25).abs() < f64::EPSILON);

        let crusher = SmartCrusher::new(cfg);
        let long_text = format!(
            "HEAD_STATUS: 3 files modified\n{}\nTAIL_RESULT: build green",
            "detail: intermediate status line\n".repeat(120)
        );
        let store = ContextStore::open_in_memory().unwrap();
        let ccr = CcrStore::new(store);
        let (packed, hash) = crusher.fit_budget(&long_text, None, Some(&ccr), &long_text);
        assert!(estimate_tokens(&packed) <= 220);
        assert!(packed.contains("HEAD_STATUS: 3 files modified"));
        assert!(packed.contains("TAIL_RESULT: build green"));
        assert!(hash.is_some());
    }
}
