//! Windows User `PATH` (`HKCU\Environment\Path`) registration helper for the `kite` CLI shim.
//! Never runs during unit/integration tests and avoids spawning console children (`reg.exe`/`setx.exe`).

use std::path::{Path, PathBuf};

fn normalize_path_segment(raw: &str) -> String {
    raw.trim()
        .trim_matches('"')
        .trim_end_matches(['\\', '/'])
        .to_ascii_lowercase()
}

fn is_e2e_sandbox_segment(raw: &str) -> bool {
    raw.trim().to_ascii_lowercase().contains("kite-e2e-")
}

/// Returns `true` when running inside an automated E2E sandbox whose temp `APPDATA`
/// directory must never be persisted onto the user's Windows Registry `PATH`.
pub fn should_skip_registration_with_env(
    candidate_dir: &Path,
    sandbox_root: Option<&str>,
    appdata: Option<&str>,
    local_appdata: Option<&str>,
) -> bool {
    if sandbox_root.is_some_and(|v| !v.trim().is_empty()) {
        return true;
    }
    if is_e2e_sandbox_segment(&candidate_dir.to_string_lossy()) {
        return true;
    }
    if appdata.is_some_and(is_e2e_sandbox_segment) {
        return true;
    }
    if local_appdata.is_some_and(is_e2e_sandbox_segment) {
        return true;
    }
    false
}

/// Removes stale `kite-e2e-` sandbox entries and duplicate segments from a Windows `PATH` value.
pub fn sanitize_user_path_segments(raw: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut kept = Vec::new();
    for part in raw.split(';') {
        let trimmed = part.trim();
        if trimmed.is_empty() || is_e2e_sandbox_segment(trimmed) {
            continue;
        }
        let norm = normalize_path_segment(trimmed);
        if norm.is_empty() || !seen.insert(norm) {
            continue;
        }
        kept.push(trimmed);
    }
    kept.join(";")
}

/// Returns `Some(updated_path)` if `dir_str` is not present in `existing` (or `expanded_existing`),
/// or if stale `kite-e2e-` sandbox entries were pruned; returns `None` if already clean and registered.
pub fn merge_user_path_value(
    existing: &str,
    dir_str: &str,
    expanded_existing: Option<&str>,
) -> Option<String> {
    let norm_target = normalize_path_segment(dir_str);
    if norm_target.is_empty() {
        return None;
    }

    let has_e2e_pollution = existing.split(';').any(is_e2e_sandbox_segment);
    let cleaned_existing = if has_e2e_pollution {
        sanitize_user_path_segments(existing)
    } else {
        existing.to_string()
    };

    let check_haystack = |haystack: &str| {
        haystack
            .split(';')
            .map(normalize_path_segment)
            .any(|seg| !seg.is_empty() && seg == norm_target)
    };

    let already_present = check_haystack(&cleaned_existing)
        || expanded_existing
            .is_some_and(|expanded| check_haystack(&sanitize_user_path_segments(expanded)));

    if already_present {
        return has_e2e_pollution.then_some(cleaned_existing);
    }

    let trimmed = cleaned_existing.trim();
    if trimmed.is_empty() {
        Some(dir_str.to_string())
    } else {
        let base = trimmed.trim_end_matches(';');
        if base.is_empty() {
            Some(dir_str.to_string())
        } else {
            Some(format!("{base};{dir_str}"))
        }
    }
}

fn dir_has_kite_cli(dir: &Path) -> bool {
    if cfg!(windows) {
        dir.join("kite.exe").is_file() || dir.join("kite.cmd").is_file()
    } else {
        dir.join("kite").is_file()
    }
}

fn prod_roaming_bin_dir() -> Option<PathBuf> {
    let base = std::env::var("APPDATA")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .ok()
                .filter(|v| !v.trim().is_empty())
                .map(|home| PathBuf::from(home).join("AppData").join("Roaming"))
        })?;
    Some(base.join("Kite Code").join("bin"))
}

