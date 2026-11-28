use std::collections::{HashMap, HashSet};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::browser_cache::redact_sensitive_browser_text;
use crate::error::{CtxError, Result};
use crate::store::{now_unix_secs, ContextStore};
use crate::tokens::short_hash;

pub const DEFAULT_RECIPE_TTL_SECS: i64 = 7 * 86_400;
pub const DEFAULT_STRUCTURE_SIMILARITY_THRESHOLD: f64 = 0.80;

/// Locator specification used by deterministic browser action replay steps.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LocatorSpec {
    pub role: String,
    pub name: String,
    pub landmark: Option<String>,
    pub stable_key: Option<String>,
    pub css_fallback: Option<String>,
}

/// Single deterministic action step inside a [`BrowserRecipe`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BrowserActionStep {
    pub step_index: usize,
    pub action: String,
    pub primary_locator: LocatorSpec,
    #[serde(default)]
    pub fallback_locators: Vec<LocatorSpec>,
    pub value_or_param: Option<String>,
    pub param_slot: Option<String>,
    pub expected_landmark_hash: Option<String>,
}

/// Verified multi-step browser interaction recipe keyed by `(origin, route_pattern, intent)`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BrowserRecipe {
    pub recipe_key: String,
    pub origin: String,
    pub route_pattern: String,
    pub structure_hash: String,
    pub landmark_keys: Vec<String>,
    pub intent: String,
    pub steps: Vec<BrowserActionStep>,
    pub success_count: u64,
    pub failure_count: u64,
    pub consecutive_failures: u64,
    pub quarantined: bool,
    pub last_verified_at: i64,
    pub expires_at: i64,
    pub created_at: i64,
}

/// Outcome returned by [`BrowserRecipeStore::resolve`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RecipeLookupResult {
    Hit {
        recipe: BrowserRecipe,
        similarity: f64,
    },
    Quarantined {
        recipe_key: String,
        reason: String,
    },
    StructureMismatch {
        recipe_key: String,
        similarity: f64,
        threshold: f64,
    },
    Miss,
}

/// Persistent store for verified UI interaction recipes with 2-strike quarantine and self-healing.
#[derive(Clone)]
pub struct BrowserRecipeStore {
    store: ContextStore,
}

impl BrowserRecipeStore {
    pub fn new(store: ContextStore) -> Self {
        Self { store }
    }

    /// Deterministic key for `(origin, route_pattern, intent)`.
    pub fn make_recipe_key(origin: &str, route_pattern: &str, intent: &str) -> String {
        short_hash(&format!(
            "{}|{}|{}",
            origin.trim().to_ascii_lowercase(),
            route_pattern.trim(),
            intent.trim().to_ascii_lowercase()
        ))
    }

    /// Insert or update a verified recipe, rejecting any raw secret/password literals.
    pub fn upsert_recipe(&self, mut recipe: BrowserRecipe) -> Result<BrowserRecipe> {
        validate_steps_no_secrets(&recipe.steps)?;

        let now = now_unix_secs();
        if recipe.recipe_key.trim().is_empty() {
            recipe.recipe_key =
                Self::make_recipe_key(&recipe.origin, &recipe.route_pattern, &recipe.intent);
        }
        if recipe.created_at == 0 {
            recipe.created_at = now;
        }
        if recipe.last_verified_at == 0 {
            recipe.last_verified_at = now;
        }
        if recipe.expires_at == 0 {
            recipe.expires_at = now + DEFAULT_RECIPE_TTL_SECS;
        }

        let landmark_keys_json = serde_json::to_string(&recipe.landmark_keys)?;
        let steps_json = serde_json::to_string(&recipe.steps)?;

        self.store.with_conn(|conn| {
            conn.execute(
                "INSERT INTO browser_recipes (
                    recipe_key, origin, route_pattern, structure_hash, landmark_keys_json,
                    intent, steps_json, success_count, failure_count, consecutive_failures,
                    quarantined, last_verified_at, expires_at, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                ON CONFLICT(recipe_key) DO UPDATE SET
                    origin = excluded.origin,
                    route_pattern = excluded.route_pattern,
                    structure_hash = excluded.structure_hash,
                    landmark_keys_json = excluded.landmark_keys_json,
                    intent = excluded.intent,
                    steps_json = excluded.steps_json,
                    success_count = excluded.success_count,
                    failure_count = excluded.failure_count,
                    consecutive_failures = excluded.consecutive_failures,
                    quarantined = excluded.quarantined,
                    last_verified_at = excluded.last_verified_at,
                    expires_at = excluded.expires_at",
                params![
                    recipe.recipe_key,
                    recipe.origin,
                    recipe.route_pattern,
                    recipe.structure_hash,
                    landmark_keys_json,
                    recipe.intent,
                    steps_json,
                    recipe.success_count as i64,
                    recipe.failure_count as i64,
                    recipe.consecutive_failures as i64,
                    i64::from(recipe.quarantined),
                    recipe.last_verified_at,
                    recipe.expires_at,
                    recipe.created_at
                ],
            )?;
            Ok(())
        })?;

        Ok(recipe)
    }

