#![cfg(target_os = "windows")]

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::os::windows::ffi::{OsStrExt, OsStringExt};

pub const TH32CS_SNAPPROCESS: u32 = 0x00000002;
pub const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
pub const INVALID_HANDLE_VALUE: isize = -1;

#[repr(C)]
#[derive(Copy, Clone, Default)]
pub struct FILETIME {
    pub dw_low_date_time: u32,
    pub dw_high_date_time: u32,
}

impl FILETIME {
    pub fn to_u64(self) -> u64 {
        ((self.dw_high_date_time as u64) << 32) | (self.dw_low_date_time as u64)
    }
}

#[repr(C)]
pub struct MEMORYSTATUSEX {
    pub dw_length: u32,
    pub dw_memory_load: u32,
    pub ull_total_phys: u64,
    pub ull_avail_phys: u64,
    pub ull_total_page_file: u64,
    pub ull_avail_page_file: u64,
    pub ull_total_virtual: u64,
    pub ull_avail_virtual: u64,
    pub ull_avail_extended_virtual: u64,
}

#[repr(C)]
pub struct PROCESSENTRY32W {
    pub dw_size: u32,
    pub cnt_usage: u32,
    pub th32_process_id: u32,
    pub th32_default_heap_id: usize,
    pub th32_module_id: u32,
    pub cnt_threads: u32,
    pub th32_parent_process_id: u32,
    pub pc_pri_class_base: i32,
    pub dw_flags: u32,
    pub sz_exe_file: [u16; 260],
}

#[repr(C)]
pub struct PROCESS_MEMORY_COUNTERS_EX {
    pub cb: u32,
    pub page_fault_count: u32,
    pub peak_working_set_size: usize,
    pub working_set_size: usize,
    pub quota_peak_paged_pool_usage: usize,
    pub quota_paged_pool_usage: usize,
    pub quota_peak_non_paged_pool_usage: usize,
    pub quota_non_paged_pool_usage: usize,
    pub pagefile_usage: usize,
    pub peak_pagefile_usage: usize,
    pub private_usage: usize,
}

#[link(name = "kernel32")]
extern "system" {
    pub fn GlobalMemoryStatusEx(lpBuffer: *mut MEMORYSTATUSEX) -> i32;
    pub fn GetSystemTimes(
        lpIdleTime: *mut FILETIME,
        lpKernelTime: *mut FILETIME,
        lpUserTime: *mut FILETIME,
    ) -> i32;
    pub fn CreateToolhelp32Snapshot(dwFlags: u32, th32ProcessID: u32) -> isize;
    pub fn Process32FirstW(hSnapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
    pub fn Process32NextW(hSnapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
    pub fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> isize;
    pub fn CloseHandle(hObject: isize) -> i32;
    pub fn K32GetProcessMemoryInfo(
        Process: isize,
        ppsmemCounters: *mut PROCESS_MEMORY_COUNTERS_EX,
        cb: u32,
    ) -> i32;
    pub fn GetProcessTimes(
        hProcess: isize,
        lpCreationTime: *mut FILETIME,
        lpExitTime: *mut FILETIME,
        lpKernelTime: *mut FILETIME,
        lpUserTime: *mut FILETIME,
    ) -> i32;
    pub fn GetDiskFreeSpaceExW(
        lpDirectoryName: *const u16,
        lpFreeBytesAvailableToCaller: *mut u64,
        lpTotalNumberOfBytes: *mut u64,
        lpTotalNumberOfFreeBytes: *mut u64,
    ) -> i32;
}

#[derive(Clone)]
pub struct ProcNode {
    pub pid: u32,
    pub parent_pid: u32,
    pub name: String,
}

#[derive(Clone)]
pub struct TerminalOrigin {
    pub session_id: String,
    pub workspace_id: Option<String>,
    pub engine: String,
    pub is_agent: bool,
}

pub fn is_build_tool(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("rustc")
        || n.contains("cargo")
        || n.contains("esbuild")
        || n.contains("tsc")
        || n.contains("webpack")
        || n.contains("vite")
        || n.contains("vitest")
        || n.contains("jest")
        || n.contains("link.exe")
}

pub fn is_mcp_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("engram")
        || lower.contains("codegraph")
        || lower.contains("headroom")
        || lower.contains("symdex")
        || lower.contains("uvx")
        || lower.contains("uv.exe")
}

pub fn is_agent_core_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("agy")
        || lower.contains("gemini")
        || lower.contains("opencode")
        || lower.contains("grok")
        || lower.contains("claude")
}

