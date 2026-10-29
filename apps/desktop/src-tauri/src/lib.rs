//! MindfulTech Slack desktop: one native window around the production site.
//! There is no second frontend; everything the app shows comes from
//! `https://slack.mindfultech.ec` (see `tauri.conf.json`).

use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
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

// --- AI Skills (Phase 44): one-click install into ~/.claude/skills -------------

/// One file of a skill, by its path inside the skill's folder.
#[derive(Debug, Deserialize)]
struct SkillFile {
    path: String,
    content: String,
}

/// Claude Code's limit for a skill's name, and what the catalog allows.
const MAX_SLUG: usize = 64;
const MAX_FILES: usize = 51;
const MAX_TOTAL_BYTES: usize = 2_000_000;

/// Lowercase letters, numbers and single hyphens: the skill's folder name.
fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= MAX_SLUG
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && !slug.contains("--")
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `path` as a relative path inside the skill's folder, or `None` for anything
/// that could land elsewhere: absolute paths, `..`, backslashes, drive
/// prefixes, hidden or empty parts.
fn safe_relative_path(path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.len() > 200 || path.contains('\\') || path.contains(':') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in path.split('/') {
        if part.is_empty() || part.starts_with('.') || part.len() > 100 {
            return None;
        }
        let ok = part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
        if !ok {
            return None;
        }
        out.push(part);
    }
    // Belt and braces: only plain names made it through.
    out.components()
        .all(|c| matches!(c, Component::Normal(_)))
        .then_some(out)
}

/// Writes the skill's folder at `skills/<slug>`: into a fresh temporary folder
/// first, then swapped in, so a failure never leaves half a skill (or an old
/// one gone). Returns where it went.
fn write_skill(skills: &Path, slug: &str, files: &[SkillFile]) -> Result<PathBuf, String> {
    if !valid_slug(slug) {
        return Err(format!("not a skill name: {slug}"));
    }
    if files.is_empty() || files.len() > MAX_FILES {
        return Err("a skill has SKILL.md and at most 50 other files".into());
    }
    if !files.iter().any(|f| f.path == "SKILL.md") {
        return Err("the skill has no SKILL.md".into());
    }
    let total: usize = files.iter().map(|f| f.content.len()).sum();
    if total > MAX_TOTAL_BYTES {
        return Err("the skill is too large".into());
    }
    let mut planned = Vec::with_capacity(files.len());
    for file in files {
        let rel = safe_relative_path(&file.path)
            .ok_or_else(|| format!("not a safe file path: {}", file.path))?;
        planned.push((rel, file.content.as_bytes()));
    }

    let io = |what: &str, err: std::io::Error| format!("{what}: {err}");
    std::fs::create_dir_all(skills).map_err(|e| io("creating ~/.claude/skills", e))?;
    let target = skills.join(slug);
    let staging = skills.join(format!(".{slug}.installing-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    let written = (|| -> Result<(), String> {
        for (rel, bytes) in &planned {
            let path = staging.join(rel);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| io("creating a folder", e))?;
            }
            std::fs::write(&path, bytes).map_err(|e| io("writing a file", e))?;
        }
        Ok(())
    })();
    if let Err(err) = written {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(err);
    }
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|e| io("replacing the old version", e))?;
    }
    std::fs::rename(&staging, &target).map_err(|e| io("moving the skill into place", e))?;
    Ok(target)
}

/// `install_skill` (Phase 44): the AI Skills view's one-click install. Writes
/// the skill into `~/.claude/skills/<slug>/`, where Claude Code loads it for
/// every project (Windows: `%USERPROFILE%\.claude\skills`).
#[tauri::command]
fn install_skill<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    slug: String,
    files: Vec<SkillFile>,
) -> Result<String, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let target = write_skill(&home.join(".claude").join("skills"), &slug, &files)?;
    Ok(target.display().to_string())
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
        .invoke_handler(tauri::generate_handler![install_skill])
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
    fn skill_names_are_folder_names_claude_code_accepts() {
        assert!(valid_slug("security-audit"));
        assert!(valid_slug("a1"));
        for bad in [
            "",
            "Security",
            "a--b",
            "-a",
            "a-",
            "a/b",
            "..",
            "a b",
            &"a".repeat(65),
        ] {
            assert!(!valid_slug(bad), "{bad}");
        }
    }

    #[test]
    fn skill_files_stay_inside_the_skill_folder() {
        assert_eq!(
            safe_relative_path("scripts/check.sh"),
            Some(PathBuf::from("scripts").join("check.sh"))
        );
        assert_eq!(
            safe_relative_path("SKILL.md"),
            Some(PathBuf::from("SKILL.md"))
        );
        for bad in [
            "",
            "../x",
            "a/../../x",
            "/etc/passwd",
            "C:/Windows/x",
            "a\\b",
            ".git/config",
            "a//b",
            "a/./b",
            "a b.md",
        ] {
            assert_eq!(safe_relative_path(bad), None, "{bad}");
        }
    }

    fn file(path: &str, content: &str) -> SkillFile {
        SkillFile {
            path: path.into(),
            content: content.into(),
        }
    }

    #[test]
    fn installs_a_skill_and_replaces_an_older_one() {
        let home = std::env::temp_dir().join(format!("skills-test-{}", std::process::id()));
        let skills = home.join(".claude").join("skills");
        let _ = std::fs::remove_dir_all(&home);

        let target = write_skill(
            &skills,
            "cdk-iam",
            &[
                file("SKILL.md", "---\nname: cdk-iam\n---\n"),
                file("scripts/scan.sh", "echo scan"),
                file("old.md", "old"),
            ],
        )
        .unwrap();
        assert_eq!(target, skills.join("cdk-iam"));
        assert_eq!(
            std::fs::read_to_string(target.join("scripts").join("scan.sh")).unwrap(),
            "echo scan"
        );

        // A new version replaces the folder: files it no longer has are gone.
        write_skill(&skills, "cdk-iam", &[file("SKILL.md", "v2")]).unwrap();
        assert_eq!(
            std::fs::read_to_string(target.join("SKILL.md")).unwrap(),
            "v2"
        );
        assert!(!target.join("old.md").exists());
        assert!(!target.join("scripts").exists());

        // Refused before anything is written: the old version stays.
        assert!(write_skill(
            &skills,
            "cdk-iam",
            &[file("SKILL.md", "x"), file("../evil", "x")]
        )
        .is_err());
        assert!(write_skill(&skills, "../x", &[file("SKILL.md", "x")]).is_err());
        assert!(write_skill(&skills, "no-skill-md", &[file("README.md", "x")]).is_err());
        assert_eq!(
            std::fs::read_to_string(target.join("SKILL.md")).unwrap(),
            "v2"
        );
        assert!(!home.join("evil").exists());
        // No staging folder left behind.
        let leftovers: Vec<_> = std::fs::read_dir(&skills)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        assert_eq!(leftovers, vec![std::ffi::OsString::from("cdk-iam")]);

        std::fs::remove_dir_all(&home).unwrap();
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
