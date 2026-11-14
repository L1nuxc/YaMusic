use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, fs, io::Write, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

type Result<T> = std::result::Result<T, String>;
fn io_error(error: impl std::fmt::Display) -> String { format!("Не удалось сохранить загрузку: {error}") }

#[derive(Serialize, Deserialize)]
pub struct Download {
    track: Value,
    path: PathBuf,
    lyrics: Option<Value>,
    artwork: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Index {
    folder: Option<PathBuf>,
    tracks: HashMap<String, Download>,
    #[serde(default)]
    playlists: HashMap<String, DownloadedPlaylist>,
}

#[derive(Serialize, Deserialize)]
pub struct DownloadedPlaylist { title: String, tracks: Vec<String> }

#[derive(Default)]
pub struct Offline(pub(crate) Mutex<HashMap<(u64, String), Pending>>);

pub(crate) struct Pending {
    file: Option<fs::File>,
    temp: PathBuf,
    final_path: PathBuf,
    bytes: u64,
}

impl Drop for Pending {
    fn drop(&mut self) { self.file.take();let _ = fs::remove_file(&self.temp); }
}

#[tauri::command]
pub fn offline_set_account(app: AppHandle, account: Option<u64>) -> Result<()> {
    let path=index_path(&app,0)?.with_file_name("active-account");
    fs::write(path,account.map(|id|id.to_string()).unwrap_or_default()).map_err(io_error)
}

#[tauri::command]
pub fn offline_account(app: AppHandle) -> Result<Option<u64>> {
    let path=index_path(&app,0)?.with_file_name("active-account");
    Ok(fs::read_to_string(path).ok().and_then(|id|id.parse().ok()))
}

fn index_path(app: &AppHandle, account: u64) -> Result<PathBuf> {
    let folder = app.path().app_local_data_dir().map_err(io_error)?.join("offline-index");
    fs::create_dir_all(&folder).map_err(io_error)?;
    Ok(folder.join(format!("{account}.json")))
}

fn read_index(app: &AppHandle, account: u64) -> Result<Index> {
    match fs::read(index_path(app, account)?) {
        Ok(raw) => serde_json::from_slice(&raw).map_err(io_error),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Index::default()),
        Err(error) => Err(io_error(error)),
    }
}

fn save_index(app: &AppHandle, account: u64, index: &Index) -> Result<()> {
    let path = index_path(app, account)?;
    let temp = path.with_extension("tmp");
    fs::write(&temp, serde_json::to_vec(index).map_err(io_error)?).map_err(io_error)?;
    fs::rename(temp, path).map_err(io_error)
}

fn folder(app: &AppHandle, index: &Index) -> Result<PathBuf> {
    if let Some(folder) = &index.folder { return Ok(folder.clone()); }
    Ok(app.path().app_local_data_dir().map_err(io_error)?.join("Загрузки YaMusic"))
}

fn validate_id(track: &str) -> Result<()> {
    if track.strip_prefix("deezer_").is_some_and(|id| id.len()<=19 && id.parse::<u64>().is_ok() && id.bytes().all(|b|b.is_ascii_digit())) {
        Ok(())
    } else { Err("Неизвестный трек.".into()) }
}

#[tauri::command]
pub fn offline_list(app: AppHandle, state: State<Offline>, account: u64) -> Result<HashMap<String, Download>> {
    let _guard = state.0.lock().map_err(io_error)?;
    let mut index = read_index(&app, account)?;
    index.tracks.retain(|_, track| track.path.is_file());
    for download in index.tracks.values() {
        app.asset_protocol_scope().allow_file(&download.path).map_err(io_error)?;
    }
    Ok(index.tracks)
}

#[tauri::command]
pub fn offline_playlists(app: AppHandle, state: State<Offline>, account: u64) -> Result<HashMap<String, DownloadedPlaylist>> {
    let _guard=state.0.lock().map_err(io_error)?;
    Ok(read_index(&app,account)?.playlists)
}

#[tauri::command]
pub fn offline_save_playlist(
    app: AppHandle, state: State<Offline>, account: u64, id: String, mut playlist: DownloadedPlaylist
) -> Result<()> {
    let _guard=state.0.lock().map_err(io_error)?;
    if id.len()>90 || playlist.title.chars().count()>256 || playlist.tracks.len()>5000 { return Err("Некорректный плейлист.".into()); }
    let mut index=read_index(&app,account)?;
    playlist.tracks.retain(|track|index.tracks.contains_key(track));
    if !playlist.tracks.is_empty() { index.playlists.insert(id,playlist); save_index(&app,account,&index)?; }
    Ok(())
}

#[tauri::command]
pub fn offline_folder(app: AppHandle, state: State<Offline>, account: u64) -> Result<PathBuf> {
    let _guard = state.0.lock().map_err(io_error)?;
    folder(&app, &read_index(&app, account)?)
}