    /// Resolve a stored recipe for `(origin, route, intent)` gated by structural similarity (`>= 0.80`).
    pub fn resolve(
        &self,
        origin: &str,
        route: &str,
        intent: &str,
        current_structure_hash: &str,
        current_landmark_keys: &[String],
    ) -> Result<RecipeLookupResult> {
        let now = now_unix_secs();
        let candidates = self.store.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT recipe_key, origin, route_pattern, structure_hash, landmark_keys_json,
                        intent, steps_json, success_count, failure_count, consecutive_failures,
                        quarantined, last_verified_at, expires_at, created_at
                 FROM browser_recipes
                 WHERE origin = ?1 AND lower(intent) = lower(?2) AND expires_at > ?3
                 ORDER BY last_verified_at DESC",
            )?;
            let rows = stmt.query_map(params![origin, intent.trim(), now], row_to_recipe)?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok(out)
        })?;

        let Some(recipe) = candidates
            .into_iter()
            .find(|r| route_matches(&r.route_pattern, route))
        else {
            return Ok(RecipeLookupResult::Miss);
        };

        if recipe.quarantined {
            return Ok(RecipeLookupResult::Quarantined {
                recipe_key: recipe.recipe_key,
                reason: format!(
                    "Recipe quarantined after {} consecutive failures",
                    recipe.consecutive_failures
                ),
            });
        }

        let similarity = if current_structure_hash == recipe.structure_hash {
            1.0
        } else {
            jaccard_similarity(&recipe.landmark_keys, current_landmark_keys)
        };

        if similarity >= DEFAULT_STRUCTURE_SIMILARITY_THRESHOLD {
            Ok(RecipeLookupResult::Hit { recipe, similarity })
        } else {
            Ok(RecipeLookupResult::StructureMismatch {
                recipe_key: recipe.recipe_key,
                similarity,
                threshold: DEFAULT_STRUCTURE_SIMILARITY_THRESHOLD,
            })
        }
    }

    /// Record a successful replay, resetting consecutive failure streak and clearing quarantine.
    pub fn record_success(&self, recipe_key: &str) -> Result<()> {
        let now = now_unix_secs();
        let updated = self.store.with_conn(|conn| {
            let rows = conn.execute(
                "UPDATE browser_recipes
                 SET success_count = success_count + 1,
                     consecutive_failures = 0,
                     quarantined = 0,
                     last_verified_at = ?1
                 WHERE recipe_key = ?2",
                params![now, recipe_key],
            )?;
            Ok(rows)
        })?;
        if updated == 0 {
            return Err(CtxError::NotFound(format!(
                "browser recipe '{recipe_key}' not found"
            )));
        }
        Ok(())
    }

    /// Record a replay failure, auto-quarantining on the 2nd consecutive failure.
    /// Returns `true` when the recipe is quarantined.
    pub fn record_failure(&self, recipe_key: &str) -> Result<bool> {
        self.store.with_conn(|conn| {
            let prev: Option<i64> = conn
                .query_row(
                    "SELECT consecutive_failures FROM browser_recipes WHERE recipe_key = ?1",
                    params![recipe_key],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(prev_streak) = prev else {
                return Err(CtxError::NotFound(format!(
                    "browser recipe '{recipe_key}' not found"
                )));
            };
            let new_streak = prev_streak + 1;
            let quarantined = new_streak >= 2;
            conn.execute(
                "UPDATE browser_recipes
                 SET failure_count = failure_count + 1,
                     consecutive_failures = ?1,
                     quarantined = ?2
                 WHERE recipe_key = ?3",
                params![new_streak, i64::from(quarantined), recipe_key],
            )?;
            Ok(quarantined)
        })
    }

    /// Patch a broken step's primary locator (demoting the old primary to fallbacks),
    /// optionally refresh structural hashes, and un-quarantine the recipe.
    pub fn patch_step_and_heal(
        &self,
        recipe_key: &str,
        step_index: usize,
        healed_locator: LocatorSpec,
        new_structure_hash: Option<&str>,
        new_landmark_keys: Option<&[String]>,
    ) -> Result<BrowserRecipe> {
        let mut recipe = self
            .get_recipe(recipe_key)?
            .ok_or_else(|| CtxError::NotFound(format!("browser recipe '{recipe_key}' not found")))?;

        let Some(step) = recipe
            .steps
            .iter_mut()
            .find(|s| s.step_index == step_index)
        else {
            return Err(CtxError::InvalidInput(format!(
                "step_index {step_index} not found in recipe '{recipe_key}'"
            )));
        };

        if step.primary_locator != healed_locator {
            let old = std::mem::replace(&mut step.primary_locator, healed_locator);
            if !step.fallback_locators.contains(&old) {
                step.fallback_locators.insert(0, old);
            }
        }

        if let Some(sh) = new_structure_hash {
            recipe.structure_hash = sh.to_string();
        }
        if let Some(keys) = new_landmark_keys {
            recipe.landmark_keys = keys.to_vec();
        }
        recipe.consecutive_failures = 0;
        recipe.quarantined = false;
        recipe.last_verified_at = now_unix_secs();

        self.upsert_recipe(recipe)
    }

    /// Substitute `{{param}}` slots in recipe steps using runtime arguments.
    /// Rejects missing required slots or unsafe secret injections? Wait: runtime substitution
    /// produces transient execution steps (not persisted).
    pub fn substitute_params(
        &self,
        steps: &[BrowserActionStep],
        params: &HashMap<String, String>,
    ) -> Result<Vec<BrowserActionStep>> {
        let mut out = Vec::with_capacity(steps.len());
        for step in steps {
            let mut cloned = step.clone();
            if let Some(slot) = &cloned.param_slot {
                let Some(val) = params.get(slot) else {
                    return Err(CtxError::InvalidInput(format!(
                        "missing required recipe parameter '{slot}'"
                    )));
                };
                cloned.value_or_param = Some(val.clone());
            } else if let Some(raw_val) = &cloned.value_or_param {
                let mut replaced = raw_val.clone();
                for (k, v) in params {
                    let placeholder = format!("{{{{{k}}}}}");
                    if replaced.contains(&placeholder) {
                        replaced = replaced.replace(&placeholder, v);
                    }
                }
                if replaced.contains("{{") && replaced.contains("}}") {
                    return Err(CtxError::InvalidInput(format!(
                        "unresolved template placeholder in step {}: '{replaced}'",
                        cloned.step_index
                    )));
                }
                cloned.value_or_param = Some(replaced);
            }
            out.push(cloned);
        }
        Ok(out)
    }

    /// List all non-expired recipes for a given origin.
    pub fn list_for_origin(&self, origin: &str) -> Result<Vec<BrowserRecipe>> {
        let now = now_unix_secs();
        self.store.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT recipe_key, origin, route_pattern, structure_hash, landmark_keys_json,
                        intent, steps_json, success_count, failure_count, consecutive_failures,
                        quarantined, last_verified_at, expires_at, created_at
                 FROM browser_recipes
                 WHERE origin = ?1 AND expires_at > ?2
                 ORDER BY last_verified_at DESC",
            )?;
            let rows = stmt.query_map(params![origin, now], row_to_recipe)?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok(out)
        })
    }

    fn get_recipe(&self, recipe_key: &str) -> Result<Option<BrowserRecipe>> {
        self.store.with_conn(|conn| {
            conn.query_row(
                "SELECT recipe_key, origin, route_pattern, structure_hash, landmark_keys_json,
                        intent, steps_json, success_count, failure_count, consecutive_failures,
                        quarantined, last_verified_at, expires_at, created_at
                 FROM browser_recipes
                 WHERE recipe_key = ?1",
                params![recipe_key],
                row_to_recipe,
            )
            .optional()
            .map_err(Into::into)
        })
    }
}