/// Chooses the bin directory to register on User `PATH`.
/// In debug builds, prefers an already-installed Production `Kite Code\bin` if present
/// so Dev builds never hijack `kite` away from the installed release.
pub fn preferred_shim_bin_dir(candidate_dir: &Path) -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        if let Some(prod_bin) = prod_roaming_bin_dir() {
            if dir_has_kite_cli(&prod_bin) {
                return Some(prod_bin);
            }
        }
    }
    if dir_has_kite_cli(candidate_dir) {
        Some(candidate_dir.to_path_buf())
    } else {
        None
    }
}

fn is_test_binary() -> bool {
    std::env::current_exe()
        .map(|exe| {
            let in_deps = exe
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("deps"));
            let test_stem = exe
                .file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|stem| {
                    stem.starts_with("kite_code-")
                        || (stem.starts_with("kite-") && stem != "kite-code")
                });
            in_deps || test_stem
        })
        .unwrap_or(false)
}

#[cfg(windows)]
fn expand_env(raw: &str) -> Option<String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Environment::ExpandEnvironmentStringsW;

    unsafe {
        let src = HSTRING::from(raw);
        let needed = ExpandEnvironmentStringsW(&src, None);
        if needed == 0 {
            return None;
        }
        let mut buf = vec![0u16; needed as usize];
        let written = ExpandEnvironmentStringsW(&src, Some(&mut buf));
        if written == 0 {
            return None;
        }
        let end = buf
            .iter()
            .position(|&c| c == 0)
            .unwrap_or((written as usize).saturating_sub(1));
        Some(String::from_utf16_lossy(&buf[..end]))
    }
}

#[cfg(windows)]
fn broadcast_environment_change() {
    #[link(name = "user32")]
    extern "system" {
        fn SendMessageTimeoutW(
            hwnd: isize,
            msg: u32,
            wparam: usize,
            lparam: *const u16,
            flags: u32,
            timeout_ms: u32,
            result: *mut usize,
        ) -> isize;
    }

    const HWND_BROADCAST: isize = 0xffff;
    const WM_SETTINGCHANGE: u32 = 0x001A;
    const SMTO_ABORTIFHUNG: u32 = 0x0002;
    let wide: Vec<u16> = "Environment\0".encode_utf16().collect();
    let mut res: usize = 0;
    unsafe {
        let _ = SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            wide.as_ptr(),
            SMTO_ABORTIFHUNG,
            500,
            &mut res,
        );
    }
}

