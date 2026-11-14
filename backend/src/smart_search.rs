use crate::{ApiError, AppState, Artist, Track, auth, enrich_tracks, items, llm, normalize_artist, normalize_track, save_tracks};
use axum::{Json, extract::State, http::{HeaderMap, StatusCode}};
use futures_util::{StreamExt, stream};
use serde::{Deserialize,Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

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
    enrich_tracks(state, &mut tracks).await?;
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
#[derive(Default, Deserialize)]
struct WaveIntent {
    #[serde(default)]
    artist_names: Vec<String>,
    #[serde(default)]
    similar: bool,
}

async fn exact_artist(state: &AppState, name: &str) -> Option<Artist> {
    if name.trim().is_empty() || name.len()>100 { return None; }
    let result=state.catalog("/search/artist",&[("q",name.to_owned()),("limit","8".into())]).await.ok()?;
    let key=normalized(name);
    items(&result).iter().map(normalize_artist).find(|artist| artist.id>0 && normalized(&artist.name)==key)
}

async fn artist_top(state: &AppState, id: i64, limit: usize) -> Vec<Track> {
    state.catalog(&format!("/artist/{id}/top"),&[("limit",limit.to_string())]).await
        .map(|result|items(&result).iter().filter_map(normalize_track).collect()).unwrap_or_default()
}

async fn related_pool(state: &AppState, artist: &Artist, include_reference: bool) -> Result<Vec<Track>, ApiError> {
    let mut anchor=artist_top(state,artist.id,10).await;
    enrich_tracks(state,&mut anchor).await?;
    let mut artist_ids=Vec::new();
    let mut seen=HashSet::from([artist.id]);
    for track in &anchor {
        if track.artist_id>0 && seen.insert(track.artist_id) { artist_ids.push(track.artist_id); }
        for credit in &track.contributors {
            if credit.id>0 && seen.insert(credit.id) { artist_ids.push(credit.id); }
        }
    }
    // Frequent collaborations are the closest catalog evidence. Add Deezer neighbors
    // afterwards to broaden the choice without falling into unrelated chart tracks.
    artist_ids.truncate(6);
    if let Ok(related)=state.catalog(&format!("/artist/{}/related",artist.id),&[("limit","12".into())]).await {
        for candidate in items(&related).iter().map(normalize_artist) {
            if candidate.id>0 && seen.insert(candidate.id) { artist_ids.push(candidate.id); }
        }
    }
    artist_ids.truncate(12);
    let mut groups=stream::iter(artist_ids.into_iter().map(|id|async move{
        artist_top(state,id,6).await.into_iter().filter(|track|track.artist_id==id).collect::<Vec<_>>()
    })).buffered(5).collect::<Vec<_>>().await;
    let reference:Vec<_>=anchor.iter().filter(|track|track.artist_id==artist.id).take(if include_reference{7}else{1}).cloned().collect();
    if include_reference { groups.insert(0,reference.clone()); }
    let mut tracks=Vec::new();
    let mut ids=HashSet::new();
    for rank in 0..6 {
        for group in &groups {
            if let Some(track)=group.get(rank).filter(|track|ids.insert(track.id.clone())) { tracks.push(track.clone()); }
        }
    }
    if !include_reference {
        for track in reference {
            if ids.insert(track.id.clone()) { tracks.insert(8.min(tracks.len()),track); }
        }
    }
    Ok(tracks)
}

pub async fn neuro_wave(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<Prompt>) -> Result<Json<Value>, ApiError> {
    auth::origin(&headers)?;
    let user=auth::session_user(&state,&headers).await?.ok_or_else(auth::denied)?;
    let query=input.query.trim();
    if !(2..=300).contains(&query.chars().count()) { return Err(ApiError::bad_request("Введите от 2 до 300 символов.")); }
    let local_reference=query.split_once(" на ").map(|(_,name)|name.trim_matches(|c:char|c.is_whitespace()||"«»\"?!.".contains(c)));
    let guess=r#"Classify a music request. If the listener names a musical artist, return canonical artist spellings (especially stylized Russian rap artist names transcribed in Cyrillic). Example: «что-то похожее на мэткида» or «мыткида» means madk1d. JSON format {"artist_names":["canonical spelling","alternate spelling"],"similar":true}. Set similar true for requests for related artists, style, or sound. For descriptions without a reference artist return an empty artist_names array. Do not invent names."#;
    let direct=exact_artist(&state,local_reference.unwrap_or(query)).await;
    let intent=if direct.is_none() {
        let reply=llm::complete(&state,guess,query,1200).await?;
        serde_json::from_value::<WaveIntent>(reply).unwrap_or_default()
    } else { WaveIntent { similar:local_reference.is_some(), ..WaveIntent::default() } };
    let mut artist=direct;
    for name in intent.artist_names.iter().take(4) {
        if artist.is_none() { artist=exact_artist(&state,name).await; }
    }
    let taste=crate::recommendations::wave_preferences(&state,user).await?;
    let mut tracks=if let Some(artist)=&artist {
        related_pool(&state,artist,!intent.similar).await?
    } else {
        let system=r#"Suggest up to 30 real tracks matching the listener's request. The request is decisive: use the listener's preferences only to choose among matching songs, and respect language and genre. Return JSON only: {"tracks":[{"artist":"primary artist","title":"canonical title"}]}."#;
        let reply=llm::complete(&state,system,&json!({"request":query,"preferred_artists":taste.artists}).to_string(),4500).await?;
        let candidates=serde_json::from_value(reply["tracks"].clone()).map_err(|_|ApiError::provider("invalid suggestions".into()))?;
        match_candidates(&state,candidates,30).await?.0
    };
    tracks.retain(|track|!taste.blocked.contains(&track.id));
    if artist.is_some(){
        let vectors=state.analysis.vectors.read().unwrap();
        // Keep the catalog order as the main signal, with a small boost from listening taste.
        let order:HashMap<_,_>=tracks.iter().enumerate().map(|(index,track)|(track.id.clone(),index as f32)).collect();
        let score=|track:&Track|order[&track.id]-taste.affinity(track,vectors.get(&track.id))*4.0;
        tracks.sort_by(|a,b|score(a).total_cmp(&score(b)));
    }
    let mut per_artist=HashMap::<i64,usize>::new();
    tracks.retain(|track|{
        let count=per_artist.entry(track.artist_id).or_default();
        let limit=if artist.as_ref().is_some_and(|a|a.id==track.artist_id)&&!intent.similar{6}else{3};
        *count+=1;
        *count<=limit
    });
    tracks.truncate(30);
    enrich_tracks(&state,&mut tracks).await?;
    save_tracks(&state.db,&tracks).await?;
    state.audio.prefetch_playback(tracks.iter().take(3).map(|track|track.id.clone()));
    Ok(Json(json!({"tracks":tracks,"reference":artist.map(|a|a.name)})))
}
