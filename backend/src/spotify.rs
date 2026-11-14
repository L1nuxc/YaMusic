use crate::{ApiError,AppState,auth,llm,music_import::spotify_id,smart_search::{Candidate,match_candidates}};
use axum::{Json,extract::{Query,State},http::{HeaderMap,StatusCode},response::Redirect};
use serde::Deserialize;
use serde_json::{Value,json};
use sha2::{Digest,Sha256};
use std::{collections::HashMap,time::{Duration,Instant}};

#[derive(Default)]
pub struct Connections {
    pending: HashMap<String,(i64,String,Instant)>,
    tokens: HashMap<i64,(String,Instant)>,
}

pub fn enabled() -> bool { client_id().is_some() }
fn client_id() -> Option<String> {
    std::env::var("SPOTIFY_CLIENT_ID").ok()
        .filter(|value|value.len()==32&&value.bytes().all(|c|c.is_ascii_hexdigit()))
}
fn redirect_uri() -> String {
    let origin=std::env::var("PUBLIC_ORIGIN").unwrap_or_else(|_|"http://127.0.0.1:5173".into());
    format!("{}/api/import/spotify/callback",origin.trim_end_matches('/'))
}
fn base64url(bytes:&[u8]) -> String {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    URL_SAFE_NO_PAD.encode(bytes)
}
fn configuration_error() -> ApiError {
    llm::error(StatusCode::SERVICE_UNAVAILABLE,"spotify_disabled","Импорт из аккаунта Spotify пока не подключён.")
}

pub async fn start(State(state):State<AppState>,headers:HeaderMap)->Result<Json<Value>,ApiError>{
    auth::origin(&headers)?;
    let user=auth::session_user(&state,&headers).await?.ok_or_else(auth::denied)?;
    let client=client_id().ok_or_else(configuration_error)?;
    let csrf=hex::encode(rand::random::<[u8;32]>());
    let verifier=hex::encode(rand::random::<[u8;32]>());
    let challenge=base64url(&Sha256::digest(verifier.as_bytes()));
    let mut url=reqwest::Url::parse("https://accounts.spotify.com/authorize").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("client_id",client.as_str()),("response_type","code"),("state",csrf.as_str()),
        ("code_challenge",challenge.as_str()),("code_challenge_method","S256"),
        ("scope","playlist-read-private playlist-read-collaborative user-library-read"),
        ("redirect_uri",&redirect_uri()),
    ]);
    let mut connections=state.spotify.lock().await;
    let now=Instant::now();
    connections.pending.retain(|_,(id,_,expiry)|*id!=user&&*expiry>now);
    connections.tokens.retain(|_,(_,expiry)|*expiry>now);
    connections.pending.insert(csrf,(user,verifier,now+Duration::from_secs(600)));
    Ok(Json(json!({"url":url.as_str()})))
}
#[derive(Deserialize)]
pub struct Callback { state:Option<String>,code:Option<String>,error:Option<String> }
pub async fn callback(State(state):State<AppState>,headers:HeaderMap,Query(query):Query<Callback>)->Redirect {
    let outcome=finish_callback(&state,&headers,query).await;
    let status=match outcome {Ok(())=>"connected",Err("denied")=>"denied",Err(_)=>"failed"};
    Redirect::to(&format!("/?spotify={status}#/library"))
}
async fn finish_callback(state:&AppState,headers:&HeaderMap,query:Callback)->Result<(),&'static str>{
    let user=auth::session_user(state,headers).await.ok().flatten().ok_or("session")?;
    let key=query.state.ok_or("state")?;
    let verifier={
        let mut connections=state.spotify.lock().await;
        if !connections.pending.get(&key).is_some_and(|(id,_,until)|*id==user&&*until>Instant::now()){return Err("state");}
        connections.pending.remove(&key).unwrap().1
    };
    if query.error.is_some(){return Err("denied");}
    let code=query.code.ok_or("code")?;
    let client=client_id().ok_or("config")?;
    let response=state.client.post("https://accounts.spotify.com/api/token").form(&[
        ("grant_type","authorization_code"),("client_id",client.as_str()),("code",code.as_str()),
        ("redirect_uri",&redirect_uri()),("code_verifier",&verifier),
    ]).send().await.map_err(|_|"token")?.error_for_status().map_err(|_|"token")?;
    let token:Value=response.json().await.map_err(|_|"token")?;
    let access=token["access_token"].as_str().filter(|s|!s.is_empty()).ok_or("token")?;
    let expiry=token["expires_in"].as_u64().unwrap_or(3600).min(3600);
    state.spotify.lock().await.tokens.insert(user,(access.to_owned(),Instant::now()+Duration::from_secs(expiry)));
    Ok(())
}
pub async fn disconnect(State(state):State<AppState>,headers:HeaderMap)->Result<Json<Value>,ApiError>{
    auth::origin(&headers)?;
    let user=auth::session_user(&state,&headers).await?.ok_or_else(auth::denied)?;
    let mut connections=state.spotify.lock().await;
    connections.tokens.remove(&user);
    connections.pending.retain(|_,(id,_,_)|*id!=user);
    Ok(Json(json!({"ok":true})))
}

