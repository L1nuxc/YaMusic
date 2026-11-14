use axum::{Json, Router, body::Body, extract::{Path, Query, State, DefaultBodyLimit}, http::{Request, StatusCode, header}, response::{IntoResponse, Response, Redirect}, routing::{get,post}};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{SqlitePool, sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions}};
use std::{collections::HashMap, path::PathBuf, str::FromStr, sync::Arc, time::{Duration, Instant}};
use tokio::sync::{Mutex, Semaphore};
use futures_util::{stream as future_stream, StreamExt};
use tower_http::{services::{ServeDir, ServeFile}, trace::TraceLayer};
pub mod lyrics;
mod llm;
mod playback_resume;
mod account_library;
mod devices;
mod smart_search;
mod music_import;
mod spotify;
mod translation;
pub mod audio;
pub mod analysis;
pub mod recommendations;
pub mod auth;

type Cache = Arc<Mutex<HashMap<String, (Instant, Value)>>>;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    client: reqwest::Client,
    base: String,
    cache: Cache,
    concurrency: Arc<Semaphore>,
    pub lyrics_base: String,
    llm_slots: Arc<Semaphore>,
    pub require_telegram: bool,
    spotify: Arc<Mutex<spotify::Connections>>,
    pub audio: Arc<audio::AudioService>,
    pub analysis: Arc<analysis::Analyzer>,
    pub recommendation_lock: Arc<Mutex<()>>,
    pub expansions: Arc<Mutex<HashMap<i64,Instant>>>,
    devices: Arc<Mutex<HashMap<i64,devices::AccountDevices>>>,
}

