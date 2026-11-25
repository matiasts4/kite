use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalEngineStatus {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub binary_path: Option<String>,
    pub model_path: Option<String>,
    pub detail: String,
}

fn find_binary_in_path(candidates: &[&str]) -> Option<String> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for name in candidates {
            let full = dir.join(name);
            if full.is_file() {
                return Some(full.to_string_lossy().into_owned());
            }
            #[cfg(windows)]
            {
                let exe = dir.join(format!("{name}.exe"));
                if exe.is_file() {
                    return Some(exe.to_string_lossy().into_owned());
                }
            }
        }
    }
    None
}

fn find_model_file(override_path: Option<&str>, extensions: &[&str], prefix: Option<&str>) -> Option<String> {
    if let Some(raw) = override_path.map(str::trim).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(raw);
        if p.is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
    }

    let mut search_dirs: Vec<PathBuf> = Vec::new();
    if let Ok(app_dir) = std::env::var("APPDATA") {
        search_dirs.push(PathBuf::from(&app_dir).join("Kite Code").join("models"));
        search_dirs.push(PathBuf::from(&app_dir).join("Kite Code Dev").join("models"));
    }
    if let Ok(local_dir) = std::env::var("LOCALAPPDATA") {
        search_dirs.push(PathBuf::from(&local_dir).join("Kite Code").join("models"));
    }

    for dir in search_dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let file_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let ext_ok = extensions.iter().any(|ext| file_name.ends_with(ext));
            let prefix_ok = prefix.map(|p| file_name.starts_with(p)).unwrap_or(true);
            if ext_ok && prefix_ok {
                return Some(path.to_string_lossy().into_owned());
            }
        }
    }

    None
}

pub fn probe_local_engines_with_paths(
    whisper_bin: Option<String>,
    whisper_model: Option<String>,
    parakeet_bin: Option<String>,
    parakeet_model: Option<String>,
) -> Vec<LocalEngineStatus> {
    let whisper_ready = whisper_bin.is_some() && whisper_model.is_some();
    let whisper_detail = if whisper_ready {
        format!(
            "Motor Whisper listo ({}).",
            whisper_model.as_deref().unwrap_or("modelo configurado")
        )
    } else if whisper_model.is_some() {
        "Modelo Whisper encontrado; falta binario whisper-cli en PATH.".to_string()
    } else if whisper_bin.is_some() {
        "Binario Whisper detectado; falta seleccionar un modelo (.bin / .gguf).".to_string()
    } else {
        "No hay modelo ni binario local Whisper configurado.".to_string()
    };

    let parakeet_ready = parakeet_bin.is_some() && parakeet_model.is_some();
    let parakeet_detail = if parakeet_ready {
        format!(
            "Motor Parakeet listo ({}).",
            parakeet_model.as_deref().unwrap_or("modelo configurado")
        )
    } else if parakeet_model.is_some() {
        "Modelo Parakeet encontrado; falta binario parakeet-stt en PATH.".to_string()
    } else {
        "No hay modelo local Parakeet (.onnx) configurado.".to_string()
    };

    vec![
        LocalEngineStatus {
            id: "whisper".to_string(),
            label: "Whisper".to_string(),
            available: whisper_ready,
            binary_path: whisper_bin,
            model_path: whisper_model,
            detail: whisper_detail,
        },
        LocalEngineStatus {
            id: "parakeet".to_string(),
            label: "Parakeet".to_string(),
            available: parakeet_ready,
            binary_path: parakeet_bin,
            model_path: parakeet_model,
            detail: parakeet_detail,
        },
    ]
}

pub fn probe_local_engines(
    whisper_model_override: Option<&str>,
    parakeet_model_override: Option<&str>,
) -> Vec<LocalEngineStatus> {
    let whisper_bin = std::env::var("KITE_WHISPER_CLI")
        .ok()
        .filter(|s| Path::new(s.trim()).is_file())
        .or_else(|| find_binary_in_path(&["whisper-cli", "whisper-cpp", "whisper"]));
    let env_whisper_model = std::env::var("KITE_WHISPER_MODEL").ok();
    let whisper_model = find_model_file(
        whisper_model_override.or(env_whisper_model.as_deref()),
        &[".bin", ".gguf"],
        None,
    );

    let parakeet_bin = std::env::var("KITE_PARAKEET_CLI")
        .ok()
        .filter(|s| Path::new(s.trim()).is_file())
        .or_else(|| find_binary_in_path(&["parakeet-stt", "parakeet"]));
    let env_parakeet_model = std::env::var("KITE_PARAKEET_MODEL").ok();
    let parakeet_model = find_model_file(
        parakeet_model_override.or(env_parakeet_model.as_deref()),
        &[".onnx"],
        None,
    );

    probe_local_engines_with_paths(whisper_bin, whisper_model, parakeet_bin, parakeet_model)
}