pub fn infer_process_label(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.contains("engram") {
        "Servidor MCP (engram)"
    } else if lower.contains("codegraph") {
        "Servidor MCP (codegraph)"
    } else if lower.contains("headroom") {
        "Servidor MCP (headroom)"
    } else if lower.contains("symdex") || lower.contains("uvx") {
        "Servidor MCP (symdex)"
    } else if lower.contains("rustc") {
        "Compilador Rust (rustc)"
    } else if lower.contains("cargo") {
        "Gestor de paquetes Cargo"
    } else if lower.contains("powershell") {
        "PowerShell Shell"
    } else if lower.contains("cmd") {
        "CMD Símbolo del Sistema"
    } else if lower.contains("conhost") {
        "Host de consola Windows (ConPTY)"
    } else if lower.contains("agy") {
        "Antigravity CLI Agent"
    } else if lower.contains("claude") {
        "Claude Code Agent"
    } else if lower.contains("opencode") {
        "OpenCode Agent"
    } else if lower.contains("grok") {
        "Grok CLI Agent"
    } else if lower.contains("gemini") {
        "Gemini Agent CLI"
    } else if lower.contains("python") {
        "Herramienta / Servidor MCP (Python)"
    } else if lower.contains("node") {
        "Node.js Runtime / Herramienta MCP"
    } else if lower.contains("git") {
        "Control de versiones Git"
    } else if lower.contains("esbuild") || lower.contains("vite") || lower.contains("webpack") {
        "Bundler / Dev Server"
    } else if lower.contains("msedgewebview2") || lower.contains("webview") {
        "Motor UI (WebView2)"
    } else if lower.contains("kite") {
        "Núcleo Kite Code (Tauri Host)"
    } else {
        "Subproceso PTY / Agente"
    }
}

pub fn query_process_mem_and_cpu(pid: u32) -> (u64, u64, u64) {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle == 0 || handle == INVALID_HANDLE_VALUE {
            return (0, 0, 0);
        }
        let mut mem: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
        mem.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let (working_set_bytes, private_bytes) = if K32GetProcessMemoryInfo(handle, &mut mem, mem.cb) != 0 {
            (mem.working_set_size as u64, mem.private_usage as u64)
        } else {
            (0, 0)
        };

        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let cpu_ticks = if GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) != 0 {
            kernel.to_u64().saturating_add(user.to_u64())
        } else {
            0
        };

        let _ = CloseHandle(handle);
        (working_set_bytes, private_bytes, cpu_ticks)
    }
}

pub fn collect_process_tree(root_pid: u32) -> Vec<ProcNode> {
    let mut all_procs: Vec<ProcNode> = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE || snap == 0 {
            return vec![ProcNode {
                pid: root_pid,
                parent_pid: 0,
                name: "kite-code.exe".to_string(),
            }];
        }

        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dw_size = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let len = entry
                    .sz_exe_file
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.sz_exe_file.len());
                let name = OsString::from_wide(&entry.sz_exe_file[..len])
                    .to_string_lossy()
                    .to_lowercase();
                all_procs.push(ProcNode {
                    pid: entry.th32_process_id,
                    parent_pid: entry.th32_parent_process_id,
                    name,
                });
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }

    // BFS from root_pid, core_daemon_pid, and active terminal root PIDs to find all descendants
    let mut tree_pids: HashSet<u32> = HashSet::new();
    tree_pids.insert(root_pid);
    if let Some(dpid) = crate::core_daemon::get_core_daemon_pid() {
        tree_pids.insert(dpid);
    }
    for tpid in crate::terminal::get_terminal_root_pids() {
        if tpid > 0 {
            tree_pids.insert(tpid);
        }
    }
    let mut changed = true;
    while changed {
        changed = false;
        for p in &all_procs {
            if !tree_pids.contains(&p.pid) && tree_pids.contains(&p.parent_pid) {
                tree_pids.insert(p.pid);
                changed = true;
            }
        }
    }

    all_procs
        .into_iter()
        .filter(|p| tree_pids.contains(&p.pid))
        .collect()
}

/// Walks the parent chain from `pid` up to the host root looking for a
/// registered terminal root. Depth is capped so a corrupt parent map cannot
/// spin forever.
pub fn has_terminal_root_ancestor(
    pid: u32,
    root_pid: u32,
    parent_map: &HashMap<u32, u32>,
    terminal_roots: &HashSet<u32>,
) -> bool {
    let mut curr = pid;
    let mut depth = 0;
    while curr != 0 && curr != root_pid && depth < 64 {
        if terminal_roots.contains(&curr) {
            return true;
        }
        curr = parent_map.get(&curr).copied().unwrap_or(0);
        depth += 1;
    }
    false
}
