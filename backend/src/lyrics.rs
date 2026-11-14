use crate::{ApiError, AppState, Track, stored_track};
use axum::{Json, extract::{Path, State}, http::{HeaderMap, StatusCode}};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;
use sha2::{Digest, Sha256};
use axum::extract::Query;
use futures_util::{stream, StreamExt};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lyrics {
    pub track_id: String,
    pub synced_lrc: Option<String>,
    pub plain_lyrics: Option<String>,
    pub instrumental: bool,
    pub provider_id: Option<i64>,
    pub status: String,
    pub source: String,
}
fn text(v: &Value, key: &str) -> Option<String> {
    v[key].as_str().map(str::trim).filter(|s| !s.is_empty() && s.len() <= 200_000).map(str::to_owned)
}
pub fn clean_title(title: &str) -> String {
    let lowered = title.to_lowercase();
    let split = [" (feat.", " (ft.", " (remastered", " - remaster", " (radio edit", " (explicit", " (original mix"]
        .iter().filter_map(|part| lowered.find(part)).min().unwrap_or(title.len());
    title[..split].trim().to_owned()
}
fn normalized(value: &str) -> String { value.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect() }
fn matches(v: &Value, t: &Track) -> bool {
    let duration = v["duration"].as_f64().unwrap_or(-100.0);
    (duration - t.duration_sec as f64).abs() <= 4.0 &&
        normalized(v["artistName"].as_str().unwrap_or("")) == normalized(&t.artist) &&
        normalized(&clean_title(v["trackName"].as_str().unwrap_or(""))) == normalized(&clean_title(&t.title))
}

pub async fn get(State(state): State<AppState>, Path(id): Path<String>) -> Result<Json<Lyrics>, ApiError> {
    let t = stored_track(&state,&id).await?;
    if let Some(row) = sqlx::query("SELECT synced_lrc,plain_lyrics,instrumental,provider_id FROM lyrics_cache WHERE track_id=? AND (synced_lrc IS NOT NULL OR plain_lyrics IS NOT NULL OR instrumental=1 OR datetime(fetched_at)>datetime('now','-1 day'))")
        .bind(&t.id).fetch_optional(&state.db).await? {
        let synced_lrc: Option<String> = row.get("synced_lrc");
        let plain_lyrics: Option<String> = row.get("plain_lyrics");
        let instrumental: bool = row.get("instrumental");
        return Ok(Json(Lyrics { track_id:t.id, status: status(&synced_lrc,&plain_lyrics,instrumental).into(), synced_lrc, plain_lyrics, instrumental, provider_id:row.get("provider_id"),source:"lrclib".into() }));
    }
    let title = clean_title(&t.title);
    let base = state.lyrics_base.trim_end_matches('/');
    let exact = async {
        for name in std::iter::once(t.title.as_str()).chain((title != t.title).then_some(title.as_str())) {
            let response = state.client.get(format!("{base}/api/get"))
                .query(&[("track_name", name), ("artist_name", t.artist.as_str()), ("album_name", t.album.as_str()), ("duration", &t.duration_sec.to_string())])
                .timeout(std::time::Duration::from_secs(4)).send().await.map_err(ApiError::upstream)?;
            if response.status() == reqwest::StatusCode::NOT_FOUND { continue; }
            if !response.status().is_success() { return Err(ApiError::provider("lyrics provider unavailable".into())); }
            let data: Value = response.json().await.map_err(ApiError::upstream)?;
            if matches(&data, &t) { return Ok(Some(data)); }
        }
        Ok(None)
    };
    let search = async {
        let response = state.client.get(format!("{base}/api/search"))
            .query(&[("track_name", title.as_str()), ("artist_name", t.artist.as_str())])
            .timeout(std::time::Duration::from_secs(5)).send().await.map_err(ApiError::upstream)?;
        if !response.status().is_success() { return Err(ApiError::provider("lyrics search unavailable".into())); }
        let data: Value = response.json().await.map_err(ApiError::upstream)?;
        Ok(data.as_array().and_then(|list| list.iter().filter(|v| matches(v, &t))
            .max_by_key(|v| (text(v, "syncedLyrics").is_some(), v["albumName"].as_str() == Some(t.album.as_str()))).cloned()))
    };
    tokio::pin!(exact);
    let found = tokio::select! {
        result = &mut exact => match result {
            Ok(Some(data)) => Some(data),
            other => prefer_lyrics(other, search.await)?,
        },
        _ = tokio::time::sleep(std::time::Duration::from_millis(300)) => {
            tokio::pin!(search);
            tokio::select! {
                biased;
                result = &mut exact => match result {
                    Ok(Some(data)) => Some(data),
                    other => prefer_lyrics(other, search.await)?,
                },
                result = &mut search => match result {
                    Ok(Some(data)) if data["albumName"].as_str() == Some(t.album.as_str()) => Some(data),
                    other => prefer_lyrics(exact.await, other)?,
                },
            }
        },
    };
    let (synced_lrc,plain_lyrics,instrumental,provider_id)=if let Some(data)=found {
        (text(&data,"syncedLyrics"),text(&data,"plainLyrics"),data["instrumental"].as_bool().unwrap_or(false),data["id"].as_i64())
    } else { (None,None,false,None) };
    sqlx::query("INSERT INTO lyrics_cache (track_id,synced_lrc,plain_lyrics,instrumental,provider_id,fetched_at) VALUES (?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(track_id) DO UPDATE SET translated_lrc=CASE WHEN synced_lrc IS excluded.synced_lrc THEN translated_lrc ELSE NULL END,synced_lrc=excluded.synced_lrc,plain_lyrics=excluded.plain_lyrics,instrumental=excluded.instrumental,provider_id=excluded.provider_id,fetched_at=CURRENT_TIMESTAMP")
        .bind(&t.id).bind(&synced_lrc).bind(&plain_lyrics).bind(instrumental).bind(provider_id).execute(&state.db).await?;
    Ok(Json(Lyrics { track_id:t.id.clone(),status:status(&synced_lrc,&plain_lyrics,instrumental).into(),synced_lrc,plain_lyrics,instrumental,provider_id,source:"lrclib".into() }))
}
fn prefer_lyrics(exact: Result<Option<Value>, ApiError>, search: Result<Option<Value>, ApiError>) -> Result<Option<Value>, ApiError> {
    match (exact, search) {
        (Ok(Some(data)), _) | (_, Ok(Some(data))) => Ok(Some(data)),
        (Ok(None), Ok(None)) => Ok(None),
        (Err(error), _) | (_, Err(error)) => Err(error),
    }
}

