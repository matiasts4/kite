use crate::logger::log_trace;
use crate::persist::body;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use uuid::Uuid;

/// Error codes returned to the UI. A rejected command is shown as an honest
/// error state; no surface or page data is ever fabricated for a missing id.
pub const ERR_INVALID: &str = "browser_invalid_request";
pub const ERR_NOT_FOUND: &str = "browser_not_found";
pub const ERR_UNAVAILABLE: &str = "browser_unavailable";

const MAX_URL_LENGTH: usize = 2048;
const MAX_BOUNDS_VALUE: f64 = 32768.0;
/// Parked position for a hidden child webview (matches the UI's hide contract).
const OFFSCREEN: (f64, f64, f64, f64) = (-10000.0, -10000.0, 1.0, 1.0);

#[derive(Clone)]
pub struct SurfacePlacement {
    pub surface_id: String,
    pub workspace_id: Option<String>,
    pub label: String,
    pub url: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub visible: bool,
    pub view: Value,
}

pub struct SurfaceRecord {
    pub surface_id: String,
    pub descriptor_id: String,
    pub workspace_id: Option<String>,
    pub url: String,
    pub title: String,
    pub visible: bool,
    pub revision: i64,
    pub label: String,
    pub design_mode: bool,
    pub loading: bool,
    pub history: Vec<String>,
    pub history_index: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub owner_kind: String,
    pub owner_thread_id: Option<String>,
    pub agent_active: bool,
    pub status_pill: Option<String>,
    pub paused_for_auth: bool,
    pub pause_reason: Option<String>,
    pub takeover_requested: bool,
    pub isolated: bool,
}

pub fn surfaces() -> &'static Mutex<HashMap<String, SurfaceRecord>> {
    static CELL: std::sync::OnceLock<Mutex<HashMap<String, SurfaceRecord>>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Accepts an absolute http(s) address without control characters, whitespace,
/// or userinfo. Returns (stored URL, display URL); the display URL drops query and fragment.
pub fn browser_urls(raw: &str) -> Option<(String, String)> {
    let raw = raw.trim();
    if raw.len() > MAX_URL_LENGTH || raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    if !(raw.starts_with("https://") || raw.starts_with("http://")) || authority_has_userinfo(raw) {
        return None;
    }
    let display = raw.split(['?', '#']).next().unwrap_or("").to_string();
    if hostname_of(&display).is_empty() {
        return None;
    }
    Some((raw.to_string(), display))
}

fn authority_has_userinfo(url: &str) -> bool {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    rest.split(['/', '?', '#']).next().unwrap_or("").contains('@')
}

pub fn hostname_of(url: &str) -> String {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    let hostport = rest.split('/').next().unwrap_or("");
    if let Some(inner) = hostport.strip_prefix('[') {
        inner.split(']').next().unwrap_or("").to_string()
    } else {
        hostport.split(':').next().unwrap_or("").to_string()
    }
}

pub fn transport_of(display: &str) -> &'static str {
    if display.starts_with("https://") {
        return "secure";
    }
    let host = hostname_of(display).to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host == "::1" {
        return "local";
    }
    let parts: Vec<&str> = host.split('.').collect();
    let loopback = parts.len() == 4
        && parts[0] == "127"
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 3
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && part.parse::<u16>().ok().is_some_and(|value| value <= 255)
        });
    if loopback { "local" } else { "insecure" }
}

pub fn surface_view(record: &SurfaceRecord) -> Value {
    let display = browser_urls(&record.url)
        .map(|(_, display)| display)
        .unwrap_or_else(|| record.url.clone());
    let transport = transport_of(&display);
    let can_go_back = record.history_index > 0;
    let can_go_forward = record.history_index + 1 < record.history.len();
    json!({
        "schemaVersion": 1,
        "surfaceId": record.surface_id,
        "descriptorId": record.descriptor_id,
        "workspaceId": record.workspace_id,
        "revision": record.revision,
        "displayUrl": display,
        "transportSecurity": transport,
        "title": record.title,
        "loading": record.loading,
        "canGoBack": can_go_back,
        "canGoForward": can_go_forward,
        "visible": record.visible,
        "designMode": record.design_mode,
        "ownerKind": record.owner_kind,
        "ownerThreadId": record.owner_thread_id,
        "agentActive": record.agent_active,
        "statusPill": record.status_pill,
        "pausedForAuth": record.paused_for_auth,
        "pauseReason": record.pause_reason,
        "takeoverRequested": record.takeover_requested,
        "isolated": record.isolated
    })
}

pub fn placement_of(record: &SurfaceRecord) -> SurfacePlacement {
    SurfacePlacement {
        surface_id: record.surface_id.clone(),
        workspace_id: record.workspace_id.clone(),
        label: record.label.clone(),
        url: record.url.clone(),
        x: record.x,
        y: record.y,
        width: record.width,
        height: record.height,
        visible: record.visible,
        view: surface_view(record),
    }
}

fn label_for(surface_id: &str) -> String {
    format!("b{}", surface_id.replace('-', ""))
}

fn read_bounds(bounds: Option<&Value>) -> Result<(f64, f64, f64, f64), String> {
    let bounds = bounds.ok_or_else(|| ERR_INVALID.to_string())?;
    let field = |key: &str| {
        bounds
            .get(key)
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .ok_or_else(|| ERR_INVALID.to_string())
    };
    let (x, y, width, height) = (field("x")?, field("y")?, field("width")?, field("height")?);
    let in_range = |value: f64, min: f64| value >= min && value <= MAX_BOUNDS_VALUE;
    if !(in_range(x, 0.0) && in_range(y, 0.0) && in_range(width, 1.0) && in_range(height, 1.0)) {
        return Err(ERR_INVALID.to_string());
    }
    Ok((x, y, width, height))
}

fn required_str<'a>(source: &'a Value, key: &str) -> Result<&'a str, String> {
    source
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ERR_INVALID.to_string())
}

fn required_url(request: &Value) -> Result<String, String> {
    let raw = required_str(request, "url")?;
    browser_urls(raw)
        .map(|(stored, _)| stored)
        .ok_or_else(|| ERR_INVALID.to_string())
}

fn target_ids(request: &Value) -> Result<(String, String), String> {
    let target = request.get("target").unwrap_or(request);
    let surface_id = required_str(target, "surfaceId")?.to_string();
    let descriptor_id = required_str(target, "descriptorId")?.to_string();
    Ok((surface_id, descriptor_id))
}

