use crate::{ApiError, AppState, Track, auth};
use axum::{Json, extract::State, http::{HeaderMap, header}};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashMap, time::{SystemTime, UNIX_EPOCH}};

const LEASE_MS: u64 = 12_000;

#[derive(Clone, Deserialize, Serialize)]
pub struct Playback {
    track: Track,
    queue: Vec<Track>,
    context: Option<String>,
    position: f64,
    playing: bool,
    volume: f64,
    shuffle: bool,
    repeat: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Command {
    action: String,
    value: Option<f64>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Event {
    Pulse { playback: Option<Playback>, revision: u64, #[serde(default)] start: bool },
    Transfer { target: String, revision: u64 },
    Control { command: Command, revision: u64 },
    Leave,
}

#[derive(Deserialize)]
pub struct DeviceRequest {
    id: String,
    label: String,
    #[serde(flatten)]
    event: Event,
}

#[derive(Serialize)]
struct Device {
    label: String,
    #[serde(skip)]
    seen: u64,
}

#[derive(Default)]
pub struct AccountDevices {
    clients: HashMap<String, Device>,
    active: Option<String>,
    playback: Option<Playback>,
    updated_at: u64,
    revision: u64,
    commands: Vec<Command>,
    waiting_for: Option<(String, u64)>,
}

fn valid_id(value: &str) -> bool {
    value.len() == 36 && value.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
}

pub async fn sync(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<DeviceRequest>)
    -> Result<(HeaderMap, Json<Value>), ApiError>
{
    auth::origin(&headers)?;
    let user = auth::session_user(&state, &headers).await?.ok_or_else(auth::denied)?;
    if !valid_id(&body.id) || !(1..=80).contains(&body.label.chars().count()) {
        return Err(ApiError::bad_request("Неизвестное устройство."));
    }
    let current_time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let mut accounts = state.devices.lock().await;
    accounts.retain(|_, account| account.clients.values().any(|client| current_time.saturating_sub(client.seen) < 60_000));
    let account = accounts.entry(user).or_default();
    account.clients.retain(|_, device| current_time.saturating_sub(device.seen) < LEASE_MS);
    if account.active.as_ref().is_some_and(|id| !account.clients.contains_key(id)) {
        account.active = None;
        account.commands.clear();
        account.revision += 1;
    }
    if !matches!(body.event, Event::Leave) {
        account.clients.insert(body.id.clone(), Device { label:body.label, seen:current_time });
    }
    let mut commands = Vec::new();
    match body.event {
        Event::Pulse { playback, revision, start } => {
            if account.waiting_for.as_ref().is_some_and(|(id,_)| id==&body.id) && revision==account.revision {
                account.waiting_for = None;
            }
            if (account.active.is_none() || account.active.as_deref()==Some(&body.id)) && account.waiting_for.is_none() {
                if let Some(mut playback) = playback.filter(|p| p.queue.len()<=250 && p.position.is_finite() &&
                    p.position>=0.0 && (0.0..=1.0).contains(&p.volume) && matches!(p.repeat.as_str(),"off" | "one" | "all"))
                {
                    if (start && account.active.is_none() && playback.playing) ||
                        (account.active.as_deref()==Some(&body.id) && revision==account.revision) {
                        if account.active.is_none() { account.revision += 1; }
                        playback.position=playback.position.min(playback.track.duration_sec.max(0) as f64);
                        account.active=Some(body.id.clone());
                        account.updated_at=current_time;
                        account.playback=Some(playback);
                    }
                }
                if account.active.as_deref()==Some(&body.id) && revision==account.revision {
                    commands=std::mem::take(&mut account.commands);
                }
            }
        }
        Event::Transfer { target, revision } => {
            if revision==account.revision && account.waiting_for.is_none() && account.clients.contains_key(&target) &&
                account.active.as_deref()!=Some(&target) && account.playback.is_some() {
                if let Some(old) = &account.active {
                    if let Some(playback) = account.playback.as_mut().filter(|p| p.playing) {
                        playback.position=(playback.position+current_time.saturating_sub(account.updated_at) as f64/1000.0)
                            .min(playback.track.duration_sec.max(0) as f64);
                    }
                    account.waiting_for=Some((old.clone(),current_time+4_500));
                }
                account.updated_at=current_time;
                account.active=Some(target);
                account.commands.clear();
                account.revision+=1;
            }
        }
        Event::Control { command, revision } => {
            if revision==account.revision && account.active.is_some() && account.commands.len()<32 &&
                matches!(command.action.as_str(), "toggle" | "next" | "previous" | "seek" | "volume" | "shuffle" | "repeat" | "queued") {
                account.commands.push(command);
            }
        }
        Event::Leave => {
            account.clients.remove(&body.id);
            if account.active.as_deref()==Some(&body.id) {
                account.active=None;
                account.commands.clear();
                account.revision+=1;
            }
        }
    }
    if account.waiting_for.as_ref().is_some_and(|(_,until)| current_time>=*until) {
        account.waiting_for=None;
    }
    let playback=account.active.as_ref().and(account.playback.as_ref());
    let mut cache=HeaderMap::new();
    cache.insert(header::CACHE_CONTROL,"private, no-store".parse().unwrap());
    Ok((cache,Json(json!({
        "active":account.active,"devices":account.clients,"playback":playback,
        "revision":account.revision,"age":current_time.saturating_sub(account.updated_at),
        "transferring":account.waiting_for.is_some(),"commands":commands,
    }))))
}
