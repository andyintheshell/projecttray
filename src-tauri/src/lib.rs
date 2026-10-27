use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Monitor, WebviewWindow,
};

#[tauri::command]
fn load_state(app: AppHandle) -> Result<Option<Value>, String> {
    let path = state_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("Could not read state: {e}"))?;
    serde_json::from_str(&data)
        .map(Some)
        .map_err(|e| format!("Could not parse state: {e}"))
}

#[tauri::command]
fn save_state(app: AppHandle, state: Value) -> Result<(), String> {
    let path = state_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Could not create data folder: {e}"))?;
    }
    let serialized =
        serde_json::to_string_pretty(&state).map_err(|e| format!("Could not encode state: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serialized).map_err(|e| format!("Could not write state: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("Could not replace state: {e}"))?;
    Ok(())
}

#[tauri::command]
fn hide_overlay(window: WebviewWindow) -> Result<(), String> {
    hide_overlay_window(window.app_handle());
    Ok(())
}

#[tauri::command]
fn set_theme(window: WebviewWindow, theme: String) -> Result<(), String> {
    let theme = if theme == "light" {
        tauri::Theme::Light
    } else {
        tauri::Theme::Dark
    };
    window.set_theme(Some(theme)).map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    apply_overlay_effects(&window);

    Ok(())
}

fn hide_overlay_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSApplication;

        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm).hide(None);
        }
    }
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not find app data folder: {e}"))?;
    Ok(dir.join("projecttray.json"))
}

fn monitor_for_cursor(app: &AppHandle, window: &WebviewWindow) -> Option<Monitor> {
    app.cursor_position()
        .ok()
        .and_then(|position| {
            window
                .monitor_from_point(position.x, position.y)
                .ok()
                .flatten()
        })
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten())
}

fn fit_to_screen(app: &AppHandle, window: &WebviewWindow) {
    let Some(monitor) = monitor_for_cursor(app, window) else {
        return;
    };

    let _ = window.set_size(tauri::Size::Physical(*monitor.size()));
    let _ = window.set_position(tauri::Position::Physical(*monitor.position()));
}

fn show_overlay(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    fit_to_screen(app, &window);
    let _ = window.show();

    #[cfg(target_os = "macos")]
    configure_overlay(&window);

    let _ = window.set_focus();

    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::NSObjectProtocol;
        use objc2::{sel, MainThreadMarker};
        use objc2_app_kit::{NSApplication, NSWindow};

        if let Ok(pointer) = window.ns_window() {
            unsafe {
                let ns_window = &*(pointer as *mut NSWindow);
                if let Some(mtm) = MainThreadMarker::new() {
                    let application = NSApplication::sharedApplication(mtm);
                    application.unhide(None);
                    if application.respondsToSelector(sel!(activate)) {
                        application.activate();
                    } else {
                        #[allow(deprecated)]
                        application.activateIgnoringOtherApps(true);
                    }
                }
                ns_window.makeKeyAndOrderFront(None);
            }
        }
    }

    let _ = app.emit("overlay-shown", ());
}

fn toggle_overlay(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    if window.is_visible().unwrap_or(false) {
        hide_overlay_window(app);
    } else {
        show_overlay(app);
    }
}

#[cfg(target_os = "macos")]
fn apply_overlay_effects(window: &WebviewWindow) {
    use tauri::window::{Effect, EffectState, EffectsBuilder};

    let effects = EffectsBuilder::new()
        .effect(Effect::UnderWindowBackground)
        .state(EffectState::Active)
        .build();
    let _ = window.set_effects(effects);
}

#[cfg(target_os = "macos")]
fn configure_overlay(window: &WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior, NSWindowLevel};

    // Dock windows use level 20 and the menu bar uses 24. Sitting just above
    // the Dock keeps it behind the overlay while leaving the tray icon
    // clickable. Fullscreen app windows sit at the normal level (0).
    const OVERLAY_LEVEL: NSWindowLevel = 21;

    if let Ok(pointer) = window.ns_window() {
        unsafe {
            let ns_window = &*(pointer as *mut NSWindow);
            ns_window.setLevel(OVERLAY_LEVEL);
            let behavior = ns_window.collectionBehavior()
                | NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::IgnoresCycle;
            ns_window.setCollectionBehavior(behavior);
            ns_window.setHidesOnDeactivate(false);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_state,
            save_state,
            hide_overlay,
            set_theme
        ])
        .setup(|app| {
            // The activation policy must be set before the window is created so
            // macOS lets the overlay join fullscreen Spaces.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("ProjectTray")
            .inner_size(1280.0, 860.0)
            .min_inner_size(900.0, 640.0)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .focused(true)
            // Tauri's native drag/drop handler consumes DOM drag events on
            // macOS. The UI reorders tasks with pointer events and does not
            // listen for file drops, so let the webview own drag input.
            .disable_drag_drop_handler()
            .build()?;

            let show_item = MenuItem::with_id(app, "show", "Open ProjectTray", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit ProjectTray", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let tray_icon =
                tauri::image::Image::from_bytes(include_bytes!("../icons/trayTemplate.png"))?;

            let _tray = TrayIconBuilder::with_id("projecttray")
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("ProjectTray")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_overlay(app),
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
                        toggle_overlay(tray.app_handle());
                    }
                })
                .build(app)?;

            #[cfg(target_os = "macos")]
            {
                configure_overlay(&window);
                apply_overlay_effects(&window);
            }
            fit_to_screen(app.handle(), &window);

            let first_run = state_path(app.handle())
                .map(|path| !path.exists())
                .unwrap_or(false);

            if first_run {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(650));
                    let main_handle = handle.clone();
                    let _ = handle.run_on_main_thread(move || show_overlay(&main_handle));
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running ProjectTray");
}