#[tauri::command]
pub async fn offline_choose_folder(app: AppHandle, window: WebviewWindow, account: u64) -> Result<Option<PathBuf>> {
    let Some(selected) = app.dialog().file().set_parent(&window).set_title("Папка для музыки").blocking_pick_folder() else { return Ok(None); };
    let selected = selected.into_path().map_err(io_error)?;
    let state = app.state::<Offline>();
    let _guard = state.0.lock().map_err(io_error)?;
    let mut index = read_index(&app, account)?;
    index.folder = Some(selected.clone());
    save_index(&app, account, &index)?;
    Ok(Some(selected))
}

#[tauri::command]
pub fn offline_begin(app: AppHandle, state: State<Offline>, account: u64, track: String, mime: String) -> Result<()> {
    validate_id(&track)?;
    let extension = match mime.split(';').next().unwrap_or_default() {
        "audio/mpeg" => "mp3", "audio/mp4" => "m4a", "audio/webm" => "webm",
        "audio/ogg" => "ogg", "audio/aac" => "aac", _ => return Err("Неподдерживаемый формат аудио.".into()),
    };
    let mut pending = state.0.lock().map_err(io_error)?;
    if pending.contains_key(&(account,track.clone())) { return Err("Трек уже скачивается.".into()); }
    let dir = folder(&app, &read_index(&app, account)?)?.join(format!("YaMusic-{account}"));
    fs::create_dir_all(&dir).map_err(io_error)?;
    let final_path = dir.join(format!("{track}.{extension}"));
    let temp = dir.join(format!("{track}.part"));
    let file = fs::File::create(&temp).map_err(io_error)?;
    pending.insert((account,track), Pending{file:Some(file),temp,final_path,bytes:0});
    Ok(())
}

#[tauri::command]
pub fn offline_write(state: State<Offline>, account: u64, track: String, chunk: String) -> Result<()> {
    if chunk.len() > 400_000 { return Err("Слишком большой блок загрузки.".into()); }
    let mut pending=state.0.lock().map_err(io_error)?;
    let file=pending.get_mut(&(account,track)).ok_or("Загрузка не начата.")?;
    let bytes=STANDARD.decode(chunk).map_err(io_error)?;
    if file.bytes+bytes.len() as u64>128*1024*1024 { return Err("Трек превышает лимит загрузки.".into()); }
    file.file.as_mut().ok_or("Загрузка завершена.")?.write_all(&bytes).map_err(io_error)?;
    file.bytes+=bytes.len() as u64;
    Ok(())
}

#[tauri::command]
pub fn offline_finish(app: AppHandle, state: State<Offline>, account: u64, track: Value, lyrics: Option<Value>, artwork: Option<String>, size: Option<u64>) -> Result<()> {
    let id=track["id"].as_str().ok_or("Неизвестный трек.")?.to_owned();
    let mut pending=state.0.lock().map_err(io_error)?;
    let mut file=pending.remove(&(account,id.clone())).ok_or("Загрузка не начата.")?;
    if file.bytes==0 || size.is_some_and(|size| size!=file.bytes) { return Err("Трек скачался не полностью.".into()); }
    if let Some(mut handle)=file.file.take(){handle.flush().map_err(io_error)?;}
    fs::rename(&file.temp,&file.final_path).map_err(io_error)?;
    app.asset_protocol_scope().allow_file(&file.final_path).map_err(io_error)?;
    let mut index=read_index(&app,account)?;
    let artwork=artwork.filter(|data|data.len()<680_000 && ["data:image/jpeg;base64,","data:image/png;base64,","data:image/webp;base64,"].iter().any(|prefix|data.starts_with(prefix)));
    let old=index.tracks.insert(id,Download{track,path:file.final_path.clone(),lyrics,artwork});
    save_index(&app,account,&index)?;
    if let Some(old)=old.filter(|old|old.path!=file.final_path) { let _=fs::remove_file(old.path); }
    Ok(())
}

#[tauri::command]
pub fn offline_cancel(state: State<Offline>, account: u64, track: String) -> Result<()> {
    state.0.lock().map_err(io_error)?.remove(&(account,track));
    Ok(())
}

#[tauri::command]
pub fn offline_remove(app: AppHandle, state: State<Offline>, account: u64, track: String) -> Result<()> {
    let _guard=state.0.lock().map_err(io_error)?;
    let mut index=read_index(&app,account)?;
    if let Some(removed)=index.tracks.remove(&track) {
        match fs::remove_file(removed.path) {
            Ok(()) => {},
            Err(error) if error.kind()==std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(io_error(error)),
        }
        save_index(&app,account,&index)?;
    }
    Ok(())
}
