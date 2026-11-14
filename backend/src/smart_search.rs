use crate::{ApiError, AppState, Track, auth, enrich_tracks, items, llm, normalize_track, save_tracks};
use axum::{Json, extract::State, http::{HeaderMap, StatusCode}};
use futures_util::{StreamExt, stream};
use serde::{Deserialize,Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;

#[derive(Deserialize)]
pub struct Prompt { query: String }

#[derive(Clone,Deserialize,Serialize)]
pub(crate) struct Candidate { pub artist: String, pub title: String }

fn normalized(text: &str) -> String {
    text.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

pub(crate) async fn matching_track(state: &AppState, candidate: Candidate) -> Option<Track> {
    let title = normalized(&crate::lyrics::clean_title(&candidate.title));
    let artist = normalized(&candidate.artist);
    if title.is_empty() || artist.is_empty() { return None; }
    let query = format!("{} {}", candidate.artist, candidate.title);
    let data = state.catalog("/search/track", &[("q", query), ("limit", "8".into())]).await.ok()?;
    items(&data).iter().filter_map(normalize_track).find(|track| {
        normalized(&crate::lyrics::clean_title(&track.title)) == title && (normalized(&track.artist) == artist || track.contributors.iter().any(|credit|normalized(&credit.name)==artist))
    })
}

pub(crate) async fn match_candidates(state: &AppState, candidates: Vec<Candidate>, limit: usize) -> Result<(Vec<Track>,Vec<Candidate>), ApiError> {
    let mut pending = stream::iter(candidates.into_iter().take(limit)
        .map(|item| async move {
            let result=if item.title.len()<=200 && item.artist.len()<=160 {matching_track(state,item.clone()).await}else{None};
            (item,result)
        })).buffered(5);
    let mut tracks = Vec::new();
    let mut ids = HashSet::new();
    let mut missing=Vec::new();
    while let Some((candidate,item)) = pending.next().await {
        match item {
            Some(track) if ids.insert(track.id.clone()) => tracks.push(track),
            Some(_) => {},
            None => missing.push(candidate),
        }
    }
    enrich_tracks(state, &mut tracks, false).await?;
    save_tracks(&state.db, &tracks).await?;
    Ok((tracks,missing))
}

async fn generate(state: &AppState, headers: &HeaderMap, input: Prompt) -> Result<Json<Value>, ApiError> {
    auth::origin(headers)?;
    if auth::session_user(state, headers).await?.is_none() { return Err(auth::denied()); }
    let query = input.query.trim();
    if !(2..=300).contains(&query.chars().count()) { return Err(ApiError::bad_request("Введите от 2 до 300 символов.")); }
    let local=crate::lyrics::search_cached(&state,query).await?;
    if !local.is_empty(){return Ok(Json(json!({"tracks":local})));}
    let system = r#"Identify the real songs described by the query, which may quote lyrics or transliterate names. Return up to 8 confident matches in JSON: {"tracks":[{"artist":"primary artist","title":"canonical title"}]}. Return an empty list when unsure."#;
    let reply = llm::complete(state, system, query, 2500).await?;
    let candidates: Vec<Candidate> = serde_json::from_value(reply["tracks"].clone()).map_err(|_| {
        llm::error(StatusCode::BAD_GATEWAY, "invalid_suggestions", "ИИ не вернул список треков. Попробуйте ещё раз.")
    })?;
    let (tracks,_)=match_candidates(state,candidates,8).await?;
    Ok(Json(json!({"tracks":tracks})))
}

pub async fn search(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<Prompt>) -> Result<Json<Value>, ApiError> {
    generate(&state, &headers, input).await
}
