use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::fs;
use std::process::Command;
use std::sync::mpsc;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    Emitter, Manager,
};

const STATUS_FILES: &[(&str, &str)] = &[
    ("frontend", ".frontend-status.json"),
    ("backend", ".backend-status.json"),
    ("qa", ".qa-status.json"),
    ("ux", ".ux-status.json"),
    ("reviewer", ".reviewer-status.json"),
    ("devops", ".devops-status.json"),
];

fn ollama_is_running() -> bool {
    std::net::TcpStream::connect_timeout(
        &"127.0.0.1:11434"
            .parse()
            .expect("static socket address is always valid"),
        std::time::Duration::from_millis(500),
    )
    .is_ok()
}

fn find_ollama_binary() -> Option<std::path::PathBuf> {
    let candidates = [
        std::env::var("LOCALAPPDATA")
            .ok()
            .map(|p| std::path::PathBuf::from(p).join("Programs").join("Ollama").join("ollama.exe")),
        Some(std::path::PathBuf::from(r"C:\Program Files\Ollama\ollama.exe")),
        Some(std::path::PathBuf::from("ollama")),
    ];

    for candidate in candidates.iter().flatten() {
        if candidate.exists() || candidate.to_str() == Some("ollama") {
            return Some(candidate.clone());
        }
    }
    None
}

fn ensure_ollama_running(app_handle: &tauri::AppHandle) {
    std::thread::spawn({
        let app_handle = app_handle.clone();
        move || {
            if ollama_is_running() {
                eprintln!("[office] Ollama already running on :11434");
                let _ = app_handle.emit("ollama-status", serde_json::json!({
                    "online": true, "started_by_office": false
                }));
                return;
            }

            let binary = match find_ollama_binary() {
                Some(b) => b,
                None => {
                    eprintln!("[office] Ollama binary not found — skipping auto-start");
                    let _ = app_handle.emit("ollama-status", serde_json::json!({
                        "online": false, "installed": false
                    }));
                    return;
                }
            };

            eprintln!("[office] Starting Ollama via: {}", binary.display());
            match Command::new(&binary)
                .arg("serve")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
            {
                Ok(_child) => {
                    // Give it a moment to bind the port
                    for _ in 0..10 {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        if ollama_is_running() {
                            eprintln!("[office] Ollama started successfully");
                            let _ = app_handle.emit("ollama-status", serde_json::json!({
                                "online": true, "started_by_office": true
                            }));
                            return;
                        }
                    }
                    eprintln!("[office] Ollama process launched but port not responding");
                    let _ = app_handle.emit("ollama-status", serde_json::json!({
                        "online": false, "installed": true, "error": "Port not responding after 5s"
                    }));
                }
                Err(e) => {
                    eprintln!("[office] Failed to start Ollama: {e}");
                    let _ = app_handle.emit("ollama-status", serde_json::json!({
                        "online": false, "installed": true, "error": format!("{e}")
                    }));
                }
            }
        }
    });
}

fn watch_status_files(app_handle: tauri::AppHandle) {
    let base_dir = std::env::current_dir().unwrap_or_default();

    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();

        let mut watcher: RecommendedWatcher = match Watcher::new(
            tx,
            notify::Config::default()
                .with_poll_interval(std::time::Duration::from_secs(2)),
        ) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("Failed to create file watcher: {e}");
                return;
            }
        };

        if let Err(e) = watcher.watch(&base_dir, RecursiveMode::NonRecursive) {
            eprintln!("Failed to watch directory: {e}");
            return;
        }

        for event in rx {
            match event {
                Ok(Event {
                    kind: EventKind::Modify(_) | EventKind::Create(_),
                    paths,
                    ..
                }) => {
                    for (agent_id, filename) in STATUS_FILES {
                        let matched = paths.iter().any(|p| {
                            p.file_name()
                                .map(|n| n == *filename)
                                .unwrap_or(false)
                        });

                        if matched {
                            let full_path = base_dir.join(filename);
                            if let Ok(content) = fs::read_to_string(&full_path) {
                                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                                    let event_name = format!("status-update-{agent_id}");
                                    let _ = app_handle.emit("status-update", &json);
                                    let _ = app_handle.emit(&event_name, &json);
                                }
                            }
                        }
                    }
                }
                Err(e) => eprintln!("Watch error: {e}"),
                _ => {}
            }
        }
    });
}

#[tauri::command]
fn read_status() -> Result<serde_json::Value, String> {
    read_agent_status("frontend".to_string())
}

#[tauri::command]
fn read_agent_status(agent_id: String) -> Result<serde_json::Value, String> {
    let filename = STATUS_FILES
        .iter()
        .find(|(id, _)| *id == agent_id)
        .map(|(_, f)| *f)
        .ok_or_else(|| format!("Unknown agent: {agent_id}"))?;

    let path = std::env::current_dir().unwrap_or_default().join(filename);
    let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read status: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse status: {e}"))
}

#[tauri::command]
fn send_chat(agent_id: String, message: String) -> Result<(), String> {
    let chat_file = std::env::current_dir()
        .unwrap_or_default()
        .join(format!(".{agent_id}-messages.json"));

    let mut messages: Vec<serde_json::Value> = if let Ok(content) = fs::read_to_string(&chat_file) {
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        Vec::new()
    };

    let msg: serde_json::Value =
        serde_json::from_str(&message).map_err(|e| format!("Invalid message JSON: {e}"))?;
    messages.push(msg);

    let json = serde_json::to_string_pretty(&messages)
        .map_err(|e| format!("Failed to serialize: {e}"))?;
    fs::write(&chat_file, json).map_err(|e| format!("Failed to write chat file: {e}"))?;

    Ok(())
}

#[tauri::command]
fn check_ollama() -> serde_json::Value {
    serde_json::json!({ "online": ollama_is_running() })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            read_status,
            read_agent_status,
            send_chat,
            check_ollama
        ])
        .setup(|app| {
            let open = MenuItemBuilder::new("Open Dashboard").id("open").build(app)?;
            let quit = MenuItemBuilder::new("Quit").id("quit").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&open, &quit]).build()?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("The Office — OSV Agents")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            ensure_ollama_running(app.handle());
            watch_status_files(app.handle().clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running The Office");
}
