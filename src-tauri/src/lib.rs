use std::sync::Mutex;
use tauri::{
    ipc::{InvokeBody, Request, Response},
    Emitter, Manager, State,
};

#[derive(Default)]
struct InitialFiles(Mutex<Vec<String>>);

/// Keep only args that look like existing files (skips flags and the exe path).
fn file_args<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-') && std::path::Path::new(a).is_file())
        .collect()
}

/// Files passed on the command line when the app was launched (double-click in Explorer).
#[tauri::command]
fn take_initial_files(state: State<InitialFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

/// Binary read: the bytes go to the webview as a raw ArrayBuffer (no JSON overhead).
#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("{path}: {e}"))
}

/// Binary write: body = raw bytes, path is sent URL-encoded in the `x-path` header.
#[tauri::command]
fn write_file(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("expected a raw body".into());
    };
    let raw = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-path header")?;
    let path = urlencoding::decode(raw)
        .map_err(|e| e.to_string())?
        .into_owned();
    std::fs::write(&path, data).map_err(|e| format!("{path}: {e}"))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let files = file_args(args);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if !files.is_empty() {
                let _ = app.emit("open-files", files);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(InitialFiles(Mutex::new(file_args(std::env::args()))))
        .invoke_handler(tauri::generate_handler![
            take_initial_files,
            read_file,
            write_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running PDFio");
}
