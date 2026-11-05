import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('src-tauri/src/local_feed.rs');
let code = fs.readFileSync(filePath, 'utf8');

const target = `pub fn resolve_feed_dir() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("feed"));
        candidates.push(cwd.join("..").join("feed"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("feed"));
            candidates.push(dir.join("..").join("..").join("feed"));
            candidates.push(dir.join("..").join("..").join("..").join("feed"));
        }
    }
    candidates.into_iter().find(|path| path.is_dir())
}`;

const replacement = `pub fn resolve_feed_dir() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(env_feed) = std::env::var("KITE_FEED_DIR") {
        candidates.push(PathBuf::from(env_feed));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("feed"));
        candidates.push(cwd.join("..").join("feed"));
        candidates.push(cwd.join("..").join("kite").join("feed"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("feed"));
            candidates.push(dir.join("..").join("feed"));
            candidates.push(dir.join("..").join("kite").join("feed"));
            candidates.push(dir.join("..").join("..").join("feed"));
            candidates.push(dir.join("..").join("..").join("kite").join("feed"));
            candidates.push(dir.join("..").join("..").join("..").join("feed"));
        }
    }
    candidates.into_iter().find(|path| path.is_dir())
}`;

code = code.replace(target.replace(/\r?\n/g, '\r\n'), replacement.replace(/\r?\n/g, '\r\n'));
fs.writeFileSync(filePath, code, 'utf8');
console.log('Updated local_feed.rs');
