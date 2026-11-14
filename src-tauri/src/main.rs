#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{WebviewUrl, WebviewWindowBuilder, webview::NewWindowResponse};

const SITE_URL: &str = "https://yamusic.pigboss.xyz/";

fn trusted_navigation(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && matches!(
            url.host_str(),
            Some("yamusic.pigboss.xyz" | "accounts.spotify.com" | "oauth.telegram.org" | "telegram.org")
        )
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(SITE_URL.parse()?))
                .title("YaMusic")
                .inner_size(1200.0, 800.0)
                .min_inner_size(390.0, 550.0)
                .center()
                .on_navigation(trusted_navigation)
                .on_new_window(|url, _| {
                    if trusted_navigation(&url) {
                        NewWindowResponse::Allow
                    } else {
                        NewWindowResponse::Deny
                    }
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Unable to start YaMusic");
}
