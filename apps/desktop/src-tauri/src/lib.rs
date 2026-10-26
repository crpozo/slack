//! MindfulTech Slack desktop: one native window around the production site.
//! There is no second frontend; everything the app shows comes from
//! `https://slack.mindfultech.ec` (see `tauri.conf.json`).

use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::window::{Color, Effect, EffectState, EffectsBuilder};
use tauri::{Manager, Theme, Url, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// The window's label in `tauri.conf.json`.
const MAIN: &str = "main";

/// Links that leave the app (S3 downloads, URLs in messages) open in the
/// default browser instead of replacing the chat inside the window.
fn is_external(url: &Url, app_url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && url.host_str() != app_url.host_str()
}

/// The inline YouTube player of a message (Phase 33): a click-to-play
/// `<iframe>` on youtube-nocookie.com's embed page. WebKit (macOS, Linux)
/// asks `on_navigation` about frame loads too, not only the window's own, so
/// without this the player would open in the browser instead of playing in
/// the message. Only that exact page: anything else still leaves the app.
fn is_inline_player(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("www.youtube-nocookie.com")
        && url.path().starts_with("/embed/")
}

/// Native glass (Phase 37b): the window is transparent and the OS blurs and
/// darkens the desktop behind it, under the site's translucent sidebar and
/// headers. CSS can't do this itself (`backdrop-filter` only sees the page), so
/// it's only on where the OS does it well:
/// - macOS: vibrancy (the material Finder's and Mail's sidebars use);
/// - Windows 11: Mica.
///
/// Windows 10 (Acrylic lags when the window is dragged or resized) and Linux
/// (no blur) keep an opaque window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Glass {
    Vibrancy,
    Mica,
}

/// The first Windows 11 build: Mica exists from here on.
const WINDOWS_11_BUILD: u32 = 22000;

/// The page's ambient colour (#1A1D21), painted while it loads when there's no glass.
const BACKGROUND: Color = Color(26, 29, 33, 255);

/// Which glass the window gets on `os` (`std::env::consts::OS`).
fn glass_for(os: &str, windows_build: Option<u32>) -> Option<Glass> {
    match os {
        "macos" => Some(Glass::Vibrancy),
        "windows" if windows_build.is_some_and(|build| build >= WINDOWS_11_BUILD) => {
            Some(Glass::Mica)
        }
        _ => None,
    }
}

#[cfg(windows)]
fn windows_build() -> Option<u32> {
    Some(windows_version::OsVersion::current().build)
}

#[cfg(not(windows))]
fn windows_build() -> Option<u32> {
    None
}

/// Runs before the site's own scripts on every load of the main window. The
/// site makes its page transparent only when this says the OS blur is on
/// (`apps/web/src/lib/theme.ts`), so an opaque window (an older app, Windows
/// 10, Linux) never shows a see-through page.
fn glass_script(glass: Option<Glass>) -> String {
    let value = match glass {
        Some(Glass::Vibrancy) => "\"vibrancy\"",
        Some(Glass::Mica) => "\"mica\"",
        None => "null",
    };
    format!("window.__MINDFULTECH_GLASS__ = {value};")
}

fn effects_for(glass: Glass) -> tauri::utils::config::WindowEffectsConfig {
    let effect = match glass {
        // Kept dark by the window's dark theme, whatever the system's appearance.
        Glass::Vibrancy => Effect::UnderWindowBackground,
        Glass::Mica => Effect::MicaDark,
    };
    EffectsBuilder::new()
        .effect(effect)
        .state(EffectState::FollowsWindowActiveState)
        .build()
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

            let glass = glass_for(std::env::consts::OS, windows_build());

            let nav_handle = app.handle().clone();
            let nav_app_url = app_url.clone();
            let popup_handle = app.handle().clone();
            let permission_app_url = app_url.clone();
            let mut builder = WebviewWindowBuilder::from_config(app.handle(), &config)?
                // Dark title bar and dark vibrancy/Mica, even in the system's light mode:
                // the site is dark only.
                .theme(Some(Theme::Dark))
                // tauri.conf.json asks for a transparent window; only glass needs one.
                .transparent(glass.is_some())
                .initialization_script(glass_script(glass));
            builder = match glass {
                Some(glass) => builder.effects(effects_for(glass)),
                // No white flash before the page paints.
                None => builder.background_color(BACKGROUND),
            };
            builder
                .on_navigation(move |url| {
                    if is_inline_player(url) {
                        return true;
                    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn links_to_other_sites_leave_the_app() {
        let app = url("https://slack.mindfultech.ec/app/general");
        assert!(is_external(
            &url("https://youtube.com/watch?v=dQw4w9WgXcQ"),
            &app
        ));
        assert!(is_external(
            &url("https://bucket.s3.amazonaws.com/x.pdf"),
            &app
        ));
        assert!(!is_external(
            &url("https://slack.mindfultech.ec/app/tasks"),
            &app
        ));
        assert!(!is_external(&url("mailto:a@b.ec"), &app));
    }

    #[test]
    fn glass_only_where_the_os_blurs_well() {
        assert_eq!(glass_for("macos", None), Some(Glass::Vibrancy));
        assert_eq!(glass_for("windows", Some(22000)), Some(Glass::Mica));
        assert_eq!(glass_for("windows", Some(26100)), Some(Glass::Mica));
        assert_eq!(glass_for("windows", Some(19045)), None); // Windows 10
        assert_eq!(glass_for("windows", None), None);
        assert_eq!(glass_for("linux", None), None);
    }

    #[test]
    fn the_site_is_told_which_glass() {
        assert_eq!(
            glass_script(Some(Glass::Vibrancy)),
            r#"window.__MINDFULTECH_GLASS__ = "vibrancy";"#
        );
        assert_eq!(
            glass_script(Some(Glass::Mica)),
            r#"window.__MINDFULTECH_GLASS__ = "mica";"#
        );
        assert_eq!(glass_script(None), "window.__MINDFULTECH_GLASS__ = null;");
    }

    #[test]
    fn only_the_youtube_embed_page_plays_inside() {
        assert!(is_inline_player(&url(
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&start=42"
        )));
        assert!(!is_inline_player(&url(
            "http://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"
        )));
        assert!(!is_inline_player(&url(
            "https://www.youtube-nocookie.com/watch?v=dQw4w9WgXcQ"
        )));
        assert!(!is_inline_player(&url(
            "https://www.youtube.com/embed/dQw4w9WgXcQ"
        )));
        assert!(!is_inline_player(&url(
            "https://www.youtube-nocookie.com.evil.example/embed/dQw4w9WgXcQ"
        )));
    }
}