pub fn transcribe_wav_offline_with_runner<F>(
    wav_bytes: &[u8],
    engine_id: &str,
    binary_path: &str,
    model_path: &str,
    language: &str,
    runner: F,
) -> Result<String, String>
where
    F: FnOnce(&Path, &[&str]) -> Result<String, String>,
{
    if wav_bytes.len() <= 44 {
        return Ok(String::new());
    }
    let tmp_path = std::env::temp_dir().join(format!("kite-stt-{}.wav", Uuid::new_v4()));
    std::fs::write(&tmp_path, wav_bytes)
        .map_err(|e| format!("Failed writing temporary WAV for offline STT: {e}"))?;

    let tmp_str = tmp_path.to_string_lossy().into_owned();
    let lang_short = language.split('-').next().unwrap_or("es");
    let mut args: Vec<&str> = Vec::new();
    if engine_id == "parakeet" {
        args.push("--model");
        args.push(model_path);
        args.push("--input");
        args.push(&tmp_str);
    } else {
        args.push("-m");
        args.push(model_path);
        args.push("-f");
        args.push(&tmp_str);
        args.push("-nt");
        if !lang_short.is_empty() && lang_short != "auto" {
            args.push("-l");
            args.push(lang_short);
        }
    }

    let result = runner(Path::new(binary_path), &args);
    let _ = std::fs::remove_file(&tmp_path);
    result.map(|txt| txt.trim().to_string())
}

pub fn transcribe_wav_offline(
    wav_bytes: &[u8],
    preferred_engine: Option<&str>,
    whisper_model_override: Option<&str>,
    parakeet_model_override: Option<&str>,
    language: &str,
) -> Result<String, String> {
    let engines = probe_local_engines(whisper_model_override, parakeet_model_override);
    let selected = engines
        .iter()
        .find(|e| preferred_engine.map(|p| p == e.id).unwrap_or(false) && e.available)
        .or_else(|| engines.iter().find(|e| e.available))
        .ok_or_else(|| "Ningún motor STT local offline está listo (configura un modelo Whisper o Parakeet).".to_string())?;

    let bin = selected
        .binary_path
        .as_deref()
        .ok_or_else(|| "Falta ruta del binario STT local.".to_string())?;
    let model = selected
        .model_path
        .as_deref()
        .ok_or_else(|| "Falta ruta del modelo STT local.".to_string())?;

    transcribe_wav_offline_with_runner(wav_bytes, &selected.id, bin, model, language, |prog, args| {
        let out = crate::hidden_exec::run(prog, args, Duration::from_secs(20))
            .map_err(|e| format!("Error ejecutando STT offline: {e}"))?;
        if !out.success() {
            let err_txt = String::from_utf8_lossy(&out.stderr);
            return Err(format!("STT offline falló: {}", err_txt.trim()));
        }
        Ok(out.stdout_lossy())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_reports_available_when_binary_and_model_exist() {
        let engines = probe_local_engines_with_paths(
            Some("/usr/bin/whisper-cli".to_string()),
            Some("/models/ggml-base.bin".to_string()),
            None,
            None,
        );
        assert_eq!(engines.len(), 2);
        assert!(engines[0].available);
        assert_eq!(engines[0].id, "whisper");
        assert!(!engines[1].available);
    }

    #[test]
    fn offline_runner_writes_wav_passes_flags_and_cleans_temp_file() {
        let wav = crate::voice_audio::resampler::encode_pcm16_wav(&[100, -100, 250], 16000);
        let mut captured_wav_path: Option<PathBuf> = None;
        let out = transcribe_wav_offline_with_runner(
            &wav,
            "whisper",
            "whisper-cli",
            "ggml-base.bin",
            "es-ES",
            |_prog, args| {
                let f_idx = args.iter().position(|&a| a == "-f").unwrap();
                let wav_path = PathBuf::from(args[f_idx + 1]);
                assert!(wav_path.is_file());
                captured_wav_path = Some(wav_path);
                assert!(args.contains(&"-nt"));
                assert!(args.contains(&"es"));
                Ok("  hola kite  ".to_string())
            },
        )
        .unwrap();

        assert_eq!(out, "hola kite");
        assert!(!captured_wav_path.unwrap().exists());
    }
}
