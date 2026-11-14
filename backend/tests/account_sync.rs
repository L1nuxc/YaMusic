use axum::{Router, body::Body, http::{Request, StatusCode}};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use yamusic_server::{AppState, app, connect_database};

const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PC: &str = "00000000-0000-4000-8000-000000000001";
const PHONE: &str = "00000000-0000-4000-8000-000000000002";

async fn fixture() -> (Router, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("sync.sqlite").to_string_lossy().replace('\\', "/");
    let db = connect_database(&format!("sqlite://{file}")).await.unwrap();
    sqlx::query("INSERT INTO users(id,telegram_id,first_name) VALUES(1,2026,'Test')")
        .execute(&db).await.unwrap();
    sqlx::query("INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,1,4102444800)")
        .bind(hex::encode(Sha256::digest(TOKEN))).execute(&db).await.unwrap();
    (app(AppState::new(db,"http://127.0.0.1:1".into()).unwrap(),dir.path().into()),dir)
}

async fn request(router: &Router, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let origin=std::env::var("PUBLIC_ORIGIN").unwrap_or_else(|_|"http://127.0.0.1:5173".into());
    let request=Request::builder().method(if body.is_some(){"POST"}else{"GET"}).uri(path)
        .header("cookie",format!("yamusic_session={TOKEN}")).header("origin",origin)
        .header("content-type","application/json")
        .body(body.map_or_else(Body::empty,|b|Body::from(b.to_string()))).unwrap();
    let response=router.clone().oneshot(request).await.unwrap();
    let status=response.status();
    let bytes=axum::body::to_bytes(response.into_body(),1024*1024).await.unwrap();
    (status,serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn legacy_migration_preserves_server_settings_and_deleted_playlists() {
    let (router,_dir)=fixture().await;
    let path="/api/account/library";
    let update=json!({"id":"saved","entries":{"playlist:deleted":null,"theme":"dark"}});
    assert_eq!(request(&router,path,Some(update)).await.0,StatusCode::OK);
    let migration=json!({"id":"migration","import_legacy":true,"entries":{
        "playlist:deleted":{"id":"deleted","title":"Old","tracks":[]},
        "playlist:retained":{"id":"retained","title":"From the browser","tracks":[]},
        "theme":"light"}});
    for _ in 0..2 { assert_eq!(request(&router,path,Some(migration.clone())).await.0,StatusCode::OK); }
    let (_,library)=request(&router,path,None).await;
    assert_eq!(library["entries"]["theme"],"dark");
    assert_eq!(library["entries"]["playlist:deleted"],Value::Null);
    assert_eq!(library["entries"]["playlist:retained"]["title"],"From the browser");
}

#[tokio::test]
async fn transfer_waits_for_the_old_player_and_forwards_remote_control() {
    let (router,_dir)=fixture().await;
    let path="/api/playback/devices";
    let track=json!({"id":"deezer_1","deezer_id":1,"title":"Track","artist":"Artist","artist_id":1,
        "album":"Album","album_id":1,"cover_url":"","duration_sec":240,"is_explicit":false,"preview_url":""});
    let playback=json!({"track":track,"queue":[track],"position":35,"playing":true,"volume":0.4,"shuffle":false,"repeat":"off"});
    let (status,started)=request(&router,path,Some(json!({"id":PC,"label":"ПК","kind":"pulse","revision":0,"start":true,"playback":playback}))).await;
    assert_eq!(status,StatusCode::OK);
    assert_eq!(started["active"],PC);
    let (_,remote)=request(&router,path,Some(json!({"id":PHONE,"label":"Телефон","kind":"pulse","revision":0}))).await;
    assert_eq!(remote["active"],PC);
    assert_eq!(remote["playback"]["position"],35.0);
    let (_,transfer)=request(&router,path,Some(json!({"id":PHONE,"label":"Телефон","kind":"transfer","target":PHONE,"revision":remote["revision"]}))).await;
    assert_eq!(transfer["active"],PHONE);
    assert_eq!(transfer["transferring"],true);
    let (_,old)=request(&router,path,Some(json!({"id":PC,"label":"ПК","kind":"pulse","revision":remote["revision"],"playback":playback}))).await;
    assert_eq!(old["transferring"],true);
    let (_,stopped)=request(&router,path,Some(json!({"id":PC,"label":"ПК","kind":"pulse","revision":transfer["revision"]}))).await;
    assert_eq!(stopped["transferring"],false);
    request(&router,path,Some(json!({"id":PC,"label":"ПК","kind":"control","revision":transfer["revision"],"command":{"action":"seek","value":42}}))).await;
    let (_,taken)=request(&router,path,Some(json!({"id":PHONE,"label":"Телефон","kind":"pulse","revision":transfer["revision"],"playback":playback}))).await;
    assert_eq!(taken["commands"][0]["value"],42.0);
}