impl AppState {
    pub fn new(db: SqlitePool, catalog_base: String) -> Result<Self, reqwest::Error> {
        let audio=audio::AudioService::new(db.clone());
        let analysis=analysis::Analyzer::new(db.clone());
        Ok(Self {
            db,
            client: reqwest::Client::builder().timeout(Duration::from_secs(12)).connect_timeout(Duration::from_secs(5)).user_agent("YaMusic/0.1 (catalog client)").build()?,
            base: catalog_base.trim_end_matches('/').into(),
            cache: Arc::new(Mutex::new(HashMap::new())),
            concurrency: Arc::new(Semaphore::new(6)),
            lyrics_base: "https://lrclib.net".into(),
            llm_slots: Arc::new(Semaphore::new(2)),
            require_telegram: std::env::var("REQUIRE_TELEGRAM").as_deref() == Ok("1"),
            spotify: Arc::new(Mutex::new(spotify::Connections::default())),
            audio,
            analysis,
            recommendation_lock: Arc::new(Mutex::new(())),
            expansions: Arc::new(Mutex::new(HashMap::new())),
            devices: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    async fn catalog(&self, path: &str, params: &[(&str, String)]) -> Result<Value, ApiError> {
        let key = format!("{path}:{params:?}");
        if let Some((at, value)) = self.cache.lock().await.get(&key) {
            if at.elapsed() < catalog_ttl(path) { return Ok(value.clone()); }
        }
        let _permit = tokio::time::timeout(Duration::from_secs(3), self.concurrency.acquire()).await.map_err(|_| ApiError::busy())?.map_err(|_| ApiError::busy())?;
        let response = self.client.get(format!("{}{path}", self.base)).query(params).send().await.map_err(ApiError::upstream)?;
        let status = response.status();
        if !status.is_success() { return Err(ApiError::provider(format!("HTTP {status}"))); }
        let data: Value = response.json().await.map_err(ApiError::upstream)?;
        if let Some(error) = data.get("error") {
            if error["code"].as_u64() == Some(800) { return Err(ApiError::not_found()); }
            return Err(ApiError::provider(error.to_string()));
        }
        let mut cache = self.cache.lock().await;
        cache.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(600));
        if cache.len() >= 128 {
            if let Some(oldest) = cache.iter().min_by_key(|(_, (at, _))| *at).map(|(key, _)| key.clone()) { cache.remove(&oldest); }
        }
        cache.insert(key, (Instant::now(), data.clone()));
        Ok(data)
    }
}

fn catalog_ttl(path: &str) -> Duration {
    Duration::from_secs(if path.starts_with("/search/") { 60 } else { 600 })
}

pub async fn connect_database(url: &str) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::from_str(url)?.create_if_missing(true).journal_mode(SqliteJournalMode::Wal).foreign_keys(true).busy_timeout(Duration::from_secs(5));
    let db = SqlitePoolOptions::new().max_connections(4).min_connections(1).connect_with(options).await?;
    sqlx::migrate!("./migrations").run(&db).await?;
    Ok(db)
}

pub fn app(state: AppState, dist: PathBuf) -> Router {
    let protected = Router::new()
        .route("/search", get(search))
        .route("/search/smart", post(smart_search::search))
        .route("/import/spotify/start",post(spotify::start))
        .route("/import/spotify/playlists",get(spotify::playlists))
        .route("/import/spotify/page",post(spotify::page))
        .route("/import/spotify/disconnect",post(spotify::disconnect))
        .route("/import/match",post(music_import::match_export).layer(DefaultBodyLimit::max(65536)))
        .route("/import/preview", post(music_import::preview).layer(DefaultBodyLimit::max(65536)))
        .route("/playback/resume", get(playback_resume::load).post(playback_resume::save))
        .route("/playback/devices", post(devices::sync).layer(DefaultBodyLimit::max(768 * 1024)))
        .route("/account/library", get(account_library::load).post(account_library::save).layer(DefaultBodyLimit::max(24 * 1024 * 1024)))
        .route("/discover", get(discover))
        .route("/tracks/{id}", get(track))
        .route("/albums/{id}", get(album))
        .route("/artists/{id}", get(artist))
        .route("/preview/{id}", get(preview))
        .route("/lyrics/{id}", get(lyrics::get))
        .route("/lyrics/{id}/translation", post(lyrics::translate))
        .route("/playback/{id}", get(playback))
        .route("/stream/{id}", get(stream))
        .route("/prefetch", post(prefetch))
        .route("/recommendations/status", get(recommendations::status))
        .route("/recommendations/artists", get(recommendations::artists).put(recommendations::set_artists))
        .route("/recommendations/artists/suggestions", get(recommendations::artist_suggestions))
        .route("/recommendations/artists/{id}/related", get(recommendations::related_artists))
        .route("/interactions", post(recommendations::interact))
        .route("/wave", post(recommendations::start_wave))
        .route("/wave/{id}/next", post(recommendations::next_wave))
        .route("/daily-mix", get(recommendations::daily))
        .route("/mixes", get(recommendations::mixes))
        .route_layer(axum::middleware::from_fn_with_state(state.clone(), auth::require_session));
    let api = Router::new()
        .route("/health", get(health))
        .route("/auth/config", get(auth::config))
        .route("/import/spotify/callback",get(spotify::callback))
        .route("/auth/me", get(auth::me))
        .route("/auth/telegram", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .merge(protected)
        .layer(DefaultBodyLimit::max(8192))
        .fallback(|| async { ApiError::not_found() });
    Router::new().nest("/api", api)
        .fallback_service(ServeDir::new(&dist).not_found_service(ServeFile::new(dist.join("index.html"))))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[derive(Debug)]
pub struct ApiError { status: StatusCode, code: &'static str, message: &'static str }
impl ApiError {
    fn bad_request(message: &'static str) -> Self { Self { status: StatusCode::BAD_REQUEST, code: "invalid_request", message } }
    fn not_found() -> Self { Self { status: StatusCode::NOT_FOUND, code: "not_found", message: "Не удалось найти запись в каталоге." } }
    fn busy() -> Self { Self { status: StatusCode::SERVICE_UNAVAILABLE, code: "busy", message: "Каталог занят. Попробуйте через несколько секунд." } }
    fn full_audio_unavailable() -> Self { Self { status: StatusCode::SERVICE_UNAVAILABLE, code: "full_audio_unavailable", message: "Полная версия пока недоступна. Попробуйте ещё раз или выберите другой трек." } }
    fn provider(detail: String) -> Self {
        tracing::warn!(%detail, "Catalog provider error");
        Self { status: StatusCode::BAD_GATEWAY, code: "catalog_unavailable", message: "Не удалось связаться с каталогом. Попробуйте ещё раз." }
    }
    fn upstream(e: reqwest::Error) -> Self { Self::provider(e.without_url().to_string()) }
}
impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!(error = %e, "Database error");
        Self { status: StatusCode::INTERNAL_SERVER_ERROR, code: "database_error", message: "Не удалось сохранить данные каталога." }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response { (self.status, Json(json!({"error": {"code": self.code, "message": self.message}}))).into_response() }
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Track {
    pub id: String, pub deezer_id: i64, pub title: String,
    pub artist: String, pub artist_id: i64,
    pub album: String, pub album_id: i64, pub cover_url: String,
    pub duration_sec: i64, pub is_explicit: bool, pub preview_url: String,
    #[serde(default)]
    #[sqlx(json, rename="contributors_json")]
    pub contributors: Vec<ArtistCredit>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtistCredit { pub id: i64, pub name: String, #[serde(default)] pub role: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Artist { pub id: i64, pub name: String, pub picture_url: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Album { pub id: i64, pub title: String, pub artist: String, pub artist_id: i64, pub cover_url: String, pub track_count: i64 }
#[derive(Serialize, Deserialize)]
pub struct SearchResults { pub tracks: Vec<Track>, pub albums: Vec<Album>, pub artists: Vec<Artist>, pub total: u64, pub source: String }

fn string(v: &Value, key: &str) -> String { v[key].as_str().unwrap_or_default().to_owned() }
fn number(v: &Value, key: &str) -> i64 { v[key].as_i64().unwrap_or_default() }
fn image(v: &Value, large: &str, medium: &str) -> String {
    let value = string(v, large);
    if value.is_empty() { string(v, medium) } else { value }
}
fn normalize_track(v: &Value) -> Option<Track> {
    let id = number(v, "id");
    if id <= 0 || string(v, "title").is_empty() { return None; }
    let mut contributors = Vec::new();
    if let Some(credits) = v["contributors"].as_array() {
        for credit in credits {
            let id = number(credit, "id"); let name = string(credit, "name");
            if id > 0 && !name.is_empty() && !contributors.iter().any(|c:&ArtistCredit|c.id==id) {
                contributors.push(ArtistCredit{id,name,role:string(credit,"role")});
            }
        }
    }
    Some(Track {
        id: format!("deezer_{id}"), deezer_id: id, title: string(v, "title"),
        artist: string(&v["artist"], "name"), artist_id: number(&v["artist"], "id"),
        album: string(&v["album"], "title"), album_id: number(&v["album"], "id"),
        cover_url: image(&v["album"], "cover_big", "cover_medium"),
        duration_sec: number(v, "duration").max(0), is_explicit: v["explicit_lyrics"].as_bool().unwrap_or(false), preview_url: string(v, "preview"),
        contributors,
    })
}
fn normalize_artist(v: &Value) -> Artist { Artist { id: number(v, "id"), name: string(v, "name"), picture_url: image(v, "picture_big", "picture_medium") } }
fn normalize_album(v: &Value) -> Album { Album { id: number(v, "id"), title: string(v, "title"), artist: string(&v["artist"], "name"), artist_id: number(&v["artist"], "id"), cover_url: image(v, "cover_big", "cover_medium"), track_count: number(v, "nb_tracks") } }
fn items(v: &Value) -> &[Value] { v["data"].as_array().map(Vec::as_slice).unwrap_or_default() }
fn parse_id(id: &str) -> Result<i64, ApiError> {
    id.strip_prefix("deezer_").unwrap_or(id).parse::<i64>().ok().filter(|n| *n > 0).ok_or_else(|| ApiError::bad_request("Некорректный идентификатор."))
}

async fn save_tracks(db: &SqlitePool, tracks: &[Track]) -> Result<(), ApiError> {
    if tracks.is_empty() { return Ok(()); }
    let mut tx = db.begin().await?;
    for t in tracks {
        sqlx::query("INSERT INTO tracks (id,deezer_id,title,artist,artist_id,album,album_id,cover_url,duration_sec,is_explicit,preview_url,contributors_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,artist=excluded.artist,artist_id=excluded.artist_id,album=excluded.album,album_id=excluded.album_id,cover_url=excluded.cover_url,duration_sec=excluded.duration_sec,is_explicit=excluded.is_explicit,preview_url=excluded.preview_url,contributors_json=CASE WHEN excluded.contributors_json='[]' THEN tracks.contributors_json ELSE excluded.contributors_json END,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')")
            .bind(&t.id).bind(t.deezer_id).bind(&t.title).bind(&t.artist).bind(t.artist_id).bind(&t.album).bind(t.album_id).bind(&t.cover_url).bind(t.duration_sec).bind(t.is_explicit).bind(&t.preview_url).bind(serde_json::to_string(&t.contributors).unwrap_or_else(|_|"[]".into())).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
/// Compact catalog responses omit contributors. Reuse stored credits first,
/// then fetch details with bounded parallelism and a strict page-time budget.
/// Audio startup never waits for this metadata enrichment.
async fn enrich_tracks(state: &AppState, tracks: &mut [Track], fetch_missing: bool) -> Result<(), ApiError> {
    if tracks.is_empty() { return Ok(()); }
    let mut query = sqlx::QueryBuilder::<sqlx::Sqlite>::new("SELECT * FROM tracks WHERE id IN (");
    let mut ids = query.separated(",");
    for track in tracks.iter() { ids.push_bind(track.id.clone()); }
    ids.push_unseparated(")");
    let stored = query.build_query_as::<Track>().fetch_all(&state.db).await?;
    let stored: HashMap<_,_> = stored.into_iter().map(|track|(track.id,track.contributors)).collect();
    for track in tracks.iter_mut() {
        if track.contributors.is_empty() {
            if let Some(credits) = stored.get(&track.id) { track.contributors = credits.clone(); }
        }
    }
    if !fetch_missing { return Ok(()); }
    let missing: Vec<_> = tracks.iter().enumerate().filter(|(_,t)|t.contributors.is_empty()).take(50).map(|(i,t)|(i,t.deezer_id)).collect();
    let mut requests = future_stream::iter(missing.into_iter().map(|(index,id)| async move {
        let data = state.catalog(&format!("/track/{id}"), &[]).await.ok()?;
        let mut fresh = normalize_track(&data)?;
        if fresh.deezer_id != id { return None; }
        // A detailed response without guests is still a known solo credit.
        if fresh.contributors.is_empty() && fresh.artist_id > 0 && !fresh.artist.is_empty() {
            fresh.contributors.push(ArtistCredit{id:fresh.artist_id,name:fresh.artist.clone(),role:"Main".into()});
        }
        Some((index,fresh))
    })).buffer_unordered(4);
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1800);
    while let Ok(Some(result)) = tokio::time::timeout_at(deadline, requests.next()).await {
        if let Some((index,fresh)) = result { tracks[index] = fresh; }
    }
    Ok(())
}
async fn save_entities(db: &SqlitePool, artists: &[Artist], albums: &[Album]) -> Result<(), ApiError> {
    let mut tx = db.begin().await?;
    for a in artists {
        sqlx::query("INSERT INTO catalog_artists (id,name,picture_url,data_json) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,picture_url=excluded.picture_url,data_json=excluded.data_json,updated_at=CURRENT_TIMESTAMP")
            .bind(a.id).bind(&a.name).bind(&a.picture_url).bind(serde_json::to_string(a).unwrap_or_default()).execute(&mut *tx).await?;
    }
    for a in albums {
        sqlx::query("INSERT INTO catalog_albums (id,title,artist_id,cover_url,data_json) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,artist_id=excluded.artist_id,cover_url=excluded.cover_url,data_json=excluded.data_json,updated_at=CURRENT_TIMESTAMP")
            .bind(a.id).bind(&a.title).bind(a.artist_id).bind(&a.cover_url).bind(serde_json::to_string(a).unwrap_or_default()).execute(&mut *tx).await?;
    }
    tx.commit().await?; Ok(())
}

async fn health(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    sqlx::query("SELECT 1").execute(&state.db).await?;
    Ok(Json(json!({ "status":"ok", "stage":4, "catalog":"deezer", "playback":"full_only", "lyrics":"lrclib", "auth":if std::env::var("TELEGRAM_BOT_TOKEN").is_ok(){"telegram"}else{"not_configured"} })))
}

#[derive(Deserialize)]
struct SearchParams { q: String, #[serde(rename="type", default)] kind: String, limit: Option<u16>, index: Option<u32>, #[serde(default)] compact: bool }
async fn search(State(state): State<AppState>, Query(params): Query<SearchParams>) -> Result<Json<SearchResults>, ApiError> {
    let q = params.q.trim();
    if q.is_empty() || q.chars().count() > 200 { return Err(ApiError::bad_request("Введите от 1 до 200 символов.")); }
    let kind = if params.kind.is_empty() { "all" } else { &params.kind };
    if !["all", "track", "album", "artist"].contains(&kind) { return Err(ApiError::bad_request("Неизвестный тип поиска.")); }
    let limit = params.limit.unwrap_or(20);
    let index = params.index.unwrap_or(0);
    if !(1..=50).contains(&limit) || index > 10_000 { return Err(ApiError::bad_request("Некорректный размер страницы.")); }
    let args = [("q", q.to_owned()), ("limit", limit.to_string()), ("index", index.to_string())];
    async fn optional(state: &AppState, enabled: bool, path: &str, args: &[(&str, String)]) -> Result<Value, ApiError> {
        if enabled { state.catalog(path, args).await } else { Ok(json!({"data":[],"total":0})) }
    }
    let (tracks, albums, artists) = tokio::try_join!(
        optional(&state, kind == "all" || kind == "track", "/search/track", &args),
        optional(&state, kind == "all" || kind == "album", "/search/album", &args),
        optional(&state, kind == "all" || kind == "artist", "/search/artist", &args)
    )?;
    let mut result = SearchResults {
        tracks: items(&tracks).iter().filter_map(normalize_track).collect(),
        albums: items(&albums).iter().map(normalize_album).collect(),
        artists: items(&artists).iter().map(normalize_artist).collect(),
        total: [&tracks,&albums,&artists].iter().map(|v| v["total"].as_u64().unwrap_or(0)).sum(), source: "deezer".into(),
    };
    enrich_tracks(&state, &mut result.tracks, !params.compact).await?;
    save_tracks(&state.db, &result.tracks).await?;
    state.analysis.enqueue(result.tracks.iter().map(|t|t.id.clone()),false);
    save_entities(&state.db, &result.artists, &result.albums).await?;
    Ok(Json(result))
}

async fn discover(State(state): State<AppState>, headers: axum::http::HeaderMap) -> Result<Json<Value>, ApiError> {
    recommendations::discover(State(state),headers).await
}

async fn track(State(state): State<AppState>, Path(id): Path<String>) -> Result<Json<Track>, ApiError> {
    let id = parse_id(&id)?;
    let data = state.catalog(&format!("/track/{id}"), &[]).await?;
    let track = normalize_track(&data).ok_or_else(ApiError::not_found)?;
    save_tracks(&state.db, std::slice::from_ref(&track)).await?;
    Ok(Json(track))
}
#[derive(Deserialize)]
struct DetailParams { #[serde(default)] compact: bool }
async fn album(State(state): State<AppState>, Path(id): Path<String>, Query(params): Query<DetailParams>) -> Result<Json<Value>, ApiError> {
    let id = parse_id(&id)?;
    let data = state.catalog(&format!("/album/{id}"), &[]).await?;
    let album = normalize_album(&data);
    let mut tracks = album_tracks(&data);
    enrich_tracks(&state, &mut tracks, !params.compact).await?;
    save_tracks(&state.db, &tracks).await?;
    save_entities(&state.db, &[], std::slice::from_ref(&album)).await?;
    state.audio.prefetch(tracks.iter().take(3).map(|t|t.id.clone()));
    Ok(Json(json!({"album":album,"tracks":tracks,"source":"deezer"})))
}
fn album_tracks(data: &Value) -> Vec<Track> {
    let mut album = data.clone();
    if let Some(fields) = album.as_object_mut() { fields.remove("tracks"); }
    items(&data["tracks"]).iter().take(100).filter_map(|v| {
        let mut v = v.clone(); v["album"] = album.clone();
        if v["artist"]["name"].as_str().is_none() { v["artist"] = data["artist"].clone(); }
        normalize_track(&v)
    }).collect()
}
async fn artist(State(state): State<AppState>, Path(id): Path<String>, Query(params): Query<DetailParams>) -> Result<Json<Value>, ApiError> {
    let id = parse_id(&id)?;
    let detail_path = format!("/artist/{id}");
    let top_path = format!("/artist/{id}/top");
    let albums_path = format!("/artist/{id}/albums");
    let top_args = [("limit", "30".into())];
    let albums_args = [("limit", "24".into())];
    let (data, top, albums) = tokio::try_join!(
        state.catalog(&detail_path, &[]),
        state.catalog(&top_path, &top_args),
        state.catalog(&albums_path, &albums_args)
    )?;
    let artist = normalize_artist(&data);
    let mut tracks: Vec<_> = items(&top).iter().filter_map(normalize_track).collect();
    let albums: Vec<_> = items(&albums).iter().map(|v| { let mut v = v.clone(); if v["artist"].is_null(){v["artist"] = data.clone();} normalize_album(&v) }).collect();
    let expand = tracks.len() < 10;
    if expand && !params.compact {
        // Some artist/top endpoints contain only one or two songs despite an
        // extensive discography. Inspect releases, preserving exact artist IDs.
        let mut releases = future_stream::iter(albums.clone().into_iter().take(12).enumerate().map(|(index,a): (usize,Album)| {
            let state = state.clone();
            async move { (index,state.catalog(&format!("/album/{}",a.id),&[]).await.ok()) }
        })).buffer_unordered(4);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
        let mut found = Vec::new();
        while let Ok(Some((index,result))) = tokio::time::timeout_at(deadline,releases.next()).await {
            if let Some(data) = result { found.push((index,album_tracks(&data))); }
        }
        found.sort_by_key(|(index,_)|*index);
        for (_,release) in found { tracks.extend(release); }
    }
    let mut seen = std::collections::HashSet::new();
    tracks.retain(|t|seen.insert(t.id.clone()));
    tracks.truncate(100);
    enrich_tracks(&state,&mut tracks,!params.compact).await?;
    // Guests belong to this discography too; unrelated namesakes do not.
    tracks.retain(|t|t.artist_id==id || t.contributors.iter().any(|credit|credit.id==id));
    tracks.truncate(30);
    save_tracks(&state.db, &tracks).await?;
    save_entities(&state.db, std::slice::from_ref(&artist), &albums).await?;
    Ok(Json(json!({"artist":artist,"tracks":tracks,"albums":albums,"source":"deezer","tracks_source":if expand && !params.compact{"top_and_discography"}else{"top"},"more_tracks":expand && params.compact})))
}
async fn preview(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response, ApiError> {
    let Json(track) = track(State(state), Path(id)).await?;
    let url = reqwest::Url::parse(&track.preview_url).map_err(|_| ApiError::not_found())?;
    let host = url.host_str().unwrap_or_default();
    if url.scheme() != "https" || !(host == "dzcdn.net" || host.ends_with(".dzcdn.net")) { return Err(ApiError::not_found()); }
    Ok(([(header::CACHE_CONTROL, "no-store")], Redirect::temporary(url.as_str())).into_response())
}

pub async fn stored_track(state:&AppState,id:&str)->Result<Track,ApiError> {
    let numeric=parse_id(id)?;
    if let Some(t)=sqlx::query_as::<_,Track>("SELECT * FROM tracks WHERE id=?").bind(format!("deezer_{numeric}")).fetch_optional(&state.db).await?{return Ok(t);}
    let Json(t)=track(State(state.clone()),Path(id.to_string())).await?;Ok(t)
}
async fn playback(State(state):State<AppState>,Path(id):Path<String>)->Result<Json<audio::PlaybackInfo>,ApiError> {
    let t=stored_track(&state,&id).await?;Ok(Json(state.audio.info(&t).await?))
}
async fn stream(State(state):State<AppState>,Path(id):Path<String>,request:Request<Body>)->Result<Response,ApiError> {
    let t=stored_track(&state,&id).await?;
    state.audio.stream(&t,request).await
}
#[derive(Deserialize)]
struct Prefetch { ids:Vec<String>, #[serde(default)] playback:bool }
async fn prefetch(State(state):State<AppState>,Json(body):Json<Prefetch>)->Result<StatusCode,ApiError> {
    if body.ids.len()>5 {return Err(ApiError::bad_request("Можно подготовить до пяти треков."));}
    let ids=body.ids.into_iter().map(|id|parse_id(&id).map(|n|format!("deezer_{n}"))).collect::<Result<Vec<_>,_>>()?;
    if body.playback { state.audio.prefetch_playback(ids); } else { state.audio.prefetch(ids); }
    Ok(StatusCode::ACCEPTED)
}
