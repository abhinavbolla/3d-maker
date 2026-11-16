// Desktop shell for 3D Maker. The app itself is the web UI in ../src;
// Rust adds native file dialogs, file reads/writes, and runs the user's own
// Claude Code for the prompt box.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager};

#[tauri::command]
fn write_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, data).map_err(|e| format!("Could not write {path}: {e}"))
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))
}

fn autosave_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
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

// ---- Claude Code ----
// Apps opened from Finder get a bare PATH, so ask the user's login shell where
// `claude` and `node` live and what PATH it uses.
struct ShellEnv {
    claude: Option<String>,
    node: Option<String>,
    path: String,
}

const CLAUDE_MISSING: &str =
    "Claude Code was not found. 3D Maker uses your own Claude Code to draw: install it from claude.com/claude-code, run `claude` once in a terminal to log in, then try again.";
const NODE_MISSING: &str = "Node.js was not found. 3D Maker needs Node.js 20 or newer to connect Claude Code to this window: install it from nodejs.org, then try again.";

#[cfg(not(windows))]
fn shell_env() -> &'static ShellEnv {
    static ENV: OnceLock<ShellEnv> = OnceLock::new();
    ENV.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let out = Command::new(&shell).args(["-l", "-c", "printf '%s\\n%s\\n%s' \"$PATH\" \"$(command -v claude)\" \"$(command -v node)\""]).stdin(Stdio::null()).output();
        let home = std::env::var("HOME").unwrap_or_default();
        let (mut path, mut claude, mut node) = (std::env::var("PATH").unwrap_or_default(), None, None);
        if let Ok(o) = out {
            let text = String::from_utf8_lossy(&o.stdout).to_string();
            let mut lines = text.lines();
            if let Some(p) = lines.next()
                && !p.is_empty()
            {
                path = p.to_string();
            }
            let mut found = || lines.next().map(str::trim).filter(|c| !c.is_empty()).map(str::to_string);
            claude = found();
            node = found();
        }
        let first = |candidates: [String; 4]| candidates.into_iter().find(|c| std::path::Path::new(c).exists());
        if claude.is_none() {
            claude = first([format!("{home}/.local/bin/claude"), format!("{home}/.claude/local/claude"), "/opt/homebrew/bin/claude".into(), "/usr/local/bin/claude".into()]);
        }
        if node.is_none() {
            node = first([format!("{home}/.volta/bin/node"), "/opt/homebrew/bin/node".into(), "/usr/local/bin/node".into(), "/usr/bin/node".into()]);
        }
        path = format!("{path}:{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin");
        ShellEnv { claude, node, path }
    })
}

// Windows apps get the user's PATH as it is, so `where` finds both. Claude
// Code's own installer puts claude.exe in .local\bin, which may not be on it.
#[cfg(windows)]
fn shell_env() -> &'static ShellEnv {
    static ENV: OnceLock<ShellEnv> = OnceLock::new();
    ENV.get_or_init(|| {
        let find = |name: &str| {
            let out = Command::new("where").arg(name).stdin(Stdio::null()).output().ok()?;
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            let all: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
            all.iter().find(|l| l.to_lowercase().ends_with(".exe")).or(all.iter().find(|l| l.to_lowercase().ends_with(".cmd"))).map(|s| s.to_string())
        };
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        let own = format!("{home}\\.local\\bin\\claude.exe");
        let claude = find("claude").or_else(|| std::path::Path::new(&own).exists().then_some(own));
        ShellEnv { claude, node: find("node"), path: std::env::var("PATH").unwrap_or_default() }
    })
}

// A .cmd file (Claude Code installed with npm on Windows) runs through cmd.
fn command_for(program: &str) -> Command {
    if cfg!(windows) && program.to_lowercase().ends_with(".cmd") {
        let mut c = Command::new("cmd");
        c.args(["/C", program]);
        c
    } else {
        Command::new(program)
    }
}

// How Claude Code should start the MCP server that connects it to this
// window: the copy bundled with the installed app, run by the user's Node.
// None while developing (`npm run app`), where the web UI uses the
// repository's own server and the Node that built it.
#[derive(serde::Serialize)]
struct McpServer {
    command: String,
    server: String,
}

#[tauri::command]
fn mcp_server(app: tauri::AppHandle) -> Result<Option<McpServer>, String> {
    let Ok(dir) = app.path().resource_dir() else { return Ok(None) };
    let server = dir.join("mcp").join("server.mjs");
    if !server.exists() {
        return Ok(None);
    }
    let node = shell_env().node.clone().ok_or(NODE_MISSING)?;
    Ok(Some(McpServer { command: node, server: server.to_string_lossy().into_owned() }))
}

