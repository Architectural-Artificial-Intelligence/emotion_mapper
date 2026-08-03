#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{Manager, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const HEALTH_URL: &str = "http://localhost:3000/health";
const APP_URL: &str = "http://localhost:3000/";

fn main() {
    // Shared across the window's CloseRequested handler (normal quit path) and
    // RunEvent::Exit below (backstop for other exit paths) so the sidecar is
    // reaped either way — a plain SIGTERM to this process alone was observed
    // to leave the Node child orphaned, since that bypasses both.
    let child_holder: Arc<Mutex<Option<CommandChild>>> = Arc::new(Mutex::new(None));
    let child_for_run = child_holder.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            let handle = app.handle().clone();

            // See NOTES.md #1: `document_dir()` name/signature unverified (no
            // Rust toolchain available while writing this) against the
            // installed tauri version.
            let documents_dir = handle
                .path()
                .document_dir()
                .expect("could not resolve Documents directory");
            let data_dir = documents_dir.join("EmotionMapper");
            std::fs::create_dir_all(&data_dir).expect("failed to create EmotionMapper data dir");

            // resource_dir() resolves to the app's install directory, not the
            // resources/ subfolder itself — bundle.resources in
            // tauri.conf.json lands one level deeper, at resource_dir/resources/
            // (confirmed by extracting and running a built .deb package).
            let resource_dir = handle
                .path()
                .resource_dir()
                .expect("could not resolve resource dir")
                .join("resources");

            // See NOTES.md #2: sidecar() / args() / spawn() signatures unverified.
            let (mut rx, child) = handle
                .shell()
                .sidecar("node")
                .expect("failed to create sidecar command")
                .args(["server/app.js"])
                .current_dir(resource_dir)
                .env("EMOTION_MAPPER_DATA_DIR", data_dir.to_string_lossy().to_string())
                .env("PORT", "3000")
                .spawn()
                .expect("failed to spawn node sidecar");

            *child_holder.lock().unwrap() = Some(child);
            let child_for_exit = child_holder.clone();

            // See NOTES.md #3: CommandEvent variant names unverified.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            println!("[node] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[node] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[node] sidecar exited: {:?}", payload);
                        }
                        _ => {}
                    }
                }
            });

            let window = handle.get_webview_window("main").expect("no main window");
            tauri::async_runtime::spawn(async move {
                for _ in 0..100 {
                    if ureq::get(HEALTH_URL).call().is_ok() {
                        // See NOTES.md #4: eval-based navigation vs a dedicated
                        // navigate() API unverified.
                        let _ = window.eval(&format!("window.location.replace('{}');", APP_URL));
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                eprintln!("node sidecar did not become healthy in time");
            });

            let main_window = handle.get_webview_window("main").expect("no main window");
            main_window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { .. } = event {
                    if let Some(child) = child_for_exit.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |_app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(child) = child_for_run.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    });
}
