use axum::{extract::State, http::{HeaderMap,header}, Json};
use hmac::{Hmac,Mac};
use sha2::{Sha256,Digest};
use serde_json::{Value,json};
use sqlx::Row;
use crate::{AppState,ApiError};
use std::time::{SystemTime,UNIX_EPOCH};
fn now()->i64{SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64}
pub(crate) fn denied()->ApiError{ApiError{status:axum::http::StatusCode::UNAUTHORIZED,code:"unauthorized",message:"Войдите через Telegram ещё раз."}}
pub(crate) fn origin(headers:&HeaderMap)->Result<(),ApiError>{let expected=std::env::var("PUBLIC_ORIGIN").unwrap_or_else(|_|"http://127.0.0.1:5173".into());if headers.get(header::ORIGIN).and_then(|v|v.to_str().ok())!=Some(expected.as_str()){return Err(denied());}Ok(())}
fn cookie(headers:&HeaderMap)->Option<&str>{headers.get(header::COOKIE)?.to_str().ok()?.split(';').find_map(|p|p.trim().strip_prefix("yamusic_session=")).filter(|s|s.len()==64&&s.bytes().all(|b|b.is_ascii_hexdigit()))}
fn digest(token:&str)->String{hex::encode(Sha256::digest(token.as_bytes()))}
pub async fn session_user(state:&AppState,headers:&HeaderMap)->Result<Option<i64>,ApiError>{let Some(token)=cookie(headers)else{return Ok(None);};Ok(sqlx::query_scalar("SELECT user_id FROM auth_sessions WHERE token_hash=? AND expires_at>?").bind(digest(token)).bind(now()).fetch_optional(&state.db).await?)}
pub async fn require_session(
    State(state): State<AppState>, request: axum::extract::Request, next: axum::middleware::Next,
) -> Result<axum::response::Response, ApiError> {
    if state.require_telegram {
        session_user(&state, request.headers()).await?.ok_or_else(denied)?;
    }
    let mut response = next.run(request).await;
    if state.require_telegram {
        response.headers_mut().insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    }
    Ok(response)
}
pub async fn config()->Json<Value>{let bot=std::env::var("TELEGRAM_BOT_USERNAME").unwrap_or_default();Json(json!({"enabled":!bot.is_empty()&&std::env::var("TELEGRAM_BOT_TOKEN").is_ok(),"bot_username":bot,"spotify":crate::spotify::enabled(),"google_translate":crate::translation::google_enabled(),"deepl":crate::translation::deepl_enabled()}))}
async fn profile(state:&AppState,id:i64)->Result<Value,ApiError>{let r=sqlx::query("SELECT id,telegram_id,first_name,username,avatar_url FROM users WHERE id=?").bind(id).fetch_one(&state.db).await?;Ok(json!({"id":r.get::<i64,_>("id"),"telegram_id":r.get::<Option<i64>,_>("telegram_id"),"first_name":r.get::<String,_>("first_name"),"username":r.get::<Option<String>,_>("username"),"avatar_url":r.get::<Option<String>,_>("avatar_url")}))}
pub async fn me(State(state):State<AppState>,headers:HeaderMap)->Result<(HeaderMap,Json<Value>),ApiError>{let mut h=HeaderMap::new();h.insert(header::CACHE_CONTROL,"no-store".parse().unwrap());Ok((h,Json(json!({"user":if let Some(id)=session_user(&state,&headers).await?{profile(&state,id).await?}else{Value::Null}}))))}
fn verify(data:&Value,token:&str,at:i64)->Result<(),ApiError>{
 let object=data.as_object().ok_or_else(denied)?;let auth=data["auth_date"].as_i64().ok_or_else(denied)?;
 if auth>at+30||at-auth>300||data["id"].as_i64().is_none_or(|n|n<=0){return Err(denied());}
 let signature=hex::decode(data["hash"].as_str().ok_or_else(denied)?).map_err(|_|denied())?;
 let mut lines=Vec::new();for(k,v)in object{if k=="hash"{continue;}let value=if let Some(s)=v.as_str(){s.to_owned()}else if v.is_number(){v.to_string()}else{return Err(denied());};if value.contains('\n'){return Err(denied());}lines.push(format!("{k}={value}"));}lines.sort();
 let mut mac=Hmac::<Sha256>::new_from_slice(&Sha256::digest(token.as_bytes())).map_err(|_|denied())?;mac.update(lines.join("\n").as_bytes());mac.verify_slice(&signature).map_err(|_|denied())
}
pub async fn login(State(state):State<AppState>,headers:HeaderMap,Json(data):Json<Value>)->Result<(HeaderMap,Json<Value>),ApiError>{
 origin(&headers)?;let token=std::env::var("TELEGRAM_BOT_TOKEN").map_err(|_|denied())?;verify(&data,&token,now())?;
 let first=data["first_name"].as_str().unwrap_or("");let username=data["username"].as_str();let photo=data["photo_url"].as_str().filter(|s|s.starts_with("https://"));
 if first.len()>256||username.is_some_and(|s|s.len()>64)||photo.is_some_and(|s|s.len()>2048){return Err(denied());}
 let mut tx=state.db.begin_with("BEGIN IMMEDIATE").await?;
 sqlx::query("DELETE FROM auth_login_receipts WHERE expires_at<?").bind(now()).execute(&mut *tx).await?;
 let used=sqlx::query("INSERT OR IGNORE INTO auth_login_receipts(hash,expires_at) VALUES (?,?)").bind(data["hash"].as_str().unwrap()).bind(now()+330).execute(&mut *tx).await?.rows_affected();if used==0{return Err(denied());}
 let id:i64=sqlx::query_scalar("INSERT INTO users(telegram_id,first_name,username,avatar_url) VALUES (?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET first_name=excluded.first_name,username=excluded.username,avatar_url=excluded.avatar_url RETURNING id").bind(data["id"].as_i64().unwrap()).bind(first).bind(username).bind(photo).fetch_one(&mut *tx).await?;
 let secret=hex::encode(rand::random::<[u8;32]>());sqlx::query("DELETE FROM auth_sessions WHERE expires_at<?").bind(now()).execute(&mut *tx).await?;
 sqlx::query("INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES (?,?,?)").bind(digest(&secret)).bind(id).bind(now()+30*86400).execute(&mut *tx).await?;tx.commit().await?;
 let secure=if std::env::var("PUBLIC_ORIGIN").unwrap_or_default().starts_with("https://"){"; Secure"}else{""};
 let mut response=HeaderMap::new();response.insert(header::SET_COOKIE,format!("yamusic_session={secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000{secure}").parse().unwrap());response.insert(header::CACHE_CONTROL,"no-store".parse().unwrap());
 Ok((response,Json(json!({"user":profile(&state,id).await?}))))
}
pub async fn logout(State(state):State<AppState>,headers:HeaderMap)->Result<(HeaderMap,Json<Value>),ApiError>{origin(&headers)?;if let Some(token)=cookie(&headers){sqlx::query("DELETE FROM auth_sessions WHERE token_hash=?").bind(digest(token)).execute(&state.db).await?;}let mut h=HeaderMap::new();h.insert(header::SET_COOKIE,"yamusic_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0".parse().unwrap());Ok((h,Json(json!({"ok":true}))))}
#[cfg(test)]mod tests{use super::*;#[test]fn signature_rejects_forgery_stale_and_future(){let token="test-token";let mut data=json!({"id":123,"auth_date":1000,"first_name":"Alice"});let mut mac=Hmac::<Sha256>::new_from_slice(&Sha256::digest(token.as_bytes())).unwrap();mac.update(b"auth_date=1000\nfirst_name=Alice\nid=123");data["hash"]=json!(hex::encode(mac.finalize().into_bytes()));assert!(verify(&data,token,1005).is_ok());assert!(verify(&data,token,2000).is_err());assert!(verify(&data,token,500).is_err());data["id"]=json!(124);assert!(verify(&data,token,1005).is_err());}}