async fn token(state:&AppState,user:i64)->Option<String>{
    state.spotify.lock().await.tokens.get(&user)
        .filter(|(_,until)|*until>Instant::now()).map(|(token,_)|token.clone())
}
async fn request(state:&AppState,user:i64,access:&str,path:&str,offset:u32,limit:u32)->Result<Value,ApiError>{
    let unavailable=||llm::error(StatusCode::BAD_GATEWAY,"spotify_unavailable","Spotify временно недоступен.");
    let response=state.client.get(format!("https://api.spotify.com/v1/{path}")).bearer_auth(access)
        .query(&[("limit",limit),("offset",offset)]).send().await.map_err(|_|unavailable())?;
    match response.status().as_u16(){
        200=>response.json().await.map_err(|_|unavailable()),
        401=>{
            state.spotify.lock().await.tokens.remove(&user);
            Err(llm::error(StatusCode::CONFLICT,"spotify_expired","Подключите Spotify ещё раз."))
        },
        403|404=>Err(llm::error(StatusCode::FORBIDDEN,"spotify_playlist_access","Spotify не дал доступ. Выберите свой плейлист или тот, где вы соавтор.")),
        429=>Err(llm::error(StatusCode::TOO_MANY_REQUESTS,"spotify_rate_limit","Spotify ограничил частоту запросов. Попробуйте чуть позже.")),
        _=>Err(unavailable())
    }
}
#[derive(Deserialize)]
pub struct Page { offset: Option<u32> }
pub async fn playlists(State(state):State<AppState>,headers:HeaderMap,Query(page):Query<Page>)->Result<Json<Value>,ApiError>{
    let user=auth::session_user(&state,&headers).await?.ok_or_else(auth::denied)?;
    let Some(access)=token(&state,user).await else {return Ok(Json(json!({"connected":false,"playlists":[]})));};
    let offset=page.offset.unwrap_or(0);
    if offset>100_000{return Err(ApiError::bad_request("Неверная страница Spotify."));}
    let data=request(&state,user,&access,"me/playlists",offset,50).await?;
    let playlists:Vec<_>=data["items"].as_array().into_iter().flatten().filter_map(|row|{
        Some(json!({"id":row["id"].as_str()?,"name":row["name"].as_str()?}))
    }).collect();
    Ok(Json(json!({"connected":true,"playlists":playlists,"next_offset":next_offset(&data,offset)})))
}
fn next_offset(data:&Value,offset:u32)->Option<u32>{
    data["next"].as_str()?;
    let size=data["items"].as_array()?.len() as u32;
    (size>0).then_some(offset+size)
}
#[derive(Deserialize)]
pub struct ImportPage { playlist:String,offset:u32 }
pub async fn page(State(state):State<AppState>,headers:HeaderMap,Json(page):Json<ImportPage>)->Result<Json<Value>,ApiError>{
    auth::origin(&headers)?;
    let user=auth::session_user(&state,&headers).await?.ok_or_else(auth::denied)?;
    let access=token(&state,user).await.ok_or_else(||llm::error(StatusCode::CONFLICT,"spotify_expired","Подключите Spotify ещё раз."))?;
    let path=if page.playlist=="saved" {"me/tracks".into()} else {
        let id=if page.playlist.len()==22&&page.playlist.bytes().all(|c|c.is_ascii_alphanumeric()){
            Some(page.playlist)
        } else {spotify_id(&page.playlist)};
        format!("playlists/{}/items",id.ok_or_else(||ApiError::bad_request("Укажите ссылку на плейлист Spotify."))?)
    };
    if page.offset>100_000{return Err(ApiError::bad_request("Неверная страница Spotify."));}
    let data=request(&state,user,&access,&path,page.offset,50).await?;
    let items=data["items"].as_array().ok_or_else(||ApiError::provider("invalid Spotify playlist page".into()))?;
    let candidates:Vec<_>=items.iter().map(|entry|{
        let item=entry.get("item").filter(|item|!item.is_null()).or_else(||entry.get("track"))?;
        if item["type"]!="track" || item["is_local"]==true{return None;}
        let title=item["name"].as_str()?.to_owned();
        let artist=item["artists"][0]["name"].as_str()?.to_owned();
        Some(Candidate{title,artist})
    }).collect();
    let unavailable=candidates.iter().filter(|entry|entry.is_none()).count();
    let (tracks,missing)=match_candidates(&state,candidates.into_iter().flatten().collect(),50).await?;
    Ok(Json(json!({"tracks":tracks,"missing":missing,"unavailable":unavailable,"checked":items.len(),"total":data["total"],"next_offset":next_offset(&data,page.offset)})))
}
