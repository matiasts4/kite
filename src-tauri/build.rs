// When running in debug mode (dev), override the productName and identifier
fn main() {
    if std::env::var("PROFILE").unwrap_or_default() == "debug" {
        println!("cargo:rustc-env=TAURI_CONFIG={{\"productName\":\"Kite Code (Dev)\",\"identifier\":\"dev.kite.code.dev\",\"app\":{{\"windows\":[{{\"label\":\"main\",\"title\":\"Kite Code (Dev)\"}}]}}}}");
    }
    tauri_build::build()
}