/// Looks up a surface that the caller owns. Unknown or foreign ids are rejected.
fn existing_record_mut<'a>(
    map: &'a mut HashMap<String, SurfaceRecord>,
    surface_id: &str,
    descriptor_id: &str,
) -> Result<&'a mut SurfaceRecord, String> {
    match map.get_mut(surface_id) {
        Some(record) if record.descriptor_id == descriptor_id => Ok(record),
        _ => Err(ERR_NOT_FOUND.to_string()),
    }
}

fn existing_record<'a>(
    map: &'a HashMap<String, SurfaceRecord>,
    surface_id: &str,
    descriptor_id: &str,
) -> Result<&'a SurfaceRecord, String> {
    match map.get(surface_id) {
        Some(record) if record.descriptor_id == descriptor_id => Ok(record),
        _ => Err(ERR_NOT_FOUND.to_string()),
    }
}

pub fn open_surface(request: &Value) -> Result<SurfacePlacement, String> {
    let target = request.get("target").unwrap_or(request);
    let owner = request.get("owner").unwrap_or(target);
    let descriptor_id = owner
        .get("descriptorId")
        .or_else(|| target.get("descriptorId"))
        .or_else(|| request.get("descriptorId"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| ERR_INVALID.to_string())?
        .to_string();
    let surface_id = request
        .get("surfaceId")
        .and_then(Value::as_str)
        .or_else(|| target.get("surfaceId").and_then(Value::as_str))
        .or_else(|| owner.get("surfaceId").and_then(Value::as_str))
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let url = required_url(request)?;
    let visible = request.get("visible").and_then(Value::as_bool).unwrap_or(true);
    let (x, y, width, height) = read_bounds(request.get("bounds"))?;
    let workspace_id = owner
        .get("workspaceId")
        .or_else(|| request.get("workspaceId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let owner_kind = request
        .get("ownerKind")
        .or_else(|| owner.get("ownerKind"))
        .and_then(Value::as_str)
        .filter(|s| matches!(*s, "user" | "agent"))
        .unwrap_or("user")
        .to_string();
    let owner_thread_id = request
        .get("ownerThreadId")
        .or_else(|| owner.get("ownerThreadId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let isolated = request
        .get("isolated")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let record = SurfaceRecord {
        surface_id: surface_id.clone(),
        descriptor_id,
        workspace_id,
        url: url.clone(),
        title: String::new(),
        visible,
        revision: 1,
        label: label_for(&surface_id),
        design_mode: false,
        loading: false,
        history: vec![url],
        history_index: 0,
        x,
        y,
        width,
        height,
        owner_kind: owner_kind.clone(),
        owner_thread_id,
        agent_active: owner_kind == "agent",
        status_pill: None,
        paused_for_auth: false,
        pause_reason: None,
        takeover_requested: false,
        isolated,
    };
    let placement = placement_of(&record);
    surfaces().lock().unwrap().insert(surface_id, record);
    Ok(placement)
}

/// Navigates an existing surface. Visibility is owned by the presentation
/// contract, so navigation never reveals a surface that the UI has hidden.
pub fn navigate_surface(request: &Value) -> Result<SurfacePlacement, String> {
    let (surface_id, descriptor_id) = target_ids(request)?;
    let url = required_url(request)?;
    let mut map = surfaces().lock().unwrap();
    let record = existing_record_mut(&mut map, &surface_id, &descriptor_id)?;
    if record.url != url {
        record.history.truncate(record.history_index + 1);
        record.history.push(url.clone());
        record.history_index = record.history.len() - 1;
    }
    record.url = url;
    record.revision = record.revision.saturating_add(1);
    Ok(placement_of(record))
}

pub fn present_surface(request: &Value) -> Result<SurfacePlacement, String> {
    let (surface_id, descriptor_id) = target_ids(request)?;
    let visible = request
        .get("visible")
        .and_then(Value::as_bool)
        .ok_or_else(|| ERR_INVALID.to_string())?;
    let (x, y, width, height) = read_bounds(request.get("bounds"))?;
    let mut map = surfaces().lock().unwrap();
    let record = existing_record_mut(&mut map, &surface_id, &descriptor_id)?;
    record.visible = visible;
    record.x = x;
    record.y = y;
    record.width = width;
    record.height = height;
    record.revision = record.revision.saturating_add(1);
    Ok(placement_of(record))
}

pub fn control_surface(request: &Value) -> Result<(SurfacePlacement, String, bool), String> {
    let (surface_id, descriptor_id) = target_ids(request)?;
    let action = required_str(request, "action")?.to_string();
    if !matches!(
        action.as_str(),
        "back" | "forward" | "reload" | "stop" | "openExternal" | "startDesignMode" | "stopDesignMode"
    ) {
        return Err(ERR_INVALID.to_string());
    }
    let mut map = surfaces().lock().unwrap();
    let record = existing_record_mut(&mut map, &surface_id, &descriptor_id)?;
    let mut traversed = false;
    match action.as_str() {
        "startDesignMode" => {
            record.design_mode = true;
            record.revision = record.revision.saturating_add(1);
        }
        "stopDesignMode" => {
            record.design_mode = false;
            record.revision = record.revision.saturating_add(1);
        }
        "back" => {
            if record.history_index > 0 {
                record.history_index -= 1;
                record.url = record.history[record.history_index].clone();
                record.revision = record.revision.saturating_add(1);
                traversed = true;
            }
        }
        "forward" => {
            if record.history_index + 1 < record.history.len() {
                record.history_index += 1;
                record.url = record.history[record.history_index].clone();
                record.revision = record.revision.saturating_add(1);
                traversed = true;
            }
        }
        _ => {}
    }
    Ok((placement_of(record), action, traversed))
}

fn accepted_navigation_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let (stored, _) = browser_urls(trimmed)?;
    (stored == trimmed).then_some(stored)
}

fn child_navigation_allowed(raw: &str) -> bool {
    let trimmed = raw.trim();
    let bare = trimmed.split(['?', '#']).next().unwrap_or(trimmed);
    // WebView2 can raise about:blank before the first http(s) document. It is not history.
    bare == "about:blank" || accepted_navigation_url(trimmed).is_some()
}

fn same_place(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let (Ok(mut left_url), Ok(mut right_url)) = (tauri::Url::parse(left), tauri::Url::parse(right)) else {
        return false;
    };
    left_url.set_fragment(None);
    right_url.set_fragment(None);
    left_url == right_url
}

fn apply_observed_navigation(record: &mut SurfaceRecord, url: String) {
    let current = record
        .history
        .get(record.history_index)
        .map(|entry| entry.as_str())
        .unwrap_or(record.url.as_str());
    if same_place(current, &url) || same_place(&record.url, &url) {
        return;
    }
    if record.history_index > 0
        && record
            .history
            .get(record.history_index - 1)
            .is_some_and(|entry| same_place(entry, &url))
    {
        record.history_index -= 1;
        record.url = record.history[record.history_index].clone();
        record.revision = record.revision.saturating_add(1);
        return;
    }
    if record
        .history
        .get(record.history_index + 1)
        .is_some_and(|entry| same_place(entry, &url))
    {
        record.history_index += 1;
        record.url = record.history[record.history_index].clone();
        record.revision = record.revision.saturating_add(1);
        return;
    }
    record.history.truncate(record.history_index + 1);
    record.history.push(url.clone());
    record.history_index = record.history.len() - 1;
    record.url = url;
    record.revision = record.revision.saturating_add(1);
}

/// Records a navigation that originated in the child webview.
/// Rejected URLs (see `browser_urls`) return false and do not enter history.
fn record_child_navigation(label: &str, raw: &str) -> bool {
    let Some(url) = accepted_navigation_url(raw) else {
        return false;
    };
    let mut map = surfaces().lock().unwrap();
    let Some(record) = map.values_mut().find(|record| record.label == label) else {
        return true;
    };
    apply_observed_navigation(record, url);
    true
}

/// Mirrors the child webview's load state so the UI reflects a loading page.
fn record_child_loading(label: &str, loading: bool) {
    let mut map = surfaces().lock().unwrap();
    if let Some(record) = map.values_mut().find(|record| record.label == label) {
        if record.loading != loading {
            record.loading = loading;
            record.revision = record.revision.saturating_add(1);
        }
    }
}

pub fn close_surface(request: &Value) -> Result<Option<String>, String> {
    let (surface_id, _) = target_ids(request)?;
    Ok(surfaces()
        .lock()
        .unwrap()
        .remove(&surface_id)
        .map(|record| record.label))
}

pub fn read_surface(request: &Value) -> Result<SurfacePlacement, String> {
    let (surface_id, descriptor_id) = target_ids(request)?;
    let map = surfaces().lock().unwrap();
    let record = existing_record(&map, &surface_id, &descriptor_id)?;
    Ok(placement_of(record))
}

fn take_inactive_browser_surface_labels(
    active_workspace_id: Option<&str>,
    active_surface_id: Option<&str>,
) -> Vec<String> {
    let normalized_ws = active_workspace_id.map(str::trim).filter(|s| !s.is_empty());
    let mut map = surfaces().lock().unwrap();
    let mut labels = Vec::new();
    for record in map.values_mut() {
        if active_surface_id.is_some_and(|sid| sid == record.surface_id) {
            continue;
        }
        // Protect active background agent tabs from workspace-switch eviction.
        if record.agent_active || record.paused_for_auth {
            continue;
        }
        let same_workspace = match (normalized_ws, record.workspace_id.as_deref()) {
            (Some(active_ws), Some(rec_ws)) => active_ws == rec_ws,
            (None, None) => active_surface_id.is_none(),
            _ => false,
        };
        if !same_workspace {
            if record.visible || record.loading {
                record.visible = false;
                record.loading = false;
                record.revision = record.revision.saturating_add(1);
            }
            labels.push(record.label.clone());
        }
    }
    labels
}

fn close_inactive_browser_surfaces_except(
    app: &tauri::AppHandle,
    active_workspace_id: Option<&str>,
    active_surface_id: Option<&str>,
) -> usize {
    let labels = take_inactive_browser_surface_labels(active_workspace_id, active_surface_id);
    let mut closed = 0;
    for label in labels {
        if let Some(webview) = app.get_webview(&label) {
            if webview.close().is_ok() {
                closed += 1;
            }
        }
    }
    closed
}

#[allow(dead_code)]
pub fn close_inactive_browser_surfaces(
    app: &tauri::AppHandle,
    active_workspace_id: Option<&str>,
) -> usize {
    close_inactive_browser_surfaces_except(app, active_workspace_id, None)
}

pub async fn mount_browser(app: &tauri::AppHandle, placement: &SurfacePlacement) -> Result<(), String> {
    close_inactive_browser_surfaces_except(
        app,
        placement.workspace_id.as_deref(),
        Some(&placement.surface_id),
    );
    let window = app
        .get_window("main")
        .or_else(|| app.windows().into_values().next())
        .ok_or_else(|| {
            log_trace("browser mount skipped: main window missing");
            ERR_UNAVAILABLE.to_string()
        })?;
    let url: tauri::Url = placement
        .url
        .parse()
        .map_err(|_| ERR_INVALID.to_string())?;
    let (x, y, width, height) = if placement.visible {
        (placement.x, placement.y, placement.width.max(1.0), placement.height.max(1.0))
    } else {
        OFFSCREEN
    };
    if let Some(existing) = app.get_webview(&placement.label) {
        let _ = existing.navigate(url);
        let _ = existing.set_position(tauri::LogicalPosition::new(x, y));
        let _ = existing.set_size(tauri::LogicalSize::new(width, height));
        return Ok(());
    }
    // `on_navigation` and `on_page_load` are the Tauri 2 hooks enabled with the
    // unstable API. Both pass only the URL: WebView2 NavigationKind is not
    // available, and fragment-only navigations do not raise NavigationStarting.
    // An event whose URL matches an adjacent entry moves this stack. Command
    // back/forward moves the stack first, then navigates to that entry, so the
    // following event does not push a duplicate.
    let label = placement.label.clone();
    let builder = tauri::webview::WebviewBuilder::new(
        placement.label.clone(),
        tauri::WebviewUrl::External(url),
    )
    .on_navigation(move |url| {
        if !child_navigation_allowed(url.as_str()) {
            return false;
        }
        let _ = record_child_navigation(&label, url.as_str());
        true
    })
    .on_page_load(|webview, payload| match payload.event() {
        tauri::webview::PageLoadEvent::Started => record_child_loading(webview.label(), true),
        tauri::webview::PageLoadEvent::Finished => {
            record_child_loading(webview.label(), false);
            let _ = record_child_navigation(webview.label(), payload.url().as_str());
        }
    });
    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map(|_| ())
        .map_err(|err| {
            log_trace(&format!("browser webview {} failed: {err}", placement.label));
            ERR_UNAVAILABLE.to_string()
        })
}

#[tauri::command]
pub async fn create_browser_surface(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, String> {
    let req = body(&request).ok_or_else(|| ERR_INVALID.to_string())?;
    let placement = open_surface(req)?;
    if let Err(err) = mount_browser(&app, &placement).await {
        if let Some(surface_id) = placement.view.get("surfaceId").and_then(Value::as_str) {
            surfaces().lock().unwrap().remove(surface_id);
        }
        return Err(err);
    }
    Ok(placement.view)
}

#[tauri::command]
pub async fn navigate_browser_surface(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, String> {
    let req = body(&request).ok_or_else(|| ERR_INVALID.to_string())?;
    let placement = navigate_surface(req)?;
    match app.get_webview(&placement.label) {
        Some(webview) => {
            let url: tauri::Url = placement
                .url
                .parse()
                .map_err(|_| ERR_INVALID.to_string())?;
            webview
                .navigate(url)
                .map_err(|_| ERR_UNAVAILABLE.to_string())?;
        }
        None => mount_browser(&app, &placement).await?,
    }
    Ok(placement.view)
}

#[tauri::command]
pub async fn update_browser_surface_presentation(
    app: tauri::AppHandle,
    request: Option<Value>,
) -> Result<Value, String> {
    let req = body(&request).ok_or_else(|| ERR_INVALID.to_string())?;
    let placement = present_surface(req)?;
    if placement.visible {
        close_inactive_browser_surfaces_except(
            &app,
            placement.workspace_id.as_deref(),
            Some(&placement.surface_id),
        );
    }
    match app.get_webview(&placement.label) {
        Some(webview) => {
            let (x, y, width, height) = if placement.visible {
                (placement.x, placement.y, placement.width, placement.height)
            } else {
                OFFSCREEN
            };
            let _ = webview.set_position(tauri::LogicalPosition::new(x, y));
            let _ = webview.set_size(tauri::LogicalSize::new(width, height));
        }
        None if placement.visible => mount_browser(&app, &placement).await?,
        None => {}
    }
    Ok(placement.view)
}

#[tauri::command]
pub async fn control_browser_surface(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, String> {
    use tauri_plugin_opener::OpenerExt;
    let req = body(&request).ok_or_else(|| ERR_INVALID.to_string())?;
    let (placement, action, traversed) = control_surface(req)?;
    if action == "openExternal" {
        let _ = app.opener().open_url(&placement.url, None::<&str>);
        return Ok(placement.view);
    }
    match app.get_webview(&placement.label) {
        Some(webview) => match action.as_str() {
            "back" | "forward" if traversed => {
                if let Ok(url) = placement.url.parse() {
                    let _ = webview.navigate(url);
                }
            }
            "reload" => {
                let _ = webview.reload();
            }
            "stop" => {
                let _ = webview.eval("window.stop()");
            }
            "startDesignMode" => {
                let _ = webview.eval("document.designMode = 'on'");
            }
            "stopDesignMode" => {
                let _ = webview.eval("document.designMode = 'off'");
            }
            _ => {}
        },
        None if placement.visible
            && matches!(action.as_str(), "back" | "forward" | "reload" | "startDesignMode") =>
        {
            mount_browser(&app, &placement).await?;
            if action == "startDesignMode" {
                if let Some(webview) = app.get_webview(&placement.label) {
                    let _ = webview.eval("document.designMode = 'on'");
                }
            }
        }
        None => {}
    }
    Ok(placement.view)
}

#[tauri::command]
pub async fn close_browser_surface(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, String> {
    let req = body(&request).ok_or_else(|| ERR_INVALID.to_string())?;
    if let Ok((sid, _)) = target_ids(req) {
        crate::browser_cdp::clear_surface_cdp_state(&sid);
    }
    if let Some(label) = close_surface(req)? {
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.close();
        }
    }
    // Closing is idempotent: an id that is already gone counts as closed.
    Ok(json!({ "closed": true }))
}

#[tauri::command]
pub fn read_browser_surface(request: Option<Value>) -> Result<Value, String> {
    let req = body(&request).ok_or_else(|| ERR_INVALID.to_string())?;
    Ok(read_surface(req)?.view)
}

// ============================================================================
// Multi-Tab, Agent Ownership, Takeover, Discovery & CDP Tauri Commands
// ============================================================================

pub fn list_surface_views(workspace_id: Option<&str>) -> Vec<Value> {
    let normalized = workspace_id.map(str::trim).filter(|s| !s.is_empty());
    let map = surfaces().lock().unwrap();
    let mut views: Vec<(String, Value)> = map
        .values()
        .filter(|r| match normalized {
            Some(ws) => r.workspace_id.as_deref() == Some(ws) || r.owner_kind == "agent",
            None => true,
        })
        .map(|r| (r.surface_id.clone(), surface_view(r)))
        .collect();
    views.sort_by(|a, b| a.0.cmp(&b.0));
    views.into_iter().map(|(_, v)| v).collect()
}

pub fn all_open_surface_urls() -> Vec<String> {
    let map = surfaces().lock().unwrap();
    map.values().map(|r| r.url.clone()).collect()
}

pub fn surface_url_of(surface_id: &str) -> Option<String> {
    surfaces()
        .lock()
        .unwrap()
        .get(surface_id)
        .map(|r| r.url.clone())
}

pub fn most_recent_surface_id() -> Option<String> {
    let map = surfaces().lock().unwrap();
    map.values()
        .max_by_key(|r| (r.agent_active, r.revision))
        .map(|r| r.surface_id.clone())
}

pub fn webview_for_surface(app: &tauri::AppHandle, surface_id: &str) -> Option<tauri::Webview> {
    let label = {
        let map = surfaces().lock().unwrap();
        map.get(surface_id).map(|r| r.label.clone())
    }?;
    app.get_webview(&label)
}

pub fn update_surface_title(surface_id: &str, title: &str) {
    let mut map = surfaces().lock().unwrap();
    if let Some(record) = map.get_mut(surface_id) {
        if record.title != title {
            record.title = title.to_string();
            record.revision = record.revision.saturating_add(1);
        }
    }
}

pub fn is_agent_takeover_requested(surface_id: &str) -> bool {
    surfaces()
        .lock()
        .unwrap()
        .get(surface_id)
        .is_some_and(|r| r.takeover_requested)
}

pub fn set_browser_surface_agent_state(
    surface_id: &str,
    active: bool,
    status_pill: Option<&str>,
) {
    let mut updated_view: Option<Value> = None;
    {
        let mut map = surfaces().lock().unwrap();
        if let Some(record) = map.get_mut(surface_id) {
            record.agent_active = active;
            record.status_pill = status_pill.map(str::to_string);
            record.revision = record.revision.saturating_add(1);
            updated_view = Some(surface_view(record));
        }
    }
    if let (Some(app), Some(view)) = (crate::get_app_handle(), updated_view) {
        let _ = app.emit("browser:surface-updated", view);
    }
}

pub fn set_browser_surface_paused(surface_id: &str, paused: bool, reason: Option<&str>) {
    let mut updated_view: Option<Value> = None;
    {
        let mut map = surfaces().lock().unwrap();
        if let Some(record) = map.get_mut(surface_id) {
            record.paused_for_auth = paused;
            record.pause_reason = reason.map(str::to_string);
            if paused {
                record.agent_active = false;
                record.status_pill = Some("Sign in required".to_string());
            }
            record.revision = record.revision.saturating_add(1);
            updated_view = Some(surface_view(record));
        }
    }
    if let (Some(app), Some(view)) = (crate::get_app_handle(), updated_view) {
        let _ = app.emit("browser:surface-updated", view);
    }
}

pub fn request_agent_takeover(
    surface_id: &str,
    app: Option<&tauri::AppHandle>,
) -> Result<Value, String> {
    let view = {
        let mut map = surfaces().lock().unwrap();
        let record = map
            .get_mut(surface_id)
            .ok_or_else(|| ERR_NOT_FOUND.to_string())?;
        record.takeover_requested = true;
        record.agent_active = false;
        record.paused_for_auth = false;
        record.pause_reason = None;
        record.owner_kind = "user".to_string();
        record.status_pill = Some("You took over".to_string());
        record.revision = record.revision.saturating_add(1);
        surface_view(record)
    };
    if let Some(handle) = app.or_else(|| crate::get_app_handle()) {
        let _ = handle.emit("browser:surface-updated", view.clone());
    }
    Ok(view)
}

pub fn resume_agent_control(
    surface_id: &str,
    thread_id: Option<&str>,
    app: Option<&tauri::AppHandle>,
) -> Result<Value, String> {
    let view = {
        let mut map = surfaces().lock().unwrap();
        let record = map
            .get_mut(surface_id)
            .ok_or_else(|| ERR_NOT_FOUND.to_string())?;
        record.takeover_requested = false;
        record.paused_for_auth = false;
        record.pause_reason = None;
        record.owner_kind = "agent".to_string();
        if let Some(tid) = thread_id.filter(|s| !s.trim().is_empty()) {
            record.owner_thread_id = Some(tid.to_string());
        }
        record.agent_active = true;
        record.status_pill = Some("Agent resumed".to_string());
        record.revision = record.revision.saturating_add(1);
        surface_view(record)
    };
    if let Some(handle) = app.or_else(|| crate::get_app_handle()) {
        let _ = handle.emit("browser:surface-updated", view.clone());
    }
    Ok(view)
}

pub fn close_surface_by_id(app: &tauri::AppHandle, surface_id: &str) -> Result<bool, String> {
    let removed = surfaces().lock().unwrap().remove(surface_id);
    if let Some(record) = removed {
        if let Some(webview) = app.get_webview(&record.label) {
            let _ = webview.close();
        }
        let _ = app.emit(
            "browser:surface-closed",
            json!({ "surfaceId": surface_id }),
        );
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Opens a new agent-owned tab or navigates an existing tab without stealing UI focus.
pub async fn open_or_navigate_agent_surface(
    app: &tauri::AppHandle,
    requested_surface_id: Option<&str>,
    url: &str,
    workspace_id: Option<&str>,
    thread_id: Option<&str>,
    visible: bool,
    isolated: bool,
) -> Result<(SurfacePlacement, tauri::Webview), String> {
    let (stored_url, _) = browser_urls(url).ok_or_else(|| ERR_INVALID.to_string())?;
    if let Some(sid) = requested_surface_id {
        let existing_placement = {
            let mut map = surfaces().lock().unwrap();
            map.get_mut(sid).map(|record| {
                if record.url != stored_url {
                    record.history.truncate(record.history_index + 1);
                    record.history.push(stored_url.clone());
                    record.history_index = record.history.len() - 1;
                }
                record.url = stored_url.clone();
                record.agent_active = true;
                record.takeover_requested = false;
                record.paused_for_auth = false;
                record.pause_reason = None;
                record.status_pill = Some("Navigating…".to_string());
                record.revision = record.revision.saturating_add(1);
                placement_of(record)
            })
        };
        if let Some(placement) = existing_placement {
            if let Some(wv) = app.get_webview(&placement.label) {
                let parsed: tauri::Url = placement.url.parse().map_err(|_| ERR_INVALID.to_string())?;
                wv.navigate(parsed).map_err(|_| ERR_UNAVAILABLE.to_string())?;
                let _ = app.emit("browser:surface-updated", placement.view.clone());
                return Ok((placement, wv));
            }
            mount_browser(app, &placement).await?;
            let wv = app
                .get_webview(&placement.label)
                .ok_or_else(|| ERR_UNAVAILABLE.to_string())?;
            let _ = app.emit("browser:surface-updated", placement.view.clone());
            return Ok((placement, wv));
        }
    }

    let surface_id = requested_surface_id
        .map(str::to_string)
        .unwrap_or_else(|| format!("agent-tab-{}", Uuid::new_v4()));
    let open_req = json!({
        "surfaceId": surface_id,
        "descriptorId": format!("agent-desc-{}", thread_id.unwrap_or("default")),
        "workspaceId": workspace_id,
        "url": stored_url,
        "visible": visible,
        "ownerKind": "agent",
        "ownerThreadId": thread_id,
        "isolated": isolated,
        "bounds": { "x": 0.0, "y": 40.0, "width": 1280.0, "height": 800.0 }
    });
    let placement = open_surface(&open_req)?;
    if let Err(err) = mount_browser(app, &placement).await {
        surfaces().lock().unwrap().remove(&placement.surface_id);
        return Err(err);
    }
    let wv = app
        .get_webview(&placement.label)
        .ok_or_else(|| ERR_UNAVAILABLE.to_string())?;
    let _ = app.emit("browser:surface-updated", placement.view.clone());
    Ok((placement, wv))
}

#[tauri::command]
pub fn list_browser_surfaces(request: Option<Value>) -> Result<Value, String> {
    let ws = body(&request)
        .and_then(|req| req.get("workspaceId").and_then(Value::as_str))
        .map(str::to_string);
    Ok(json!({ "surfaces": list_surface_views(ws.as_deref()) }))
}

#[tauri::command]
pub fn takeover_browser_surface(
    app: tauri::AppHandle,
    request: Option<Value>,
) -> Result<Value, String> {
    let req = body(&request).ok_or_else(|| ERR_INVALID.to_string())?;
    let surface_id = required_str(req, "surfaceId")?;
    request_agent_takeover(surface_id, Some(&app))
}

#[tauri::command]
pub fn resume_browser_surface(
    app: tauri::AppHandle,
    request: Option<Value>,
) -> Result<Value, String> {
    let req = body(&request).ok_or_else(|| ERR_INVALID.to_string())?;
    let surface_id = required_str(req, "surfaceId")?;
    let thread_id = req.get("threadId").and_then(Value::as_str);
    resume_agent_control(surface_id, thread_id, Some(&app))
}

#[tauri::command]
pub async fn discover_browser_servers(request: Option<Value>) -> Result<Value, String> {
    let req = body(&request).cloned().unwrap_or_else(|| json!({}));
    let extra_ports: Vec<u16> = req
        .get("ports")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_u64().map(|p| p as u16))
                .collect()
        })
        .unwrap_or_default();
    let open_urls = all_open_surface_urls();
    let servers = tokio::task::spawn_blocking(move || {
        crate::browser_discovery::discover_local_servers(&extra_ports, &[], &open_urls)
    })
    .await
    .map_err(|e| format!("discovery task failed: {e}"))?;
    Ok(json!({ "servers": servers }))
}

#[tauri::command]
pub async fn capture_browser_surface_screenshot(
    app: tauri::AppHandle,
    request: Option<Value>,
) -> Result<Value, String> {
    let req = body(&request).ok_or_else(|| ERR_INVALID.to_string())?;
    let surface_id = required_str(req, "surfaceId")?;
    let wv = webview_for_surface(&app, surface_id).ok_or_else(|| ERR_NOT_FOUND.to_string())?;
    let format = req.get("format").and_then(Value::as_str).unwrap_or("png");
    let quality = req.get("quality").and_then(Value::as_u64).unwrap_or(82) as u8;
    crate::browser_cdp::capture_screenshot(&wv, surface_id, "ui-capture", format, quality, false, false)
        .await
}

#[tauri::command]
pub async fn browser_agent_action(
    app: tauri::AppHandle,
    request: Option<Value>,
) -> Result<Value, String> {
    let req = body(&request).ok_or_else(|| ERR_INVALID.to_string())?;
    Ok(crate::browser_cdp::execute_browser_action(Some(&app), req).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn browser_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn target(surface_id: &str, descriptor_id: &str) -> Value {
        json!({ "surfaceId": surface_id, "descriptorId": descriptor_id })
    }

    fn bounds() -> Value {
        json!({ "x": 10.0, "y": 20.0, "width": 800.0, "height": 600.0 })
    }

    #[test]
    fn test_browser_history_and_design_mode() {
        let _guard = browser_test_lock();
        let sid = "test-surface-1";
        let open_req = json!({
            "target": target(sid, "desc-test-1"),
            "url": "https://example.com/page1?foo=bar#section",
            "visible": true,
            "bounds": bounds()
        });
        let placement = open_surface(&open_req).unwrap();
        assert_eq!(placement.view["canGoBack"], false);
        assert_eq!(placement.view["canGoForward"], false);
        assert_eq!(placement.view["displayUrl"], "https://example.com/page1");
        assert_eq!(placement.view["designMode"], false);

        // Navigate to page 2
        let nav_req = json!({
            "target": target(sid, "desc-test-1"),
            "url": "https://example.com/page2"
        });
        let p2 = navigate_surface(&nav_req).unwrap();
        assert_eq!(p2.view["canGoBack"], true);
        assert_eq!(p2.view["canGoForward"], false);
        assert_eq!(p2.view["displayUrl"], "https://example.com/page2");

        // Action: startDesignMode
        let ctrl_req = json!({
            "target": target(sid, "desc-test-1"),
            "action": "startDesignMode"
        });
        let (p_design, _, traversed) = control_surface(&ctrl_req).unwrap();
        assert_eq!(p_design.view["designMode"], true);
        assert!(!traversed);

        // Action: back
        let back_req = json!({
            "target": target(sid, "desc-test-1"),
            "action": "back"
        });
        let (p_back, _, traversed) = control_surface(&back_req).unwrap();
        assert!(traversed);
        assert_eq!(p_back.view["canGoBack"], false);
        assert_eq!(p_back.view["canGoForward"], true);
        assert_eq!(p_back.view["displayUrl"], "https://example.com/page1");

        surfaces().lock().unwrap().remove(sid);
    }

    fn history_snapshot(surface_id: &str) -> (usize, usize, i64, String) {
        let map = surfaces().lock().unwrap();
        let record = map.get(surface_id).unwrap();
        (
            record.history.len(),
            record.history_index,
            record.revision,
            record.url.clone(),
        )
    }

    #[test]
    fn test_in_page_navigation_updates_history_stack() {
        let _guard = browser_test_lock();
        let sid = "test-surface-in-page";
        let open_req = json!({
            "target": target(sid, "desc"),
            "url": "https://example.com/page1",
            "bounds": bounds()
        });
        let placement = open_surface(&open_req).unwrap();
        let label = placement.label.clone();
        assert_eq!(placement.view["canGoBack"], false);
        assert_eq!(placement.view["transportSecurity"], "secure");

        assert!(record_child_navigation(&label, "https://example.com/page2"));
        let (len, index, revision, _) = history_snapshot(sid);
        assert_eq!((len, index), (2, 1));
        assert!(revision > 1);
        let view = read_surface(&json!({ "target": target(sid, "desc") })).unwrap().view;
        assert_eq!(view["displayUrl"], "https://example.com/page2");
        assert_eq!(view["canGoBack"], true);
        assert_eq!(view["canGoForward"], false);
        assert_eq!(view["transportSecurity"], "secure");

        assert!(record_child_navigation(
            &label,
            "http://example.com/search?q=1#top"
        ));
        let view = read_surface(&json!({ "target": target(sid, "desc") })).unwrap().view;
        assert_eq!(view["displayUrl"], "http://example.com/search");
        assert_eq!(view["transportSecurity"], "insecure");
        assert_eq!(view["canGoBack"], true);
        assert_eq!(view["canGoForward"], false);
        let (len, index, revision, url) = history_snapshot(sid);
        assert_eq!((len, index), (3, 2));
        assert_eq!(url, "http://example.com/search?q=1#top");

        let long = format!("https://example.com/{}", "a".repeat(2100));
        assert!(!record_child_navigation(&label, &long));
        assert!(!record_child_navigation(&label, "https://user:pw@example.com/secret"));
        assert!(!record_child_navigation(&label, "javascript:alert(1)"));
        assert!(!record_child_navigation(&label, "https://"));
        assert!(!record_child_navigation(&label, "https://example.com/a b"));
        assert!(!child_navigation_allowed("file:///C:/secret"));
        assert!(child_navigation_allowed("about:blank"));
        assert!(!record_child_navigation(&label, "about:blank"));
        let (len_after_reject, index_after_reject, revision_after_reject, _) = history_snapshot(sid);
        assert_eq!((len_after_reject, index_after_reject, revision_after_reject), (len, index, revision));

        let (back, _, traversed) = control_surface(&json!({
            "target": target(sid, "desc"),
            "action": "back"
        }))
        .unwrap();
        assert!(traversed);
        assert_eq!(back.view["displayUrl"], "https://example.com/page2");
        assert_eq!(back.view["canGoForward"], true);
        assert!(record_child_navigation(&label, "https://example.com/page2"));
        let (len, index, revision_at_page2, _) = history_snapshot(sid);
        assert_eq!((len, index), (3, 1));

        let (forward, _, traversed) = control_surface(&json!({
            "target": target(sid, "desc"),
            "action": "forward"
        }))
        .unwrap();
        assert!(traversed);
        assert_eq!(forward.view["displayUrl"], "http://example.com/search");
        assert!(record_child_navigation(&label, "http://example.com/search?q=1"));
        let (len, index, _, _) = history_snapshot(sid);
        assert_eq!((len, index), (3, 2));

        assert!(record_child_navigation(&label, "https://example.com/page2"));
        let (len, index, _, url) = history_snapshot(sid);
        assert_eq!((len, index), (3, 1));
        assert_eq!(url, "https://example.com/page2");
        let view = read_surface(&json!({ "target": target(sid, "desc") })).unwrap().view;
        assert_eq!(view["canGoBack"], true);
        assert_eq!(view["canGoForward"], true);
        assert_eq!(view["displayUrl"], "https://example.com/page2");

        assert!(record_child_navigation(&label, "http://127.0.0.1/app"));
        let (len, index, revision, _) = history_snapshot(sid);
        assert_eq!((len, index), (3, 2));
        assert!(revision > revision_at_page2);
        let view = read_surface(&json!({ "target": target(sid, "desc") })).unwrap().view;
        assert_eq!(view["displayUrl"], "http://127.0.0.1/app");
        assert_eq!(view["transportSecurity"], "local");
        assert_eq!(view["canGoBack"], true);
        assert_eq!(view["canGoForward"], false);

        let (_, _, traversed) = control_surface(&json!({
            "target": target(sid, "desc"),
            "action": "back"
        }))
        .unwrap();
        assert!(traversed);
        let (_, _, traversed) = control_surface(&json!({
            "target": target(sid, "desc"),
            "action": "back"
        }))
        .unwrap();
        assert!(traversed);
        let (len, index, _, url) = history_snapshot(sid);
        assert_eq!((len, index), (3, 0));
        assert_eq!(url, "https://example.com/page1");
        let (_, _, traversed) = control_surface(&json!({
            "target": target(sid, "desc"),
            "action": "back"
        }))
        .unwrap();
        assert!(!traversed);

        surfaces().lock().unwrap().remove(sid);
    }

    #[test]
    fn test_unknown_surface_is_rejected_not_fabricated() {
        let missing = json!({ "target": target("missing-surface-a7", "desc") });
        assert_eq!(read_surface(&missing).err().as_deref(), Some(ERR_NOT_FOUND));
        let reload = json!({ "target": target("missing-surface-a7", "desc"), "action": "reload" });
        assert_eq!(control_surface(&reload).err().as_deref(), Some(ERR_NOT_FOUND));
        let present = json!({
            "target": target("missing-surface-a7", "desc"),
            "bounds": bounds(),
            "visible": true
        });
        assert_eq!(present_surface(&present).err().as_deref(), Some(ERR_NOT_FOUND));
        let nav = json!({ "target": target("missing-surface-a7", "desc"), "url": "https://example.com/" });
        assert_eq!(navigate_surface(&nav).err().as_deref(), Some(ERR_NOT_FOUND));
    }

    #[test]
    fn test_foreign_descriptor_cannot_touch_surface() {
        let _guard = browser_test_lock();
        let sid = "test-surface-foreign";
        open_surface(&json!({
            "target": target(sid, "owner-desc"),
            "url": "https://example.com/",
            "bounds": bounds()
        }))
        .unwrap();
        assert_eq!(
            read_surface(&json!({ "target": target(sid, "other-desc") })).err().as_deref(),
            Some(ERR_NOT_FOUND)
        );
        surfaces().lock().unwrap().remove(sid);
    }

    #[test]
    fn test_presentation_visibility_is_not_forced_by_navigation() {
        let _guard = browser_test_lock();
        let sid = "test-surface-visibility";
        open_surface(&json!({
            "target": target(sid, "desc"),
            "url": "https://example.com/",
            "visible": false,
            "bounds": bounds()
        }))
        .unwrap();
        let navigated = navigate_surface(&json!({
            "target": target(sid, "desc"),
            "url": "https://example.com/next"
        }))
        .unwrap();
        assert_eq!(navigated.view["visible"], false);
        let shown = present_surface(&json!({
            "target": target(sid, "desc"),
            "bounds": bounds(),
            "visible": true
        }))
        .unwrap();
        assert_eq!(shown.view["visible"], true);
        surfaces().lock().unwrap().remove(sid);
    }

    #[test]
    fn test_presentation_bounds_follow_the_contract() {
        let _guard = browser_test_lock();
        let sid = "test-surface-bounds";
        open_surface(&json!({
            "target": target(sid, "desc"),
            "url": "https://example.com/",
            "bounds": bounds()
        }))
        .unwrap();
        let negative = json!({
            "target": target(sid, "desc"),
            "bounds": { "x": -1.0, "y": 0.0, "width": 10.0, "height": 10.0 },
            "visible": true
        });
        assert_eq!(present_surface(&negative).err().as_deref(), Some(ERR_INVALID));
        let empty = json!({
            "target": target(sid, "desc"),
            "bounds": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 10.0 },
            "visible": true
        });
        assert_eq!(present_surface(&empty).err().as_deref(), Some(ERR_INVALID));
        surfaces().lock().unwrap().remove(sid);
    }

    #[test]
    fn test_url_policy() {
        assert!(browser_urls("https://example.com/@user").is_some());
        assert!(browser_urls("https://user:pw@example.com/secret").is_none());
        assert!(browser_urls("javascript:alert(1)").is_none());
        assert!(browser_urls("https://").is_none());
        assert!(browser_urls("https://example.com/a b").is_none());
        assert!(browser_urls("http://localhost:3000/").is_some());
        assert!(browser_urls(&format!("https://example.com/{}", "a".repeat(2100))).is_none());
    }

    #[test]
    fn test_child_loading_mirrors_page_load_and_bumps_revision() {
        let _guard = browser_test_lock();
        let sid = "test-surface-loading";
        let placement = open_surface(&json!({
            "target": target(sid, "desc"),
            "url": "https://example.com/",
            "visible": false,
            "bounds": bounds()
        }))
        .unwrap();
        let label = placement.label.clone();
        let before = read_surface(&json!({ "target": target(sid, "desc") })).unwrap().view;
        record_child_loading(&label, true);
        let during = read_surface(&json!({ "target": target(sid, "desc") })).unwrap().view;
        assert_eq!(during["loading"], true);
        assert!(during["revision"].as_i64() > before["revision"].as_i64());
        record_child_loading(&label, false);
        let after = read_surface(&json!({ "target": target(sid, "desc") })).unwrap().view;
        assert_eq!(after["loading"], false);
        surfaces().lock().unwrap().remove(sid);
    }

    #[test]
    fn test_open_surface_with_owner_scope_and_target_descriptor() {
        let _guard = browser_test_lock();
        let sid = "test-surface-owner-scope";
        let placement = open_surface(&json!({
            "owner": {
                "scope": "workspace",
                "workspaceId": "ws-123",
                "windowLabel": "main"
            },
            "target": target(sid, "desc-456"),
            "url": "https://example.com/portal",
            "bounds": bounds()
        }))
        .unwrap();
        assert_eq!(placement.view["surfaceId"], sid);
        assert_eq!(placement.view["descriptorId"], "desc-456");
        surfaces().lock().unwrap().remove(sid);
    }

    #[test]
    fn inactive_workspace_eviction_targets_other_workspaces_while_preserving_url_history() {
        let _guard = browser_test_lock();
        let sid_a = "test-evict-ws-a";
        let sid_b = "test-evict-ws-b";
        let p_a = open_surface(&json!({
            "owner": { "workspaceId": "ws-alpha", "descriptorId": "desc-a" },
            "target": target(sid_a, "desc-a"),
            "url": "https://example.com/a1",
            "visible": true,
            "bounds": bounds()
        }))
        .unwrap();
        navigate_surface(&json!({
            "target": target(sid_a, "desc-a"),
            "url": "https://example.com/a2"
        }))
        .unwrap();
        record_child_loading(&p_a.label, true);

        let p_b = open_surface(&json!({
            "owner": { "workspaceId": "ws-beta", "descriptorId": "desc-b" },
            "target": target(sid_b, "desc-b"),
            "url": "https://example.com/b1",
            "visible": true,
            "bounds": bounds()
        }))
        .unwrap();

        let prev_a_rev = read_surface(&json!({ "target": target(sid_a, "desc-a") }))
            .unwrap()
            .view["revision"]
            .as_i64()
            .unwrap();

        let evicted = take_inactive_browser_surface_labels(Some("ws-beta"), Some(sid_b));
        assert!(evicted.contains(&p_a.label));
        assert!(!evicted.contains(&p_b.label));

        // Surface A keeps its URL, back history, and bumps revision when visibility/loading reset.
        let view_a = read_surface(&json!({ "target": target(sid_a, "desc-a") }))
            .unwrap()
            .view;
        assert_eq!(view_a["visible"], false);
        assert_eq!(view_a["loading"], false);
        assert_eq!(view_a["displayUrl"], "https://example.com/a2");
        assert_eq!(view_a["canGoBack"], true);
        assert!(view_a["revision"].as_i64().unwrap() > prev_a_rev);

        // Returning to workspace A restores presentation cleanly without ERR_NOT_FOUND.
        let restored_a = present_surface(&json!({
            "target": target(sid_a, "desc-a"),
            "visible": true,
            "bounds": bounds()
        }))
        .unwrap();
        assert_eq!(restored_a.url, "https://example.com/a2");
        assert_eq!(restored_a.view["visible"], true);
        assert_eq!(restored_a.view["canGoBack"], true);

        // Now workspace B is inactive.
        let evicted_back = take_inactive_browser_surface_labels(Some("ws-alpha"), Some(sid_a));
        assert!(evicted_back.contains(&p_b.label));
        assert!(!evicted_back.contains(&p_a.label));

        surfaces().lock().unwrap().remove(sid_a);
        surfaces().lock().unwrap().remove(sid_b);
    }

    #[test]
    fn agent_owned_tab_survives_workspace_eviction_and_supports_takeover_resume() {
        let _guard = browser_test_lock();
        let sid_agent = "test-agent-tab-1";
        let sid_user = "test-user-tab-1";

        let p_agent = open_surface(&json!({
            "surfaceId": sid_agent,
            "descriptorId": "agent-desc-t1",
            "workspaceId": "ws-alpha",
            "ownerKind": "agent",
            "ownerThreadId": "thread-abc",
            "url": "http://localhost:5173/checkout",
            "visible": false,
            "bounds": bounds()
        }))
        .unwrap();
        assert_eq!(p_agent.view["ownerKind"], "agent");
        assert_eq!(p_agent.view["ownerThreadId"], "thread-abc");
        assert_eq!(p_agent.view["agentActive"], true);

        let p_user = open_surface(&json!({
            "surfaceId": sid_user,
            "descriptorId": "user-desc-1",
            "workspaceId": "ws-beta",
            "url": "https://example.com/",
            "visible": true,
            "bounds": bounds()
        }))
        .unwrap();

        // Switching to ws-beta must NOT evict the active background agent tab from ws-alpha.
        let evicted = take_inactive_browser_surface_labels(Some("ws-beta"), Some(sid_user));
        assert!(!evicted.contains(&p_agent.label));
        assert!(!evicted.contains(&p_user.label));

        // User takes over the agent tab -> immediately halts agent control and transfers ownership.
        let taken = request_agent_takeover(sid_agent, None).unwrap();
        assert_eq!(taken["ownerKind"], "user");
        assert_eq!(taken["agentActive"], false);
        assert_eq!(taken["takeoverRequested"], true);
        assert!(is_agent_takeover_requested(sid_agent));

        // Resuming agent control clears takeover and restores agent ownership.
        let resumed = resume_agent_control(sid_agent, Some("thread-abc"), None).unwrap();
        assert_eq!(resumed["ownerKind"], "agent");
        assert_eq!(resumed["agentActive"], true);
        assert_eq!(resumed["takeoverRequested"], false);
        assert!(!is_agent_takeover_requested(sid_agent));

        // Multi-tab listing exposes both tabs.
        let all = list_surface_views(None);
        assert!(all.iter().any(|v| v["surfaceId"] == sid_agent));
        assert!(all.iter().any(|v| v["surfaceId"] == sid_user));

        surfaces().lock().unwrap().remove(sid_agent);
        surfaces().lock().unwrap().remove(sid_user);
    }
}
