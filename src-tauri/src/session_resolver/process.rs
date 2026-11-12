use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};

pub fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
}

#[cfg(windows)]
pub fn process_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn CloseHandle(handle: isize) -> i32;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle == 0 {
            return std::io::Error::last_os_error().raw_os_error() == Some(5);
        }
        CloseHandle(handle);
        true
    }
}

#[cfg(not(windows))]
pub fn process_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    if pid == std::process::id() {
        return true;
    }
    std::path::Path::new(&format!("/proc/{pid}")).is_dir()
}

pub fn map_executable_name_to_agent_engine(exe_name: &str) -> Option<String> {
    let lower = Path::new(exe_name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(exe_name)
        .trim()
        .to_ascii_lowercase();
    let stem = lower.strip_suffix(".exe").unwrap_or(&lower);
    let stem = stem.strip_suffix(".cmd").unwrap_or(stem);
    match stem {
        "agy" | "antigravity" => Some("antigravity".to_string()),
        "gentle-shell" | "gentleshell" | "gentle" | "gentle-pi" | "pi" => Some("gentle-shell".to_string()),
        "claude" | "claude-code" => Some("claude-code".to_string()),
        "codex" => Some("codex".to_string()),
        "gemini" => Some("gemini".to_string()),
        "opencode" | "open-code" => Some("open-code".to_string()),
        "cursor-agent" => Some("cursor".to_string()),
        "droid" => Some("droid".to_string()),
        "kimi" => Some("kimi".to_string()),
        "aider" => Some("aider".to_string()),
        "qwen" | "qwen-code" => Some("qwen-code".to_string()),
        "grok" => Some("grok".to_string()),
        _ => None,
    }
}

/// Collects all process IDs in the OS process tree rooted at `root_pid` (including `root_pid`).
#[cfg(windows)]
pub fn collect_process_tree_pids(root_pid: u32) -> HashSet<u32> {
    let mut visited = HashSet::new();
    if root_pid == 0 {
        return visited;
    }

    const TH32CS_SNAPPROCESS: u32 = 0x00000002;
    const INVALID_HANDLE_VALUE: isize = -1;

    #[repr(C)]
    struct PROCESSENTRY32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(dw_flags: u32, th32_process_id: u32) -> isize;
        fn Process32FirstW(h_snapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn Process32NextW(h_snapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn CloseHandle(h_object: isize) -> i32;
    }

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE || snapshot == 0 {
        return visited;
    }

    let mut children_map: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut entry = PROCESSENTRY32W {
        dw_size: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        cnt_usage: 0,
        th32_process_id: 0,
        th32_default_heap_id: 0,
        th32_module_id: 0,
        cnt_threads: 0,
        th32_parent_process_id: 0,
        pc_pri_class_base: 0,
        dw_flags: 0,
        sz_exe_file: [0; 260],
    };

    unsafe {
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                children_map
                    .entry(entry.th32_parent_process_id)
                    .or_default()
                    .push(entry.th32_process_id);
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }

    let mut queue = std::collections::VecDeque::new();
    queue.push_back(root_pid);
    visited.insert(root_pid);

    while let Some(pid) = queue.pop_front() {
        if let Some(children) = children_map.get(&pid) {
            for &child_pid in children {
                if visited.insert(child_pid) {
                    queue.push_back(child_pid);
                }
            }
        }
    }

    visited
}

#[cfg(not(windows))]
pub fn collect_process_tree_pids(root_pid: u32) -> HashSet<u32> {
    let mut set = HashSet::new();
    if root_pid > 0 {
        set.insert(root_pid);
    }
    set
}

/// Scans `~/.gemini/antigravity-cli/presence/*.lock` and detects which conversations currently
/// have an active byte-range lock held by an Antigravity process, without invoking blocking system APIs.
#[cfg(windows)]
pub fn get_all_locked_antigravity_conversations() -> HashMap<String, Vec<u32>> {
    let mut map = HashMap::new();
    let Some(home) = user_home_dir() else {
        return map;
    };
    let presence_dir = home
        .join(".gemini")
        .join("antigravity-cli")
        .join("presence");
    let Ok(entries) = std::fs::read_dir(&presence_dir) else {
        return map;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("lock") {
            continue;
        }
        let Some(conv_id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(mut file) = std::fs::File::open(&path) else {
            continue;
        };
        let mut buf = [0u8; 1];
        // Antigravity CLI holds an exclusive LockFileEx on byte 0 while running;
        // reading 1 byte fails with ERROR_LOCK_VIOLATION (33) if and only if an agy process holds the lock.
        if file.read(&mut buf).is_err() {
            map.insert(conv_id.to_string(), Vec::new());
        }
    }
    map
}

#[cfg(not(windows))]
pub fn get_all_locked_antigravity_conversations() -> HashMap<String, Vec<u32>> {
    HashMap::new()
}

/// Inspects the OS process tree rooted at `root_pid` and returns the canonical agent engine
/// if the user manually invoked an AI CLI inside a generic shell (e.g., PowerShell -> agy.exe).
#[cfg(windows)]
pub fn detect_child_agent_in_shell(root_pid: u32) -> Option<String> {
    if root_pid == 0 {
        return None;
    }

    const TH32CS_SNAPPROCESS: u32 = 0x00000002;
    const INVALID_HANDLE_VALUE: isize = -1;

    #[repr(C)]
    struct PROCESSENTRY32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(dw_flags: u32, th32_process_id: u32) -> isize;
        fn Process32FirstW(h_snapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn Process32NextW(h_snapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn CloseHandle(h_object: isize) -> i32;
    }

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE || snapshot == 0 {
        return None;
    }

    let mut children_map: HashMap<u32, Vec<(u32, String)>> = HashMap::new();
    let mut entry = PROCESSENTRY32W {
        dw_size: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        cnt_usage: 0,
        th32_process_id: 0,
        th32_default_heap_id: 0,
        th32_module_id: 0,
        cnt_threads: 0,
        th32_parent_process_id: 0,
        pc_pri_class_base: 0,
        dw_flags: 0,
        sz_exe_file: [0; 260],
    };

    unsafe {
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let len = entry
                    .sz_exe_file
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.sz_exe_file.len());
                let exe_name = String::from_utf16_lossy(&entry.sz_exe_file[..len]);
                children_map
                    .entry(entry.th32_parent_process_id)
                    .or_default()
                    .push((entry.th32_process_id, exe_name));

                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }

    // Breadth-first traversal from root_pid
    let mut queue = std::collections::VecDeque::new();
    let mut visited = HashSet::new();
    queue.push_back(root_pid);
    visited.insert(root_pid);

    let mut detected: Option<String> = None;
    while let Some(pid) = queue.pop_front() {
        if let Some(children) = children_map.get(&pid) {
            for (child_pid, exe_name) in children {
                if visited.insert(*child_pid) {
                    if let Some(engine) = map_executable_name_to_agent_engine(exe_name) {
                        detected = Some(engine);
                    }
                    queue.push_back(*child_pid);
                }
            }
        }
    }

    detected
}

#[cfg(not(windows))]
pub fn detect_child_agent_in_shell(_root_pid: u32) -> Option<String> {
    None
}
