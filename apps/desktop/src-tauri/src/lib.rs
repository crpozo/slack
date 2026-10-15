//! MindfulTech Slack desktop: one native window around the production site.
//! There is no second frontend; everything the app shows comes from
//! `https://slack.mindfultech.ec` (see `tauri.conf.json`).

use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::{Manager, Url, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// The window's label in `tauri.conf.json`.
const MAIN: &str = "main";

/// Links that leave the app (S3 downloads, URLs in messages) open in the
/// default browser instead of replacing the chat inside the window.
fn is_external(url: &Url, app_url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && url.host_str() != app_url.host_str()
}

fn open_in_browser<R: tauri::Runtime>(app: &tauri::AppHandle<R>, url: &Url) {
    if let Err(err) = app.opener().open_url(url.as_str(), None::<&str>) {
        eprintln!("couldn't open {url}: {err}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First: a second launch focuses the running window instead of opening another.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window(MAIN) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            // The window is declared in tauri.conf.json with `create: false` and
            // built here, so the navigation handlers can be attached to it.
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == MAIN)
                .expect("tauri.conf.json declares the main window")
                .clone();
            let app_url = match &config.url {
                tauri::WebviewUrl::External(url) => url.clone(),
                other => panic!("the main window must load an external URL, got {other:?}"),
            };

            let nav_handle = app.handle().clone();
            let nav_app_url = app_url.clone();
            let popup_handle = app.handle().clone();
            let permission_app_url = app_url.clone();
            WebviewWindowBuilder::from_config(app.handle(), &config)?
                .on_navigation(move |url| {
                    if is_external(url, &nav_app_url) {
                        open_in_browser(&nav_handle, url);
                        return false;
                    }
                    true
                })
                // `window.open` / `target="_blank"`: never a second app window.
                // Web pages fall back to navigating, which on_navigation routes above.
                .on_new_window(move |url, _features| {
                    if matches!(url.scheme(), "http" | "https") {
                        open_in_browser(&popup_handle, &url);
                    }
                    NewWindowResponse::Deny
                })
                // getUserMedia for voice messages and calls, and web notifications,
                // without a second prompt inside the window (the OS still asks once).
                // Only the production site gets them.
                .on_permission_request(move |webview, kind| {
                    let ours = webview
                        .url()
                        .is_ok_and(|url| url.host_str() == permission_app_url.host_str());
                    match kind {
                        PermissionKind::Microphone
                        | PermissionKind::Camera
                        | PermissionKind::Notifications
                            if ours =>
                        {
                            PermissionResponse::Allow
                        }
                        _ => PermissionResponse::Default,
                    }
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the MindfulTech Slack desktop app");
}