fn row_to_recipe(r: &rusqlite::Row<'_>) -> rusqlite::Result<BrowserRecipe> {
    let landmark_raw: String = r.get(4)?;
    let steps_raw: String = r.get(6)?;
    let landmark_keys = serde_json::from_str(&landmark_raw).unwrap_or_default();
    let steps = serde_json::from_str(&steps_raw).unwrap_or_default();
    Ok(BrowserRecipe {
        recipe_key: r.get(0)?,
        origin: r.get(1)?,
        route_pattern: r.get(2)?,
        structure_hash: r.get(3)?,
        landmark_keys,
        intent: r.get(5)?,
        steps,
        success_count: r.get::<_, i64>(7)?.max(0) as u64,
        failure_count: r.get::<_, i64>(8)?.max(0) as u64,
        consecutive_failures: r.get::<_, i64>(9)?.max(0) as u64,
        quarantined: r.get::<_, i64>(10)? != 0,
        last_verified_at: r.get(11)?,
        expires_at: r.get(12)?,
        created_at: r.get(13)?,
    })
}

fn is_template_placeholder(val: &str) -> bool {
    let t = val.trim();
    t.starts_with("{{") && t.ends_with("}}") && t.len() > 4
}

fn validate_steps_no_secrets(steps: &[BrowserActionStep]) -> Result<()> {
    for step in steps {
        let locator_label = step.primary_locator.name.to_ascii_lowercase();
        let locator_role = step.primary_locator.role.to_ascii_lowercase();
        let is_secret_field = locator_role.contains("password")
            || [
                "password",
                "passwd",
                "passcode",
                "pin",
                "secret",
                "token",
                "api key",
                "api_key",
                "cvv",
                "cvc",
                "cc-number",
                "cc-csc",
                "credit card",
            ]
            .iter()
            .any(|kw| locator_label.contains(kw));

        if let Some(val) = &step.value_or_param {
            let trimmed = val.trim();
            if !trimmed.is_empty() && !is_template_placeholder(trimmed) {
                if is_secret_field {
                    return Err(CtxError::InvalidInput(format!(
                        "refusing to persist raw secret/password literal in recipe step {}; use a {{{{param}}}} slot",
                        step.step_index
                    )));
                }
                if redact_sensitive_browser_text(trimmed) != trimmed {
                    return Err(CtxError::InvalidInput(format!(
                        "refusing to persist sensitive credential/token pattern in recipe step {}",
                        step.step_index
                    )));
                }
            }
        }
    }
    Ok(())
}

