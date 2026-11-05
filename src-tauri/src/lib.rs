// Desktop shell for 3D Maker. The app itself is the web UI in ../src;
// Rust only adds native file dialogs and file reads/writes.

#[tauri::command]
fn write_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, data).map_err(|e| format!("Could not write {path}: {e}"))
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))
}

fn autosave_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("autosave.json"))
}

#[tauri::command]
fn autosave_write(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let path = autosave_path(&app)?;
    // Write then rename, so a crash mid-write never leaves a half file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn autosave_read(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = autosave_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![write_file, read_file, autosave_write, autosave_read])
        .run(tauri::generate_context!())
        .expect("error while running 3D Maker");
}
