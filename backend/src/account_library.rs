use crate::{ApiError, AppState, Track, auth};
use axum::{Json, extract::State, http::{HeaderMap, header}};
use serde::Deserialize;
use serde_json::{Map, Value, json};

#[derive(Deserialize)]
pub struct Change {
    id: String,
    #[serde(default)]
    import_legacy: bool,
    entries: Map<String, Value>,
    #[serde(default)]
    likes: Vec<String>,
}

fn no_store() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    headers
}

pub async fn load(State(state): State<AppState>, headers: HeaderMap) -> Result<(HeaderMap, Json<Value>), ApiError> {
    let user = auth::session_user(&state, &headers).await?.ok_or_else(auth::denied)?;
    let mut snapshot = Map::new();
    let rows = sqlx::query_as::<_, (String, String)>("SELECT key, data FROM account_library WHERE user_id=?")
        .bind(user).fetch_all(&state.db).await?;
    for (key, data) in rows {
        if let Ok(value) = serde_json::from_str(&data) { snapshot.insert(key, value); }
    }
    let likes = sqlx::query_as::<_, Track>(
        "SELECT t.* FROM user_track_flags f JOIN tracks t ON t.id=f.track_id
         WHERE f.user_id=? AND f.is_liked=1
         ORDER BY (SELECT max(i.id) FROM interactions i
                   WHERE i.user_id=f.user_id AND i.track_id=f.track_id AND i.action_type='like') DESC, t.id")
        .bind(user).fetch_all(&state.db).await?;
    let dislikes: Vec<String> = sqlx::query_scalar("SELECT track_id FROM user_track_flags WHERE user_id=? AND is_disliked=1")
        .bind(user).fetch_all(&state.db).await?;
    Ok((no_store(), Json(json!({"entries":snapshot,"likes":likes,"dislikes":dislikes}))))
}

fn valid_id(id: &str) -> bool {
    (1..=80).contains(&id.len()) && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn valid_entry(key: &str, value: &Value) -> bool {
    if let Some(id) = key.strip_prefix("playlist:") {
        return valid_id(id) && (value.is_null() || (value["id"].as_str()==Some(id) &&
            value["title"].as_str().is_some_and(|s| s.chars().count() <= 100) &&
            value["tracks"].as_array().is_some_and(|items| items.len() <= 5000)));
    }
    match key {
        "theme" => matches!(value.as_str(), Some("dark" | "light")),
        "animations" => value.is_boolean(),
        "crossfade" => value.as_u64().is_some_and(|seconds| seconds <= 8),
        "translation" => matches!(value.as_str(), Some("mymemory" | "deepseek" | "google" | "deepl")),
        "translationLanguage" => value.as_str().is_some_and(|s| s.len() <= 12 && s.bytes().all(|b| b.is_ascii_alphabetic() || b==b'-')),
        "searchHistory" => value.as_array().is_some_and(|items| items.len() <= 30 && items.iter().all(|v| v.as_str().is_some_and(|s| s.chars().count() <= 200))),
        "history" => value.as_array().is_some_and(|items| items.len() <= 100),
        "heard" => !value.is_null() && serde_json::from_value::<Track>(value.clone()).is_ok(),
        _ => false,
    }
}

pub async fn save(State(state): State<AppState>, headers: HeaderMap, Json(change): Json<Change>) -> Result<HeaderMap, ApiError> {
    auth::origin(&headers)?;
    let user = auth::session_user(&state, &headers).await?.ok_or_else(auth::denied)?;
    if !valid_id(&change.id) || change.entries.len() > 210 || change.likes.len() > 5000 ||
        (!change.import_legacy && !change.likes.is_empty()) ||
        !change.entries.iter().all(|(key,value)|valid_entry(key,value)) {
        return Err(ApiError::bad_request("Не удалось сохранить изменения медиатеки."));
    }
    let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await?;
    let inserted = sqlx::query("INSERT OR IGNORE INTO account_library_receipts(user_id,id) VALUES (?,?)")
        .bind(user).bind(&change.id).execute(&mut *tx).await?.rows_affected();
    if inserted == 0 { return Ok(no_store()); }
    for (mut key, mut value) in change.entries {
        if key == "heard" {
            key = "history".into();
            let old: Option<String> = sqlx::query_scalar("SELECT data FROM account_library WHERE user_id=? AND key='history'")
                .bind(user).fetch_optional(&mut *tx).await?;
            let mut history: Vec<Value> = old.and_then(|raw|serde_json::from_str(&raw).ok()).unwrap_or_default();
            history.retain(|track| track["id"] != value["id"]);
            history.insert(0, value);
            history.truncate(100);
            value = json!(history);
        }
        let sql = if change.import_legacy {
            "INSERT INTO account_library(user_id,key,data) VALUES (?,?,?) ON CONFLICT(user_id,key) DO NOTHING"
        } else {
            "INSERT INTO account_library(user_id,key,data) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET data=excluded.data"
        };
        sqlx::query(sql).bind(user).bind(key).bind(value.to_string()).execute(&mut *tx).await?;
    }
    for track in change.likes {
        let liked = sqlx::query("INSERT OR IGNORE INTO user_track_flags(user_id,track_id,is_liked,is_disliked)
                    SELECT ?, id, 1, 0 FROM tracks WHERE id=?")
            .bind(user).bind(&track).execute(&mut *tx).await?.rows_affected();
        if liked != 0 {
            sqlx::query("INSERT INTO interactions(user_id,track_id,action_type,listen_ratio) VALUES (?,?,'like',0)")
                .bind(user).bind(track).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    Ok(no_store())
}
