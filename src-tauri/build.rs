fn main() {
    println!("cargo:rerun-if-env-changed=YAMUSIC_UPDATE_PUBLIC_KEY");
    const COMMANDS: &[&str] = &[
        "offline_list", "offline_folder", "offline_choose_folder", "offline_begin",
        "offline_write", "offline_finish", "offline_cancel", "offline_remove",
        "desktop_ready", "open_offline", "install_update", "offline_set_account", "offline_account",
        "offline_playlists", "offline_save_playlist",
    ];
    tauri_build::try_build(tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("Windows permissions could not be compiled");
}