#[derive(Serialize)]
pub struct Translation {
    translated_lrc: String,
    plain: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TranslationProvider { Mymemory, Deepseek, Google, Deepl }

#[derive(Deserialize)]
pub struct TranslationOptions {
    provider: Option<TranslationProvider>,
    lang: Option<String>,
}

pub async fn translate(
    State(state): State<AppState>, Path(id): Path<String>, Query(options): Query<TranslationOptions>, headers: HeaderMap,
) -> Result<Json<Translation>, ApiError> {
    let provider = options.provider.unwrap_or(TranslationProvider::Deepseek);
    let language = options.lang.as_deref().unwrap_or("ru");
    if language.len()!=2 || !language.bytes().all(|c| c.is_ascii_lowercase()) {
        return Err(ApiError::bad_request("Выберите язык перевода."));
    }
    let t = stored_track(&state, &id).await?;
    let cache = sqlx::query_as::<_, (Option<String>, Option<String>, Option<String>)>(
        "SELECT synced_lrc, plain_lyrics, translated_lrc FROM lyrics_cache WHERE track_id=? AND instrumental=0"
    ).bind(&t.id).fetch_optional(&state.db).await?;
    let Some((synced, plain_text, legacy)) = cache else {
        return Err(crate::llm::error(StatusCode::NOT_FOUND, "lyrics_missing", "У этой песни пока нет текста."));
    };
    let timed = synced.as_deref().map(timed_lines).filter(|(lines,_)| !lines.is_empty());
    let plain = timed.is_none();
    let source = if plain { plain_text.as_deref() } else { synced.as_deref() };
    let Some(source) = source else {
        return Err(crate::llm::error(StatusCode::NOT_FOUND, "lyrics_missing", "У этой песни пока нет текста."));
    };
    let provider_id = match provider { TranslationProvider::Mymemory => "mymemory", TranslationProvider::Deepseek => "deepseek", TranslationProvider::Google => "google", TranslationProvider::Deepl => "deepl" };
    let hash = hex::encode(Sha256::digest(&source));
    let cached = sqlx::query_scalar::<_, String>(
        "SELECT translated_lrc FROM lyrics_translations WHERE track_id=? AND provider=? AND target_language=? AND source_hash=?"
    ).bind(&t.id).bind(provider_id).bind(language).bind(&hash).fetch_optional(&state.db).await?;
    if let Some(translated_lrc) = cached.or_else(|| if !plain && language=="ru" && matches!(provider, TranslationProvider::Deepseek) { legacy } else { None }) {
        return Ok(Json(Translation { translated_lrc, plain }));
    }
    if crate::auth::session_user(&state, &headers).await?.is_none() {
        return Err(crate::auth::denied());
    }
    crate::auth::origin(&headers)?;
    let texts: Vec<_> = if let Some((lines,_))=&timed {
        lines.iter().map(|(_,text)|text.as_str()).collect()
    } else { source.lines().map(str::trim).filter(|text|!text.is_empty()).collect() };
    if texts.is_empty() || texts.len() > 250 || texts.iter().map(|text| text.len()).sum::<usize>() > 16_000 {
        return Err(crate::llm::error(StatusCode::UNPROCESSABLE_ENTITY, "unsupported_lyrics", "Этот текст пока не получится перевести."));
    }
    let translated = match provider {
        TranslationProvider::Deepseek => crate::llm::translate(&state, &texts, language).await?,
        TranslationProvider::Mymemory => free_translation(&state, &texts, language).await?,
        TranslationProvider::Google => crate::translation::google(&state,&texts,language).await?,
        TranslationProvider::Deepl => crate::translation::deepl(&state,&texts,language).await?,
    };
    let translated_lrc = if let Some((lines,offset))=timed {
        build_translation(&lines, offset, &translated)
    } else { translated.join("\n") };
    sqlx::query("INSERT INTO lyrics_translations(track_id,provider,target_language,source_hash,translated_lrc) VALUES(?,?,?,?,?)
        ON CONFLICT(track_id,provider,target_language) DO UPDATE SET source_hash=excluded.source_hash,translated_lrc=excluded.translated_lrc")
        .bind(&t.id).bind(provider_id).bind(language).bind(hash).bind(&translated_lrc).execute(&state.db).await?;
    Ok(Json(Translation { translated_lrc, plain }))
}

async fn free_translation(state: &AppState, lines: &[&str], language: &str) -> Result<Vec<String>, ApiError> {
    let unavailable = || crate::llm::error(StatusCode::BAD_GATEWAY, "free_translation_unavailable",
        "MyMemory не смог перевести текст. Выберите другой сервис в настройках.");
    let mut groups = vec![String::new()];
    for &line in lines {
        if line.len() > 500 { return Err(unavailable()); }
        let current = groups.last().unwrap();
        if current.len() + line.len() + usize::from(!current.is_empty()) > 500 { groups.push(String::new()); }
        let group = groups.last_mut().unwrap();
        if !group.is_empty() { group.push('\n'); }
        group.push_str(line);
    }
    let pair = format!("autodetect|{language}");
    let pair = pair.as_str();
    let mut pending = stream::iter(groups.into_iter().filter(|text| !text.is_empty()).map(|text: String| async move {
        let count = text.lines().count();
        let response = state.client.get("https://api.mymemory.translated.net/get")
            .query(&[("q", text.as_str()), ("langpair", pair)])
            .send().await.map_err(|_| unavailable())?;
        let data: Value = response.json().await.map_err(|_| unavailable())?;
        let status = data["responseStatus"].as_u64().or_else(|| data["responseStatus"].as_str()?.parse().ok());
        if status == Some(429) {
            return Err(crate::llm::error(StatusCode::TOO_MANY_REQUESTS, "free_translation_quota",
                "Бесплатный лимит MyMemory исчерпан. Выберите другой сервис в настройках."));
        }
        if status == Some(403) && data["responseDetails"].as_str().is_some_and(|message| message.eq_ignore_ascii_case("PLEASE SELECT TWO DISTINCT LANGUAGES")) {
            return Ok(text.lines().map(str::to_owned).collect());
        }
        if status != Some(200) { return Err(unavailable()); }
        let translation = data["responseData"]["translatedText"].as_str().ok_or_else(unavailable)?;
        let lines: Vec<_> = translation.lines().map(|line| {
            line.replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&")
                .replace(['[',']','<','>'], "").trim().to_owned()
        }).collect();
        if lines.len() != count || lines.iter().any(|line| line.is_empty() || line.len() > 1024) {
            return Err(unavailable());
        }
        Ok(lines)
    })).buffered(2);
    let mut translated = Vec::new();
    while let Some(group) = pending.next().await { translated.extend(group?); }
    Ok(translated)
}

pub(crate) async fn search_cached(state:&AppState,query:&str)->Result<Vec<Track>,ApiError>{
    let phrase=query.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    let rows=sqlx::query("SELECT track_id,synced_lrc,plain_lyrics FROM lyrics_cache WHERE instrumental=0 ORDER BY fetched_at DESC LIMIT 1500")
        .fetch_all(&state.db).await?;
    let mut tracks=Vec::new();
    for row in rows {
        let plain:Option<String>=row.get("plain_lyrics");
        let synced:Option<String>=row.get("synced_lrc");
        let lyric=plain.unwrap_or_else(||synced.map(|source|timed_lines(&source).0.into_iter()
            .map(|(_,text)|text).collect::<Vec<_>>().join(" ")).unwrap_or_default());
        let normalized=lyric.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
        if normalized.contains(&phrase){
            let id:String=row.get("track_id");
            tracks.push(stored_track(state,&id).await?);
            if tracks.len()>=8{break;}
        }
    }
    Ok(tracks)
}

fn timestamp(tag: &str) -> bool {
    let Some((min, tail)) = tag.split_once(':') else { return false; };
    let (sec, fraction) = tail.split_once(['.', ':']).map_or((tail, None), |(s, f)| (s, Some(f)));
    let digits = |s: &str| !s.is_empty() && s.len() <= 3 && s.bytes().all(|b| b.is_ascii_digit());
    digits(min) && sec.len() == 2 && digits(sec) && sec < "60" && fraction.is_none_or(digits)
}

fn timed_lines(source: &str) -> (Vec<(String, String)>, Option<&str>) {
    let mut offset = None;
    let mut timed = Vec::new();
    for line in source.lines() {
        let mut timestamps = String::new();
        let mut text = String::new();
        let mut rest = line;
        while !rest.is_empty() {
            if let Some(inner) = rest.strip_prefix('[') {
                if let Some((tag, suffix)) = inner.split_once(']') {
                    let len = tag.len() + 2;
                    if timestamp(tag) { timestamps.push_str(&rest[..len]); }
                    if offset.is_none() && tag.get(..7).is_some_and(|s| s.eq_ignore_ascii_case("offset:"))
                        && tag[7..].parse::<i32>().is_ok() {
                        offset = Some(&rest[..len]);
                    }
                    rest = suffix;
                    continue;
                }
            }
            if let Some(inner) = rest.strip_prefix('<') {
                if let Some((tag, suffix)) = inner.split_once('>') {
                    if timestamp(tag) { rest = suffix; continue; }
                }
            }
            let ch = rest.chars().next().unwrap();
            text.push(ch);
            rest = &rest[ch.len_utf8()..];
        }
        if !timestamps.is_empty() && !text.trim().is_empty() {
            timed.push((timestamps, text.trim().to_owned()));
        }
    }
    (timed, offset)
}

fn build_translation(timed: &[(String, String)], offset: Option<&str>, translated: &[String]) -> String {
    offset.into_iter().map(str::to_owned)
        .chain(timed.iter().zip(translated).map(|((prefix, _), text)| format!("{prefix}{text}")))
        .collect::<Vec<_>>().join("\n")
}

fn status(synced:&Option<String>,plain:&Option<String>,instrumental:bool)->&'static str {
    if instrumental {"instrumental"} else if synced.is_some() {"synced"} else if plain.is_some() {"plain"} else {"not_found"}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn translation_preserves_source_timestamps_and_offset() {
        let (lines, offset) = timed_lines("[offset:-75]\n[00:08.61]First <00:08.70>line\n[0:10][1:20:3]Repeat\n[00:09]\n[ar:Someone]");
        assert_eq!(lines[0].1, "First line");
        let rendered = build_translation(&lines, offset, &["Первая строка".into(),"Повтор".into()]);
        assert_eq!(rendered, "[offset:-75]\n[00:08.61]Первая строка\n[0:10][1:20:3]Повтор");
    }
    #[test]
    fn matches_original_not_cover_or_wrong_duration() {
        let t:Track=serde_json::from_value(serde_json::json!({"id":"deezer_42","deezer_id":42,"title":"Song (feat. Guest)","artist":"Artist","artist_id":1,"album":"Album","album_id":1,"cover_url":"","duration_sec":200,"is_explicit":false,"preview_url":""})).unwrap();
        assert!(matches(&serde_json::json!({"trackName":"Song","artistName":"Artist","duration":201}),&t));
        assert!(!matches(&serde_json::json!({"trackName":"Song","artistName":"Cover artist","duration":200}),&t));
        assert!(!matches(&serde_json::json!({"trackName":"Song","artistName":"Artist","duration":30}),&t));
    }
}
