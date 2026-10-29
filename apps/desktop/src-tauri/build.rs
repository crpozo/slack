fn main() {
    // App commands get permissions (`allow-<command>`) that the capabilities
    // grant explicitly: the site is a remote URL, so nothing is implied.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["install_skill"])),
    )
    .expect("failed to run tauri-build");
}
