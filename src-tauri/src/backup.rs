use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const SETTINGS_FILE: &str = "settings.json";
const BACKUP_MARKER: &str = ".projecttray-backups";
const BACKUP_PREFIX: &str = "ProjectTray-backup-";
const BACKUP_RETENTION: usize = 30;
const AUTO_BACKUP_INTERVAL: Duration = Duration::from_secs(5 * 60);
const SAFETY_COPY: &str = "projecttray-before-restore.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BackupSettings {
    pub enabled: bool,
    pub folder: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    pub enabled: bool,
    pub folder: Option<String>,
    pub available: bool,
    pub last_backup_at: Option<String>,
    pub backup_count: usize,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub restored_from: String,
    pub safety_copy: Option<String>,
    pub project_count: usize,
    pub state: Value,
}

pub struct BackupState {
    inner: Mutex<BackupRuntime>,
}

impl BackupState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(BackupRuntime::default()),
        }
    }
}

#[derive(Default)]
struct BackupRuntime {
    last_attempt: Option<Instant>,
    last_error: Option<String>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not find app data folder: {e}"))?;
    Ok(dir.join(SETTINGS_FILE))
}

fn load_settings(app: &AppHandle) -> Result<BackupSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(BackupSettings::default());
    }
    let data =
        fs::read_to_string(&path).map_err(|e| format!("Could not read backup settings: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Could not parse backup settings: {e}"))
}

fn save_settings(app: &AppHandle, settings: &BackupSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let serialized = serde_json::to_vec_pretty(settings)
        .map_err(|e| format!("Could not encode backup settings: {e}"))?;
    write_atomic(&path, &serialized)
}

fn folder_is_available(folder: &Path) -> bool {
    folder.is_dir() && folder.join(BACKUP_MARKER).is_file()
}

fn ensure_marker(folder: &Path) -> Result<(), String> {
    if !folder.is_dir() {
        return Err("That folder is not available.".into());
    }
    let marker = folder.join(BACKUP_MARKER);
    if marker.is_file() {
        return Ok(());
    }
    fs::write(&marker, "ProjectTray automatic backup folder\n")
        .map_err(|e| format!("Could not mark this folder for backups: {e}"))
}

fn is_backup_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(BACKUP_PREFIX) && name.ends_with(".json"))
}

fn backup_files(folder: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };

    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_backup_file(path))
        .collect();

    files.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH)
    });
    files
}

fn prune_backups(folder: &Path) -> Result<(), String> {
    let files = backup_files(folder);
    if files.len() <= BACKUP_RETENTION {
        return Ok(());
    }

    for path in &files[..files.len() - BACKUP_RETENTION] {
        fs::remove_file(path)
            .map_err(|e| format!("Could not remove old backup {}: {e}", path.display()))?;
    }
    Ok(())
}

fn unique_backup_path(folder: &Path) -> PathBuf {
    let stamp = Local::now().format("%Y-%m-%d-%H%M%S");
    let mut candidate = folder.join(format!("{BACKUP_PREFIX}{stamp}.json"));
    let mut suffix = 2;
    while candidate.exists() {
        candidate = folder.join(format!("{BACKUP_PREFIX}{stamp}-{suffix}.json"));
        suffix += 1;
    }
    candidate
}

fn write_backup(folder: &Path, state: &Value) -> Result<PathBuf, String> {
    let serialized = serde_json::to_vec_pretty(state)
        .map_err(|e| format!("Could not encode the backup: {e}"))?;
    let target = unique_backup_path(folder);
    let tmp = target.with_extension("json.tmp");

    fs::write(&tmp, serialized).map_err(|e| format!("Could not write the backup: {e}"))?;
    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Could not finish the backup: {e}")
    })?;

    prune_backups(folder)?;
    Ok(target)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create the app data folder: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Could not replace {}: {e}", path.display())
    })
}

fn read_state_file(app: &AppHandle) -> Result<Value, String> {
    let path = crate::state_path(app)?;
    let data = fs::read_to_string(&path).map_err(|e| format!("Could not read state: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Could not parse state: {e}"))
}

fn validate_backup_state(state: &Value) -> Result<usize, String> {
    state
        .get("projects")
        .and_then(Value::as_array)
        .map(|projects| projects.len())
        .ok_or_else(|| "That file does not contain a ProjectTray project list.".to_string())
}

fn apply_restore(state_path: &Path, restored: &Value) -> Result<Option<PathBuf>, String> {
    let safety_copy = if state_path.exists() {
        let current =
            fs::read(state_path).map_err(|e| format!("Could not read the current state: {e}"))?;
        let parent = state_path
            .parent()
            .ok_or_else(|| "Could not find the app data folder.".to_string())?;
        let safety_path = parent.join(SAFETY_COPY);
        write_atomic(&safety_path, &current)?;
        Some(safety_path)
    } else {
        None
    };

    let serialized = serde_json::to_vec_pretty(restored)
        .map_err(|e| format!("Could not encode the restored state: {e}"))?;
    write_atomic(state_path, &serialized)?;
    Ok(safety_copy)
}