fn strip_query(s: &str) -> &str {
    s.split('?').next().unwrap_or(s)
}

fn route_matches(pattern: &str, actual: &str) -> bool {
    if pattern == actual {
        return true;
    }
    let pat_path = strip_query(pattern);
    let act_path = strip_query(actual);
    if pat_path == act_path {
        return true;
    }
    if let Some(prefix) = pat_path.strip_suffix("/*") {
        return act_path == prefix || act_path.starts_with(&format!("{prefix}/"));
    }
    let pat_segs: Vec<&str> = pat_path.split('/').collect();
    let act_segs: Vec<&str> = act_path.split('/').collect();
    if pat_segs.len() != act_segs.len() {
        return false;
    }
    pat_segs
        .iter()
        .zip(act_segs.iter())
        .all(|(p, a)| *p == "*" || p.starts_with(':') || p == a)
}

fn jaccard_similarity(a: &[String], b: &[String]) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 0.0;
    }
    let set_a: HashSet<&str> = a.iter().map(String::as_str).collect();
    let set_b: HashSet<&str> = b.iter().map(String::as_str).collect();
    let inter = set_a.intersection(&set_b).count() as f64;
    let union = set_a.union(&set_b).count() as f64;
    if union == 0.0 {
        0.0
    } else {
        inter / union
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_step(idx: usize, action: &str, name: &str, param: Option<&str>, val: Option<&str>) -> BrowserActionStep {
        BrowserActionStep {
            step_index: idx,
            action: action.to_string(),
            primary_locator: LocatorSpec {
                role: "textbox".to_string(),
                name: name.to_string(),
                landmark: Some("main".to_string()),
                stable_key: Some(format!("k{idx}")),
                css_fallback: None,
            },
            fallback_locators: vec![],
            value_or_param: val.map(str::to_string),
            param_slot: param.map(str::to_string),
            expected_landmark_hash: Some("lm-main".to_string()),
        }
    }

    #[test]
    fn upserts_resolves_with_structural_gating_and_substitutes_params() {
        let store = ContextStore::open_in_memory().unwrap();
        let recipes = BrowserRecipeStore::new(store);

        let recipe = BrowserRecipe {
            recipe_key: String::new(),
            origin: "http://localhost:5173".to_string(),
            route_pattern: "http://localhost:5173/projects/:id/settings".to_string(),
            structure_hash: "struct-v1".to_string(),
            landmark_keys: vec![
                "k1".to_string(),
                "k2".to_string(),
                "k3".to_string(),
                "k4".to_string(),
                "k5".to_string(),
            ],
            intent: "update project name".to_string(),
            steps: vec![
                mk_step(0, "fill", "Project Name", Some("project_name"), Some("{{project_name}}")),
                mk_step(1, "click", "Save", None, None),
            ],
            success_count: 1,
            failure_count: 0,
            consecutive_failures: 0,
            quarantined: false,
            last_verified_at: 0,
            expires_at: 0,
            created_at: 0,
        };

        let saved = recipes.upsert_recipe(recipe).unwrap();
        assert!(!saved.recipe_key.is_empty());

        // Exact structural match via route param
        let hit = recipes
            .resolve(
                "http://localhost:5173",
                "http://localhost:5173/projects/42/settings",
                "update project name",
                "struct-v1",
                &[],
            )
            .unwrap();
        let RecipeLookupResult::Hit { recipe: found, similarity } = hit else {
            panic!("expected Hit, got {hit:?}");
        };
        assert_eq!(similarity, 1.0);

        // Partial landmark similarity >= 0.80 (4/5 = 0.80) still hits
        let partial_hit = recipes
            .resolve(
                "http://localhost:5173",
                "http://localhost:5173/projects/99/settings",
                "update project name",
                "struct-v2",
                &[
                    "k1".to_string(),
                    "k2".to_string(),
                    "k3".to_string(),
                    "k4".to_string(),
                ],
            )
            .unwrap();
        assert!(matches!(partial_hit, RecipeLookupResult::Hit { .. }));

        // Low similarity (< 0.80) triggers StructureMismatch
        let mismatch = recipes
            .resolve(
                "http://localhost:5173",
                "http://localhost:5173/projects/99/settings",
                "update project name",
                "struct-broken",
                &["k1".to_string(), "other".to_string()],
            )
            .unwrap();
        assert!(matches!(mismatch, RecipeLookupResult::StructureMismatch { .. }));

        let mut args = HashMap::new();
        args.insert("project_name".to_string(), "Kite v2".to_string());
        let resolved_steps = recipes.substitute_params(&found.steps, &args).unwrap();
        assert_eq!(resolved_steps[0].value_or_param.as_deref(), Some("Kite v2"));

        let list = recipes.list_for_origin("http://localhost:5173").unwrap();
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn quarantines_after_two_consecutive_failures_and_self_heals() {
        let store = ContextStore::open_in_memory().unwrap();
        let recipes = BrowserRecipeStore::new(store);

        let saved = recipes
            .upsert_recipe(BrowserRecipe {
                recipe_key: "r-checkout".to_string(),
                origin: "http://localhost:5173".to_string(),
                route_pattern: "http://localhost:5173/cart".to_string(),
                structure_hash: "s1".to_string(),
                landmark_keys: vec!["a".to_string()],
                intent: "submit cart".to_string(),
                steps: vec![mk_step(0, "click", "Checkout", None, None)],
                success_count: 2,
                failure_count: 0,
                consecutive_failures: 0,
                quarantined: false,
                last_verified_at: 0,
                expires_at: 0,
                created_at: 0,
            })
            .unwrap();

        // 1st failure does not quarantine yet
        assert!(!recipes.record_failure(&saved.recipe_key).unwrap());
        // 2nd consecutive failure quarantines
        assert!(recipes.record_failure(&saved.recipe_key).unwrap());

        let res = recipes
            .resolve(
                "http://localhost:5173",
                "http://localhost:5173/cart",
                "submit cart",
                "s1",
                &["a".to_string()],
            )
            .unwrap();
        assert!(matches!(res, RecipeLookupResult::Quarantined { .. }));

        // Heal step 0 -> un-quarantines and keeps old primary as fallback
        let healed = recipes
            .patch_step_and_heal(
                &saved.recipe_key,
                0,
                LocatorSpec {
                    role: "button".to_string(),
                    name: "Proceed to Checkout".to_string(),
                    landmark: Some("main".to_string()),
                    stable_key: Some("k-new".to_string()),
                    css_fallback: None,
                },
                Some("s2"),
                None,
            )
            .unwrap();
        assert!(!healed.quarantined);
        assert_eq!(healed.consecutive_failures, 0);
        assert_eq!(healed.steps[0].fallback_locators.len(), 1);
        assert_eq!(healed.steps[0].fallback_locators[0].name, "Checkout");
    }

    #[test]
    fn refuses_to_persist_raw_passwords_or_secrets() {
        let store = ContextStore::open_in_memory().unwrap();
        let recipes = BrowserRecipeStore::new(store);

        let bad_pw = BrowserRecipe {
            recipe_key: String::new(),
            origin: "http://localhost:5173".to_string(),
            route_pattern: "http://localhost:5173/login".to_string(),
            structure_hash: "s-login".to_string(),
            landmark_keys: vec!["pw".to_string()],
            intent: "login".to_string(),
            steps: vec![mk_step(0, "fill", "Password", None, Some("hunter2"))],
            success_count: 0,
            failure_count: 0,
            consecutive_failures: 0,
            quarantined: false,
            last_verified_at: 0,
            expires_at: 0,
            created_at: 0,
        };
        assert!(recipes.upsert_recipe(bad_pw).is_err());

        // Parameterized slot `{{password}}` is allowed
        let safe_pw = BrowserRecipe {
            recipe_key: String::new(),
            origin: "http://localhost:5173".to_string(),
            route_pattern: "http://localhost:5173/login".to_string(),
            structure_hash: "s-login".to_string(),
            landmark_keys: vec!["pw".to_string()],
            intent: "login".to_string(),
            steps: vec![mk_step(0, "fill", "Password", Some("password"), Some("{{password}}"))],
            success_count: 0,
            failure_count: 0,
            consecutive_failures: 0,
            quarantined: false,
            last_verified_at: 0,
            expires_at: 0,
            created_at: 0,
        };
        assert!(recipes.upsert_recipe(safe_pw).is_ok());
    }
}