fn runs() -> &'static Mutex<HashMap<u32, Child>> {
    static RUNS: OnceLock<Mutex<HashMap<u32, Child>>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, serde::Serialize)]
struct Line {
    run: u32,
    line: String,
}

#[derive(Clone, serde::Serialize)]
struct Exit {
    run: u32,
    code: i32,
    stderr: String,
}

fn spawn_claude(args: &[String], cwd: &std::path::Path) -> Result<Child, String> {
    let env = shell_env();
    let claude = env.claude.clone().ok_or(CLAUDE_MISSING)?;
    std::fs::create_dir_all(cwd).map_err(|e| e.to_string())?;
    command_for(&claude)
        .args(args)
        .current_dir(cwd)
        .env("PATH", &env.path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start Claude Code: {e}"))
}

// Starts `claude -p ...` with the arguments the web UI built. Only the claude
// command can be started, and only in print mode.
#[tauri::command]
fn claude_start(app: tauri::AppHandle, args: Vec<String>) -> Result<u32, String> {
    if args.first().map(String::as_str) != Some("-p") {
        return Err("Only print mode is allowed.".into());
    }
    let cwd = app.path().app_data_dir().map_err(|e| e.to_string())?.join("claude");
    let mut child = spawn_claude(&args, &cwd)?;
    static NEXT: Mutex<u32> = Mutex::new(0);
    let id = {
        let mut n = NEXT.lock().unwrap();
        *n += 1;
        *n
    };
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    runs().lock().unwrap().insert(id, child);
    let err_text = std::sync::Arc::new(Mutex::new(String::new()));
    let err_sink = err_text.clone();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        *err_sink.lock().unwrap() = s;
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = app.emit("claude-line", Line { run: id, line });
        }
        let child = runs().lock().unwrap().remove(&id);
        let code = child.and_then(|mut c| c.wait().ok()).and_then(|s| s.code()).unwrap_or(-1);
        std::thread::sleep(std::time::Duration::from_millis(50));
        let stderr = err_text.lock().unwrap().chars().rev().take(4000).collect::<Vec<_>>().into_iter().rev().collect();
        let _ = app.emit("claude-exit", Exit { run: id, code, stderr });
    });
    Ok(id)
}

#[tauri::command]
fn claude_stop(run: u32) {
    if let Some(child) = runs().lock().unwrap().get_mut(&run) {
        let _ = child.kill();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![write_file, read_file, autosave_write, autosave_read, claude_start, claude_stop, mcp_server])
        .run(tauri::generate_context!())
        .expect("error while running 3D Maker");
}

#[cfg(test)]
mod tests {
    use super::*;

    // Runs a real, tiny Claude Code request the way the prompt box does.
    // Needs Claude Code installed and logged in: cargo test -- --ignored
    #[test]
    #[ignore]
    fn runs_claude_and_streams_json() {
        let cwd = std::env::temp_dir().join("3d-maker-claude-test");
        let args: Vec<String> = ["-p", "Reply with just the word ok.", "--output-format", "stream-json", "--verbose", "--max-turns", "1"].iter().map(|s| s.to_string()).collect();
        let mut child = spawn_claude(&args, &cwd).expect("spawn");
        let lines: Vec<String> = BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok).collect();
        child.wait().unwrap();
        assert!(lines.iter().any(|l| l.contains("\"type\":\"system\"") && l.contains("session_id")), "no init line");
        let result = lines.iter().find(|l| l.contains("\"type\":\"result\"")).expect("no result line");
        assert!(result.contains("\"is_error\":false"), "{result}");
    }

    #[test]
    fn reads_path_from_login_shell() {
        assert!(shell_env().path.contains(if cfg!(windows) { '\\' } else { '/' }));
    }

    // Whoever builds the app has Node, so it must be found.
    #[test]
    fn finds_node() {
        let node = shell_env().node.clone().expect("node not found");
        let out = Command::new(&node).arg("--version").output().expect("node runs");
        assert!(String::from_utf8_lossy(&out.stdout).starts_with('v'));
    }
    // Needs Claude Code installed: cargo test -- --ignored
    #[test]
    #[ignore]
    fn finds_claude_through_login_shell() {
        assert!(shell_env().claude.is_some());
    }
}
