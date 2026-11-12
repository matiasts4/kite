#![cfg(target_os = "windows")]

use super::sampler::{cpu_state, measure_app_cache_bytes, now_ms};
use super::win_process::*;
pub use super::win_process::has_terminal_root_ancestor;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::os::windows::ffi::OsStrExt;
use std::time::Instant;

pub fn collect_snapshot() -> Value {
    let root_pid = std::process::id();
    let logical_cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(8);

    // 1. System Memory
    let (sys_total_mem, sys_avail_mem, sys_mem_pct) = unsafe {
        let mut mem_status: MEMORYSTATUSEX = std::mem::zeroed();
        mem_status.dw_length = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut mem_status) != 0 {
            (
                mem_status.ull_total_phys,
                mem_status.ull_avail_phys,
                mem_status.dw_memory_load as f64,
            )
        } else {
            (16 * 1024 * 1024 * 1024, 8 * 1024 * 1024 * 1024, 50.0)
        }
    };
    let sys_used_mem = sys_total_mem.saturating_sub(sys_avail_mem);

    // 2. Process Tree Memory & CPU ticks
    let daemon_pid = crate::core_daemon::get_core_daemon_pid();
    let tree = collect_process_tree(root_pid);

    // Query active terminals in Kite (both in-process and daemon-owned) to map root PIDs to session/workspace context
    let mut terminal_roots: HashMap<u32, TerminalOrigin> = HashMap::new();
    let mut terminal_titles: HashMap<String, String> = HashMap::new();
    if let Ok(terms) = crate::terminal::get_terminals().lock() {
        for (sid, inst) in terms.iter() {
            let ws_id = inst.workspace_id.lock().ok().and_then(|w| w.clone());
            let detected = inst.detected_agent_engine.lock().ok().and_then(|d| d.clone());
            let engine = detected.clone().unwrap_or_else(|| inst.engine.clone());
            let lower_eng = engine.to_lowercase();
            let is_agent = detected.is_some()
                || (!["powershell", "pwsh", "cmd", "bash", "zsh", "sh", "terminal"].contains(&lower_eng.as_str())
                    && !lower_eng.is_empty());

            let title = if is_agent {
                format!("Agente {}", engine)
            } else {
                format!("Terminal ({})", engine)
            };
            terminal_titles.insert(sid.clone(), title);

            if let Ok(child) = inst.child.lock() {
                if let Some(cpid) = child.process_id() {
                    terminal_roots.insert(cpid, TerminalOrigin {
                        session_id: sid.clone(),
                        workspace_id: ws_id,
                        engine,
                        is_agent,
                    });
                }
            }
        }
    }

    // Merge daemon-owned active sessions cached in CoreConnection + persisted metadata
    let daemon_sessions = crate::core_daemon::get_client_active_session_summaries();
    if !daemon_sessions.is_empty() {
        let persisted_map = crate::session_resolver::read_persisted_terminal_sessions();
        for (sid, cpid, facts) in daemon_sessions {
            if terminal_titles.contains_key(&sid) {
                continue;
            }
            let persisted = persisted_map.get(&sid);
            let ws_id = facts
                .get("workspaceId")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .or_else(|| persisted.and_then(|p| p.workspace_id.clone()));
            let engine = facts
                .get("activeEngine")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .or_else(|| persisted.map(|p| p.active_engine.clone()))
                .unwrap_or_else(|| "powershell".to_string());
            let lower_eng = engine.to_lowercase();
            let is_agent = !["powershell", "pwsh", "cmd", "bash", "zsh", "sh", "terminal"]
                .contains(&lower_eng.as_str())
                && !lower_eng.is_empty();
            let title = facts
                .get("title")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    if is_agent {
                        format!("Agente {}", engine)
                    } else {
                        format!("Terminal ({})", engine)
                    }
                });
            terminal_titles.insert(sid.clone(), title);
            if cpid > 0 {
                terminal_roots.insert(
                    cpid,
                    TerminalOrigin {
                        session_id: sid,
                        workspace_id: ws_id,
                        engine,
                        is_agent,
                    },
                );
            }
        }
    }

    // Build parent map for quick ancestor traversal
    let mut parent_map: HashMap<u32, u32> = HashMap::with_capacity(tree.len());
    for node in &tree {
        parent_map.insert(node.pid, node.parent_pid);
    }

    struct WsAccum {
        memory_bytes: u64,
        private_bytes: u64,
        process_count: usize,
        sessions: HashSet<String>,
    }

    struct TermAccum {
        title: String,
        engine: String,
        workspace_id: Option<String>,
        is_agent: bool,
        root_pid: u32,
        memory_bytes: u64,
        private_bytes: u64,
        process_count: usize,
        agent_bytes: u64,
        mcp_bytes: u64,
        shell_bytes: u64,
    }

    let mut ws_map: HashMap<String, WsAccum> = HashMap::new();
    let mut term_map: HashMap<String, TermAccum> = HashMap::new();

    for (cpid, origin) in &terminal_roots {
        let title = terminal_titles
            .get(&origin.session_id)
            .cloned()
            .unwrap_or_else(|| format!("Terminal {}", origin.engine));
        term_map.entry(origin.session_id.clone()).or_insert_with(|| TermAccum {
            title,
            engine: origin.engine.clone(),
            workspace_id: origin.workspace_id.clone(),
            is_agent: origin.is_agent,
            root_pid: *cpid,
            memory_bytes: 0,
            private_bytes: 0,
            process_count: 0,
            agent_bytes: 0,
            mcp_bytes: 0,
            shell_bytes: 0,
        });
    }

    let mut core_bytes = 0u64;
    let mut core_private_bytes = 0u64;
    let mut core_count = 0usize;
    let mut webview_bytes = 0u64;
    let mut webview_private_bytes = 0u64;
    let mut webview_count = 0usize;
    let mut terminals_bytes = 0u64;
    let mut terminals_private_bytes = 0u64;
    let mut terminals_count = 0usize;
    let mut agents_bytes = 0u64;
    let mut agents_private_bytes = 0u64;
    let mut agents_count = 0usize;
    let mut mcps_bytes = 0u64;
    let mut mcps_private_bytes = 0u64;
    let mut mcps_count = 0usize;
    let mut current_proc_times: HashMap<u32, u64> = HashMap::new();
    let mut detailed_processes: Vec<Value> = Vec::with_capacity(tree.len());

    for node in &tree {
        let (ws_mem, priv_mem, cpu_ticks) = query_process_mem_and_cpu(node.pid);
        // Use Private Bytes as the primary memory figure to avoid 6x-8x multi-counting
        // of shared read-only Chromium/Windows DLL pages across WebView2 child processes.
        let effective_mem = if priv_mem > 0 { priv_mem } else { ws_mem };
        current_proc_times.insert(node.pid, cpu_ticks);

        let (matched_terminal, is_orphan) = if node.pid == root_pid
            || Some(node.pid) == daemon_pid
            || node.name.contains("webview")
            || node.name.contains("msedge")
        {
            (None, false)
        } else {
            let mut curr = node.pid;
            let mut matched = None;
            let mut depth = 0;
            while curr != 0 && curr != root_pid && Some(curr) != daemon_pid && depth < 24 {
                if let Some(origin) = terminal_roots.get(&curr) {
                    matched = Some(origin.clone());
                    break;
                }
                curr = parent_map.get(&curr).copied().unwrap_or(0);
                depth += 1;
            }
            let orphan = matched.is_none()
                && !node.name.contains("kite")
                && node.parent_pid != root_pid
                && Some(node.parent_pid) != daemon_pid
                && !parent_map.contains_key(&node.parent_pid);
            (matched, orphan)
        };

        let is_bld = is_build_tool(&node.name);

        let (category, role, label) = if matched_terminal.is_none()
            && (node.pid == root_pid || Some(node.pid) == daemon_pid || node.name.contains("kite"))
        {
            core_bytes = core_bytes.saturating_add(effective_mem);
            core_private_bytes = core_private_bytes.saturating_add(effective_mem);
            core_count += 1;
            let lbl = if Some(node.pid) == daemon_pid || (node.pid != root_pid && node.name.contains("kite")) {
                "Motor Persistente (kite-core --daemon)"
            } else {
                infer_process_label(&node.name)
            };
            ("core", "core", lbl)
        } else if node.name.contains("webview") || node.name.contains("msedge") {
            webview_bytes = webview_bytes.saturating_add(effective_mem);
            webview_private_bytes = webview_private_bytes.saturating_add(effective_mem);
            webview_count += 1;
            ("webview", "webview", infer_process_label(&node.name))
        } else {
            terminals_bytes = terminals_bytes.saturating_add(effective_mem);
            terminals_private_bytes = terminals_private_bytes.saturating_add(effective_mem);
            terminals_count += 1;

            let is_agent_term = matched_terminal.as_ref().map(|t| t.is_agent).unwrap_or(false);
            let (r, c) = if is_bld {
                ("build", "terminals")
            } else if is_mcp_name(&node.name) {
                mcps_bytes = mcps_bytes.saturating_add(effective_mem);
                mcps_private_bytes = mcps_private_bytes.saturating_add(effective_mem);
                mcps_count += 1;
                ("mcp", "terminals")
            } else if is_agent_core_name(&node.name) {
                agents_bytes = agents_bytes.saturating_add(effective_mem);
                agents_private_bytes = agents_private_bytes.saturating_add(effective_mem);
                agents_count += 1;
                ("agent", "terminals")
            } else if is_agent_term {
                let n = node.name.to_lowercase();
                if n.contains("powershell") || n.contains("cmd") || n.contains("conhost") || n.contains("bash") {
                    ("terminal", "terminals")
                } else if n.contains("python") || n.contains("node") {
                    mcps_bytes = mcps_bytes.saturating_add(effective_mem);
                    mcps_private_bytes = mcps_private_bytes.saturating_add(effective_mem);
                    mcps_count += 1;
                    ("mcp", "terminals")
                } else {
                    agents_bytes = agents_bytes.saturating_add(effective_mem);
                    agents_private_bytes = agents_private_bytes.saturating_add(effective_mem);
                    agents_count += 1;
                    ("agent", "terminals")
                }
            } else {
                ("terminal", "terminals")
            };

            let lbl = if node.name.contains("kite") {
                "Servidor MCP (kite-tasks)"
            } else {
                infer_process_label(&node.name)
            };
            (c, r, lbl)
        };

        let session_id = matched_terminal.as_ref().map(|t| t.session_id.clone());
        let workspace_id = matched_terminal.as_ref().and_then(|t| t.workspace_id.clone());
        let engine = matched_terminal.as_ref().map(|t| t.engine.clone());
        let is_agent = matched_terminal.as_ref().map(|t| t.is_agent).unwrap_or(false);

        if let Some(ref sid) = session_id {
            let entry = term_map.entry(sid.clone()).or_insert_with(|| TermAccum {
                title: terminal_titles.get(sid).cloned().unwrap_or_else(|| "Terminal".to_string()),
                engine: engine.clone().unwrap_or_else(|| "terminal".to_string()),
                workspace_id: workspace_id.clone(),
                is_agent,
                root_pid: node.pid,
                memory_bytes: 0,
                private_bytes: 0,
                process_count: 0,
                agent_bytes: 0,
                mcp_bytes: 0,
                shell_bytes: 0,
            });
            entry.memory_bytes = entry.memory_bytes.saturating_add(effective_mem);
            entry.private_bytes = entry.private_bytes.saturating_add(effective_mem);
            entry.process_count += 1;
            if role == "mcp" {
                entry.mcp_bytes = entry.mcp_bytes.saturating_add(effective_mem);
            } else if role == "agent" {
                entry.agent_bytes = entry.agent_bytes.saturating_add(effective_mem);
            } else {
                entry.shell_bytes = entry.shell_bytes.saturating_add(effective_mem);
            }
        }

        if let Some(ref ws) = workspace_id {
            let entry = ws_map.entry(ws.clone()).or_insert_with(|| WsAccum {
                memory_bytes: 0,
                private_bytes: 0,
                process_count: 0,
                sessions: HashSet::new(),
            });
            entry.memory_bytes = entry.memory_bytes.saturating_add(effective_mem);
            entry.private_bytes = entry.private_bytes.saturating_add(effective_mem);
            entry.process_count += 1;
            if let Some(ref sid) = session_id {
                entry.sessions.insert(sid.clone());
            }
        }

        detailed_processes.push(json!({
            "pid": node.pid,
            "parentPid": node.parent_pid,
            "name": node.name,
            "label": label,
            "category": category,
            "role": role,
            "memoryBytes": effective_mem,
            "privateBytes": effective_mem,
            "workingSetBytes": ws_mem,
            "sessionId": session_id,
            "workspaceId": workspace_id,
            "engine": engine,
            "isAgent": is_agent,
            "isOrphan": is_orphan,
        }));
    }

    detailed_processes.sort_by(|a, b| {
        let b_bytes = b["memoryBytes"].as_u64().unwrap_or(0);
        let a_bytes = a["memoryBytes"].as_u64().unwrap_or(0);
        b_bytes.cmp(&a_bytes)
    });

    let mut workspaces_list: Vec<Value> = ws_map
        .into_iter()
        .map(|(ws_id, accum)| {
            json!({
                "workspaceId": ws_id,
                "displayName": ws_id,
                "memoryBytes": accum.memory_bytes,
                "privateBytes": accum.private_bytes,
                "processCount": accum.process_count,
                "terminalCount": accum.sessions.len(),
            })
        })
        .collect();
    workspaces_list.sort_by(|a, b| {
        let b_bytes = b["memoryBytes"].as_u64().unwrap_or(0);
        let a_bytes = a["memoryBytes"].as_u64().unwrap_or(0);
        b_bytes.cmp(&a_bytes)
    });

    let mut terminals_list: Vec<Value> = term_map
        .into_iter()
        .map(|(sid, accum)| {
            json!({
                "sessionId": sid,
                "title": accum.title,
                "engine": accum.engine,
                "workspaceId": accum.workspace_id,
                "isAgent": accum.is_agent,
                "rootPid": accum.root_pid,
                "memoryBytes": accum.memory_bytes,
                "privateBytes": accum.private_bytes,
                "processCount": accum.process_count,
                "agentBytes": accum.agent_bytes,
                "mcpBytes": accum.mcp_bytes,
                "shellBytes": accum.shell_bytes,
            })
        })
        .collect();
    terminals_list.sort_by(|a, b| {
        let b_bytes = b["memoryBytes"].as_u64().unwrap_or(0);
        let a_bytes = a["memoryBytes"].as_u64().unwrap_or(0);
        b_bytes.cmp(&a_bytes)
    });

    let app_total_bytes = core_bytes
        .saturating_add(webview_bytes)
        .saturating_add(terminals_bytes);
    let app_private_bytes = core_private_bytes
        .saturating_add(webview_private_bytes)
        .saturating_add(terminals_private_bytes);

    // 3. System & App CPU % calculation
    let (sys_idle, sys_kernel, sys_user) = unsafe {
        let mut idle = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if GetSystemTimes(&mut idle, &mut kernel, &mut user) != 0 {
            (idle.to_u64(), kernel.to_u64(), user.to_u64())
        } else {
            (0, 0, 0)
        }
    };

    let (sys_cpu_pct, app_cpu_pct, uptime_secs) = {
        let mut st = cpu_state().lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let uptime = now.duration_since(st.started_at).as_secs();

        if let Some(prev_at) = st.last_sample_at {
            let elapsed_secs = now.duration_since(prev_at).as_secs_f64();
            if elapsed_secs >= 0.25 {
                let idle_delta = sys_idle.saturating_sub(st.last_sys_idle);
                let kernel_delta = sys_kernel.saturating_sub(st.last_sys_kernel);
                let user_delta = sys_user.saturating_sub(st.last_sys_user);
                let total_sys_delta = kernel_delta.saturating_add(user_delta);

                if total_sys_delta > 0 {
                    let busy_delta = total_sys_delta.saturating_sub(idle_delta);
                    let raw_sys = (busy_delta as f64 / total_sys_delta as f64) * 100.0;
                    st.last_sys_cpu_pct = (raw_sys * 10.0).round() / 10.0;
                }

                // Sum delta across processes that existed in both samples
                let mut proc_delta_ticks = 0u64;
                for (pid, &ticks) in &current_proc_times {
                    if let Some(&prev_ticks) = st.last_proc_times.get(pid) {
                        proc_delta_ticks =
                            proc_delta_ticks.saturating_add(ticks.saturating_sub(prev_ticks));
                    }
                }

                // 1 second = 10_000_000 ticks (100ns units) per core
                let capacity_ticks =
                    elapsed_secs * 10_000_000.0 * (logical_cores.max(1) as f64);
                if capacity_ticks > 0.0 {
                    let raw_app = ((proc_delta_ticks as f64) / capacity_ticks) * 100.0;
                    st.last_app_cpu_pct =
                        ((raw_app.clamp(0.1, 100.0)) * 10.0).round() / 10.0;
                }

                st.last_sample_at = Some(now);
                st.last_sys_idle = sys_idle;
                st.last_sys_kernel = sys_kernel;
                st.last_sys_user = sys_user;
                st.last_proc_times = current_proc_times;
            }
        } else {
            st.last_sample_at = Some(now);
            st.last_sys_idle = sys_idle;
            st.last_sys_kernel = sys_kernel;
            st.last_sys_user = sys_user;
            st.last_proc_times = current_proc_times;
        }

        (st.last_sys_cpu_pct, st.last_app_cpu_pct, uptime)
    };

    // 4. Disk space on current workspace/app drive
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("C:\\"));
    let mount_point = cwd
        .components()
        .next()
        .map(|c| {
            let s = c.as_os_str().to_string_lossy().to_string();
            if s.ends_with('\\') {
                s
            } else {
                format!("{}\\", s)
            }
        })
        .unwrap_or_else(|| "C:\\".to_string());

    let (disk_total, disk_avail) = unsafe {
        let wide: Vec<u16> = std::ffi::OsStr::new(&mount_point)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut free_caller = 0u64;
        let mut total = 0u64;
        let mut total_free = 0u64;
        if GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free_caller,
            &mut total,
            &mut total_free,
        ) != 0
        {
            (total, free_caller)
        } else {
            (512 * 1024 * 1024 * 1024, 256 * 1024 * 1024 * 1024)
        }
    };
    let disk_used = disk_total.saturating_sub(disk_avail);
    let disk_pct = if disk_total > 0 {
        ((disk_used as f64 / disk_total as f64) * 1000.0).round() / 10.0
    } else {
        0.0
    };

    let active_terminals = terminal_titles.len();

    let app_share_pct = if sys_total_mem > 0 {
        ((app_total_bytes as f64 / sys_total_mem as f64) * 1000.0).round() / 10.0
    } else {
        0.0
    };

    let sys_avail_gb = (sys_avail_mem as f64) / (1024.0 * 1024.0 * 1024.0);
    let app_total_gb = (app_total_bytes as f64) / (1024.0 * 1024.0 * 1024.0);

    // State evaluation balanced against the host's actual RAM capacity:
    // - Critical: true host RAM exhaustion (<900MB free) or runaway process (>50% of machine RAM)
    // - High: app takes >30% of machine RAM or system tight (<1.8GB free) and app is significant
    // - Moderate / Active: multi-process work (>14% of system or >4GB, or >3 active terminals)
    // - Low: very light footprint (<4% of RAM and <650MB)
    // - Normal: healthy, smooth operation ("Buen rendimiento")
    let pressure = if (sys_avail_gb < 0.9 && sys_mem_pct >= 94.0) || app_share_pct >= 50.0 || app_total_gb >= 16.0 {
        "critical"
    } else if app_share_pct >= 30.0 || (sys_avail_gb < 1.8 && app_share_pct >= 18.0) {
        "high"
    } else if app_share_pct >= 14.0 || app_total_gb >= 4.0 || (active_terminals >= 3 && app_total_gb >= 2.0) {
        "moderate"
    } else if app_share_pct < 4.0 && app_total_gb < 0.65 {
        "low"
    } else {
        "normal"
    };

    let cpu_model = std::env::var("PROCESSOR_IDENTIFIER")
        .unwrap_or_else(|_| format!("{}-Core Processor ({})", logical_cores, std::env::consts::ARCH));

    let app_cache_bytes = measure_app_cache_bytes();

    let mut breakdown_groups = vec![
        json!({
            "id": "core",
            "label": "Núcleo Rust (Tauri Host)",
            "memoryBytes": core_bytes,
            "privateBytes": core_private_bytes,
            "processCount": core_count
        }),
        json!({
            "id": "webview",
            "label": "Motor UI (WebView2 / GPU)",
            "memoryBytes": webview_bytes,
            "privateBytes": webview_private_bytes,
            "processCount": webview_count
        }),
        json!({
            "id": "terminals",
            "label": "Terminales PTY & Agentes",
            "memoryBytes": terminals_bytes,
            "privateBytes": terminals_private_bytes,
            "processCount": terminals_count
        }),
    ];
    if mcps_count > 0 {
        breakdown_groups.push(json!({
            "id": "mcps",
            "label": "Servidores MCP & Herramientas",
            "memoryBytes": mcps_bytes,
            "privateBytes": mcps_private_bytes,
            "processCount": mcps_count
        }));
    }

    json!({
        "timestampMs": now_ms(),
        "pid": root_pid,
        "uptimeSeconds": uptime_secs,
        "memory": {
            "appTotalBytes": app_total_bytes,
            "appPrivateBytes": app_private_bytes,
            "appCoreBytes": core_bytes.saturating_add(webview_bytes),
            "appTerminalsBytes": terminals_bytes,
            "appAgentsBytes": agents_bytes,
            "appMcpsBytes": mcps_bytes,
            "systemTotalBytes": sys_total_mem,
            "systemUsedBytes": sys_used_mem,
            "systemAvailableBytes": sys_avail_mem,
            "systemUsagePercent": sys_mem_pct,
            "appShareOfSystemPercent": app_share_pct,
            "pressure": pressure
        },
        "cpu": {
            "appUsagePercent": app_cpu_pct,
            "systemUsagePercent": sys_cpu_pct,
            "logicalCores": logical_cores,
            "model": cpu_model
        },
        "disk": {
            "mountPoint": mount_point,
            "totalBytes": disk_total,
            "usedBytes": disk_used,
            "availableBytes": disk_avail,
            "usagePercent": disk_pct,
            "appCacheBytes": app_cache_bytes
        },
        "runtime": {
            "activeTerminals": active_terminals,
            "processCount": tree.len(),
            "breakdown": breakdown_groups,
            "processes": detailed_processes,
            "workspaces": workspaces_list,
            "terminals": terminals_list
        }
    })
}