fn record_attempt(app: &AppHandle, error: Option<String>) {
    if let Some(state) = app.try_state::<BackupState>() {
        if let Ok(mut runtime) = state.inner.lock() {
            runtime.last_attempt = Some(Instant::now());
            runtime.last_error = error;
        }
    }
}

fn set_runtime_error(app: &AppHandle, error: Option<String>) {
    if let Some(state) = app.try_state::<BackupState>() {
        if let Ok(mut runtime) = state.inner.lock() {
            runtime.last_error = error;
        }
    }
}

fn runtime_error(app: &AppHandle) -> Option<String> {
    app.try_state::<BackupState>()
        .and_then(|state| state.inner.lock().ok()?.last_error.clone())
}

fn build_status(app: &AppHandle) -> Result<BackupStatus, String> {
    let settings = load_settings(app)?;
    let folder = settings.folder.as_deref().map(PathBuf::from);
    let available = folder.as_deref().is_some_and(folder_is_available);

    let (backup_count, last_backup_at) = match folder.as_deref().filter(|_| available) {
        Some(folder) => {
            let files = backup_files(folder);
            let last = files
                .last()
                .and_then(|path| fs::metadata(path).ok())
                .and_then(|metadata| metadata.modified().ok())
                .map(|time| DateTime::<Local>::from(time).to_rfc3339());
            (files.len(), last)
        }
        None => (0, None),
    };

    Ok(BackupStatus {
        enabled: settings.enabled,
        folder: settings.folder,
        available,
        last_backup_at,
        backup_count,
        last_error: runtime_error(app),
    })
}

/// Snapshot the saved state after a normal save. The throttle keeps the disk
/// work to once every five minutes while still pausing silently when the
/// backup volume is not mounted.
pub fn auto_backup(app: &AppHandle) {
    let Some(state) = app.try_state::<BackupState>() else {
        return;
    };
    {
        let Ok(runtime) = state.inner.lock() else {
            return;
        };
        if runtime
            .last_attempt
            .is_some_and(|last| last.elapsed() < AUTO_BACKUP_INTERVAL)
        {
            return;
        }
    }

    let settings = match load_settings(app) {
        Ok(settings) => settings,
        Err(error) => {
            record_attempt(app, Some(error));
            return;
        }
    };
    if !settings.enabled {
        return;
    }
    let Some(folder) = settings.folder.as_deref().map(PathBuf::from) else {
        return;
    };
    if !folder_is_available(&folder) {
        // Do not consume the throttle window while the volume is away, so the
        // next save after it is mounted can take a snapshot right away.
        set_runtime_error(app, None);
        return;
    }

    let state_file = match crate::state_path(app) {
        Ok(path) => path,
        Err(error) => {
            record_attempt(app, Some(error));
            return;
        }
    };
    if !state_file.exists() {
        return;
    }

    record_attempt(app, None);
    match read_state_file(app).and_then(|state| write_backup(&folder, &state).map(|_| ())) {
        Ok(()) => {}
        Err(error) => record_attempt(app, Some(error)),
    }
}

#[tauri::command]
pub fn get_backup_status(app: AppHandle) -> Result<BackupStatus, String> {
    build_status(&app)
}

#[tauri::command]
pub fn backup_now(app: AppHandle, state: Value) -> Result<BackupStatus, String> {
    let settings = load_settings(&app)?;
    let folder = settings
        .folder
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| "Choose a backup folder first.".to_string())?;
    if !folder_is_available(&folder) {
        return Err("The backup folder is not available right now.".into());
    }

    match write_backup(&folder, &state) {
        Ok(_) => {
            record_attempt(&app, None);
            build_status(&app)
        }
        Err(error) => {
            record_attempt(&app, Some(error.clone()));
            Err(error)
        }
    }
}

#[tauri::command]
pub fn set_backup_enabled(app: AppHandle, enabled: bool) -> Result<BackupStatus, String> {
    let mut settings = load_settings(&app)?;
    settings.enabled = enabled;
    save_settings(&app, &settings)?;

    if enabled {
        if let Some(folder) = settings.folder.as_deref().map(PathBuf::from) {
            if folder_is_available(&folder) {
                if let Ok(state) = read_state_file(&app) {
                    match write_backup(&folder, &state) {
                        Ok(_) => record_attempt(&app, None),
                        Err(error) => record_attempt(&app, Some(error)),
                    }
                }
            }
        }
    }

    build_status(&app)
}

