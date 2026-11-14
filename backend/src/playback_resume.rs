use crate::{ApiError, AppState, Track, auth, parse_id, stored_track};
use axum::{Json, extract::State, http::{HeaderMap, header}};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Deserialize)]
pub struct SaveResume {
    track_id: String,
    position: f64,
    context: Option<String>,
    queue: Vec<String>,
    captured_at: i64,
}

#[derive(FromRow)]
struct StoredResume {
    track_id: String,
    position: f64,
    context: Option<String>,
    queue_json: String,
    captured_at: i64,
}

#[derive(Serialize)]
pub struct Resume {
    track: Track,
    position: f64,
    context: Option<String>,
    queue: Vec<Track>,
    captured_at: i64,
}

fn no_store() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
    headers
}

pub async fn load(State(state): State<AppState>, headers: HeaderMap) -> Result<(HeaderMap, Json<Option<Resume>>), ApiError> {
    let user = auth::session_user(&state, &headers).await?.ok_or_else(auth::denied)?;
    let saved: Option<StoredResume> = sqlx::query_as("SELECT track_id, position, context, queue_json, captured_at FROM playback_resume WHERE user_id=?")
        .bind(user).fetch_optional(&state.db).await?;
    let Some(saved) = saved else { return Ok((no_store(), Json(None))); };
    let track = stored_track(&state, &saved.track_id).await?;
    let ids: Vec<String> = serde_json::from_str(&saved.queue_json).unwrap_or_default();
    let mut queue = Vec::new();
    for id in ids {
        if id == track.id {
            queue.push(track.clone());
        } else if let Some(item) = sqlx::query_as::<_, Track>("SELECT * FROM tracks WHERE id=?").bind(id).fetch_optional(&state.db).await? {
            queue.push(item);
        }
    }
    let context = if let Some(session) = saved.context {
        sqlx::query_scalar("SELECT id FROM wave_sessions WHERE id=? AND user_id=? AND updated_at>=datetime('now','-1 day')")
            .bind(session).bind(user).fetch_optional(&state.db).await?
    } else { None };
    state.audio.prefetch_playback(queue.iter().skip_while(|item| item.id != track.id).take(3).map(|item| item.id.clone()));
    Ok((no_store(), Json(Some(Resume { track, position: saved.position, context, queue, captured_at: saved.captured_at }))))
}

pub async fn save(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<SaveResume>) -> Result<HeaderMap, ApiError> {
    auth::origin(&headers)?;
    let user = auth::session_user(&state, &headers).await?.ok_or_else(auth::denied)?;
    if body.queue.len() > 40 || body.position < 0.0 || !body.position.is_finite() {
        return Err(ApiError::bad_request("Некорректная позиция воспроизведения."));
    }
    let track = stored_track(&state, &body.track_id).await?;
    let ids = body.queue.iter().map(|id| parse_id(id).map(|n| format!("deezer_{n}"))).collect::<Result<Vec<_>, _>>()?;
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
    let captured_at = body.captured_at.clamp(timestamp - 30 * 86_400_000, timestamp + 5_000);
    let context = body.context.filter(|id| id.len() == 32 && id.bytes().all(|c| c.is_ascii_hexdigit()));
    sqlx::query("INSERT INTO playback_resume(user_id,track_id,position,context,queue_json,captured_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET track_id=excluded.track_id, position=excluded.position,
        context=excluded.context, queue_json=excluded.queue_json, captured_at=excluded.captured_at
        WHERE excluded.captured_at >= playback_resume.captured_at")
        .bind(user).bind(track.id).bind(body.position.min(track.duration_sec as f64))
        .bind(context).bind(serde_json::to_string(&ids).expect("track IDs serialize")).bind(captured_at)
        .execute(&state.db).await?;
    Ok(no_store())
}