/// Ensures the Kite CLI shim directory is registered on Windows User `PATH`
/// (`HKCU\Environment\Path`). Returns `true` if the registry value was updated.
pub fn ensure_kite_bin_on_user_path(candidate_dir: &Path) -> bool {
    if cfg!(test)
        || is_test_binary()
        || should_skip_registration_with_env(
            candidate_dir,
            std::env::var("KITE_E2E_SANDBOX_ROOT").ok().as_deref(),
            std::env::var("APPDATA").ok().as_deref(),
            std::env::var("LOCALAPPDATA").ok().as_deref(),
        )
    {
        return false;
    }

    #[cfg(not(windows))]
    {
        let _ = candidate_dir;
        false
    }

    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::Foundation::ERROR_SUCCESS;
        use windows::Win32::System::Registry::{
            RegCloseKey, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
            KEY_READ, KEY_SET_VALUE, REG_EXPAND_SZ, REG_SZ, REG_VALUE_TYPE,
        };

        let Some(target_dir) = preferred_shim_bin_dir(candidate_dir) else {
            return false;
        };
        let target_str = target_dir.to_string_lossy().to_string();

        unsafe {
            let mut hkey = HKEY::default();
            if RegOpenKeyExW(
                HKEY_CURRENT_USER,
                &HSTRING::from("Environment"),
                None,
                KEY_READ | KEY_SET_VALUE,
                &mut hkey,
            ) != ERROR_SUCCESS
            {
                return false;
            }

            let val_name = HSTRING::from("Path");
            let mut val_type = REG_VALUE_TYPE(0);
            let mut size = 0u32;
            let mut existing = String::new();
            let mut write_type = REG_EXPAND_SZ;

            if RegQueryValueExW(
                hkey,
                &val_name,
                None,
                Some(&mut val_type),
                None,
                Some(&mut size),
            ) == ERROR_SUCCESS
                && size >= 2
                && (val_type == REG_SZ || val_type == REG_EXPAND_SZ)
            {
                let mut buf = vec![0u8; size as usize];
                if RegQueryValueExW(
                    hkey,
                    &val_name,
                    None,
                    Some(&mut val_type),
                    Some(buf.as_mut_ptr()),
                    Some(&mut size),
                ) == ERROR_SUCCESS
                {
                    write_type = val_type;
                    let words = std::slice::from_raw_parts(
                        buf.as_ptr() as *const u16,
                        (size as usize) / 2,
                    );
                    let trimmed = words.split(|&c| c == 0).next().unwrap_or(&[]);
                    existing = String::from_utf16_lossy(trimmed);
                }
            }

            let expanded = if write_type == REG_EXPAND_SZ && !existing.is_empty() {
                expand_env(&existing)
            } else {
                None
            };

            let Some(updated) = merge_user_path_value(&existing, &target_str, expanded.as_deref())
            else {
                let _ = RegCloseKey(hkey);
                return false;
            };

            let mut wide: Vec<u16> = updated.encode_utf16().collect();
            wide.push(0);
            let bytes = std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2);
            let set_status = RegSetValueExW(hkey, &val_name, None, write_type, Some(bytes));
            let _ = RegCloseKey(hkey);

            if set_status == ERROR_SUCCESS {
                broadcast_environment_change();
                true
            } else {
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_user_path_appends_and_deduplicates_case_insensitively() {
        let target = r"C:\Users\PC\AppData\Roaming\Kite Code\bin";
        assert_eq!(
            merge_user_path_value("", target, None),
            Some(target.to_string())
        );
        assert_eq!(
            merge_user_path_value(r"C:\Tools;C:\CLIs;", target, None),
            Some(format!(r"C:\Tools;C:\CLIs;{target}"))
        );
        assert_eq!(
            merge_user_path_value(
                r"c:\users\pc\appdata\roaming\kite code\bin\;C:\Tools",
                target,
                None
            ),
            None
        );
        assert_eq!(
            merge_user_path_value(
                r"%APPDATA%\Kite Code\bin;C:\Tools",
                target,
                Some(r"C:\Users\PC\AppData\Roaming\Kite Code\bin;C:\Tools")
            ),
            None
        );
    }

    #[test]
    fn ensure_kite_bin_on_user_path_never_mutates_registry_under_tests() {
        let dir = std::env::temp_dir().join("kite-test-nonexistent-bin");
        assert!(!ensure_kite_bin_on_user_path(&dir));
    }

    #[test]
    fn skips_registration_for_e2e_sandbox_environments_and_paths() {
        let normal_dir = Path::new(r"C:\Users\PC\AppData\Roaming\Kite Code\bin");
        assert!(!should_skip_registration_with_env(normal_dir, None, None, None));

        assert!(should_skip_registration_with_env(
            normal_dir,
            Some(r"C:\Temp\kite-e2e-123"),
            None,
            None,
        ));
        assert!(should_skip_registration_with_env(
            normal_dir,
            None,
            Some(r"C:\Users\PC\AppData\Local\Temp\kite-e2e-123\appdata"),
            None,
        ));
        assert!(should_skip_registration_with_env(
            Path::new(r"C:\Windows\Temp\kite-e2e-999\appdata\Kite Code Dev\bin"),
            None,
            None,
            None,
        ));
    }

    #[test]
    fn sanitize_and_merge_prune_stale_e2e_segments_without_breaking_clean_paths() {
        let target = r"C:\Users\PC\AppData\Roaming\Kite Code\bin";
        let polluted = r"C:\Tools;C:\Users\PC\AppData\Local\Temp\kite-e2e-111\appdata\Kite Code Dev\bin;C:\WINDOWS\TEMP\kite-e2e-222\appdata\Kite Code Dev\bin;C:\Users\PC\AppData\Roaming\Kite Code\bin";
        assert_eq!(
            sanitize_user_path_segments(polluted),
            r"C:\Tools;C:\Users\PC\AppData\Roaming\Kite Code\bin"
        );
        assert_eq!(
            merge_user_path_value(polluted, target, None),
            Some(r"C:\Tools;C:\Users\PC\AppData\Roaming\Kite Code\bin".to_string())
        );
    }
}