#[tauri::command]
pub async fn choose_backup_folder(app: AppHandle) -> Result<BackupStatus, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Choose a folder for ProjectTray backups")
        .blocking_pick_folder();

    let Some(file_path) = selected else {
        return build_status(&app);
    };
    let folder = file_path
        .into_path()
        .map_err(|e| format!("Could not use that folder: {e}"))?;

    ensure_marker(&folder)?;

    let mut settings = load_settings(&app)?;
    settings.enabled = true;
    settings.folder = Some(folder.to_string_lossy().into_owned());
    save_settings(&app, &settings)?;

    // Make the first snapshot immediately so the folder choice has visible
    // feedback. A missing state file simply means there is nothing to save yet.
    if let Ok(state) = read_state_file(&app) {
        match write_backup(&folder, &state) {
            Ok(_) => record_attempt(&app, None),
            Err(error) => record_attempt(&app, Some(error)),
        }
    }

    build_status(&app)
}

#[tauri::command]
pub async fn restore_backup(app: AppHandle) -> Result<Option<RestoreResult>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Choose a ProjectTray backup")
        .add_filter("ProjectTray backup", &["json"])
        .blocking_pick_file();

    let Some(file_path) = selected else {
        return Ok(None);
    };
    let backup_path = file_path
        .into_path()
        .map_err(|e| format!("Could not use that backup: {e}"))?;

    let data =
        fs::read_to_string(&backup_path).map_err(|e| format!("Could not read that backup: {e}"))?;
    let parsed: Value = serde_json::from_str(&data)
        .map_err(|e| format!("That file is not a valid ProjectTray backup: {e}"))?;
    let project_count = validate_backup_state(&parsed)?;

    let state_path = crate::state_path(&app)?;
    let safety_copy = apply_restore(&state_path, &parsed)?;

    Ok(Some(RestoreResult {
        restored_from: backup_path.display().to_string(),
        safety_copy: safety_copy.map(|path| path.display().to_string()),
        project_count,
        state: parsed,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEMP: AtomicUsize = AtomicUsize::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "projecttray-{name}-{}-{}",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn folder_requires_the_backup_marker() {
        let dir = TempDir::new("marker");
        assert!(!folder_is_available(&dir.0));

        ensure_marker(&dir.0).unwrap();
        assert!(folder_is_available(&dir.0));
        assert!(dir.0.join(BACKUP_MARKER).is_file());
    }

    #[test]
    fn backup_validation_requires_a_project_array() {
        assert_eq!(
            validate_backup_state(&serde_json::json!({ "projects": [] })).unwrap(),
            0
        );
        assert_eq!(
            validate_backup_state(&serde_json::json!({ "projects": [{}, {}] })).unwrap(),
            2
        );
        assert!(validate_backup_state(&serde_json::json!({})).is_err());
        assert!(validate_backup_state(&serde_json::json!({ "projects": {} })).is_err());
    }

    #[test]
    fn pruning_keeps_only_the_newest_backups() {
        let dir = TempDir::new("prune");
        ensure_marker(&dir.0).unwrap();

        for index in 0..35 {
            let path = dir.0.join(format!("{BACKUP_PREFIX}{index:02}.json"));
            fs::write(&path, "{}").unwrap();
            std::thread::sleep(Duration::from_millis(2));
        }
        fs::write(dir.0.join("keep-me.json"), "{}").unwrap();

        prune_backups(&dir.0).unwrap();

        let files = backup_files(&dir.0);
        assert_eq!(files.len(), BACKUP_RETENTION);
        assert!(!files
            .iter()
            .any(|path| path.ends_with(format!("{BACKUP_PREFIX}00.json"))));
        assert!(dir.0.join("keep-me.json").is_file());
    }

    #[test]
    fn restore_replaces_state_and_keeps_a_safety_copy() {
        let dir = TempDir::new("restore");
        let state_path = dir.0.join("projecttray.json");
        let old_state = serde_json::json!({ "projects": [{ "title": "Old" }] });
        fs::write(&state_path, serde_json::to_vec_pretty(&old_state).unwrap()).unwrap();

        let restored = serde_json::json!({ "projects": [{ "title": "New" }] });
        let safety = apply_restore(&state_path, &restored).unwrap().unwrap();

        assert_eq!(safety, dir.0.join(SAFETY_COPY));
        let safety_data: Value =
            serde_json::from_str(&fs::read_to_string(&safety).unwrap()).unwrap();
        assert_eq!(safety_data, old_state);

        let state_data: Value =
            serde_json::from_str(&fs::read_to_string(&state_path).unwrap()).unwrap();
        assert_eq!(state_data, restored);
    }
}
