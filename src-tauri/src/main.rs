#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod offline;

use std::{sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, webview::{NewWindowResponse, PageLoadEvent}};
use tauri_plugin_updater::{Update, UpdaterExt};

const SITE_URL: &str = "https://yamusic.pigboss.xyz/";
const RELEASE_URL: &str = "https://github.com/L1nuxc/YaMusic/releases/latest/download/latest.json";

#[derive(Default)]
struct Desktop {
    online: std::sync::atomic::AtomicBool,
    update: Mutex<Option<(Update, Vec<u8>)>>,
}

fn trusted_site(url: &tauri::Url) -> bool {
    url.scheme()=="https" && url.host_str()==Some("yamusic.pigboss.xyz") && url.port_or_known_default()==Some(443)
}

fn local_page(url: &tauri::Url) -> bool {
    matches!((url.scheme(),url.host_str(),url.port()),("http",Some("tauri.localhost"),None) | ("tauri",Some("localhost"),None)) &&
        matches!(url.path(),"/" | "/index.html")
}

fn trusted_navigation(url: &tauri::Url) -> bool {
    local_page(url) || (url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && matches!(
            url.host_str(),
            Some("yamusic.pigboss.xyz" | "accounts.spotify.com" | "oauth.telegram.org" | "telegram.org")
        ))
}

fn notify_update(window: &WebviewWindow, version: &str) {
    if !window.url().is_ok_and(|url|trusted_site(&url)){return;}
    let version=serde_json::to_string(version).unwrap_or_default();
    let _=window.eval(format!("window.__YAMUSIC_UPDATE__={version};window.dispatchEvent(new Event('yamusic-update'));"));
}

#[tauri::command]
fn desktop_ready(window: WebviewWindow, state: State<Desktop>) {
    if window.url().is_ok_and(|url|trusted_site(&url)) {
        state.online.store(true,std::sync::atomic::Ordering::Relaxed);
        if let Ok(update)=state.update.lock(){
            if let Some((update,_))=&*update { notify_update(&window,&update.version); }
        }
    }
}

fn navigate_offline(window: &WebviewWindow) -> Result<(), String> {
    window.navigate("http://tauri.localhost/index.html#/downloads".parse::<tauri::Url>().map_err(|e|e.to_string())?)
        .map_err(|e|e.to_string())
}

#[tauri::command]
fn open_offline(window: WebviewWindow) -> Result<(), String> { navigate_offline(&window) }

#[tauri::command]
fn install_update(state: State<Desktop>) -> Result<(), String> {
    let mut ready=state.update.lock().map_err(|e|e.to_string())?;
    let (update, bytes)=ready.as_ref().ok_or("Обновление ещё не скачано.")?;
    update.install(bytes).map_err(|e|e.to_string())?;
    ready.take();
    Ok(())
}

async fn download_update(app: AppHandle) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let Some(key)=option_env!("YAMUSIC_UPDATE_PUBLIC_KEY").filter(|key|!key.trim().is_empty()) else { return Ok(()); };
    let updater=app.updater_builder().endpoints(vec![RELEASE_URL.parse()?])?
        .pubkey(key.trim()).timeout(Duration::from_secs(90)).build()?;
    if let Some(update)=updater.check().await? {
        let bytes=update.download(|_,_|{},||{}).await?;
        let version=update.version.clone();
        if let Ok(mut state)=app.state::<Desktop>().update.lock(){*state=Some((update,bytes));}
        if let Some(window)=app.get_webview_window("main"){notify_update(&window,&version);}
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(Desktop::default())
        .manage(offline::Offline::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            desktop_ready, open_offline, install_update,
            offline::offline_list, offline::offline_folder, offline::offline_choose_folder,
            offline::offline_begin, offline::offline_write, offline::offline_finish,
            offline::offline_cancel, offline::offline_remove,
            offline::offline_account, offline::offline_set_account,
            offline::offline_playlists, offline::offline_save_playlist,
        ])
        .setup(|app| {
            let window=WebviewWindowBuilder::new(app, "main", WebviewUrl::External(SITE_URL.parse()?))
                .title("YaMusic")
                .inner_size(1200.0, 800.0)
                .min_inner_size(390.0, 550.0)
                .center()
                .initialization_script("window.__YAMUSIC_WINDOWS__=true;")
                .on_navigation(trusted_navigation)
                .on_page_load(|window,payload|{
                    if payload.event()==PageLoadEvent::Finished && trusted_site(payload.url()){
                        let _=window.eval("window.__TAURI_INTERNALS__.invoke('desktop_ready').catch(()=>{});");
                    }
                })
                .on_new_window(|url, _| {
                    if trusted_navigation(&url) {
                        NewWindowResponse::Allow
                    } else {
                        NewWindowResponse::Deny
                    }
                })
                .build()?;
            let handle=app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error)=download_update(handle).await { eprintln!("Update unavailable: {error}"); }
            });
            let handle=app.handle().clone();
            std::thread::spawn(move||{
                std::thread::sleep(Duration::from_secs(8));
                if !handle.state::<Desktop>().online.load(std::sync::atomic::Ordering::Relaxed) {
                    let _=navigate_offline(&window);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Unable to start YaMusic");
}
