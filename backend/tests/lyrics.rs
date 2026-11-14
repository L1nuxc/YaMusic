use axum::{Router,Json,routing::get};
use serde_json::{json,Value};
use yamusic_server::{AppState,app,connect_database};
async fn serve(router:Router)->(String,tokio::task::JoinHandle<()>) {
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let url=format!("http://{}",listener.local_addr().unwrap());
    (url,tokio::spawn(async move{axum::serve(listener,router).await.unwrap();}))
}
#[tokio::test]
async fn lyrics_use_original_duration_and_survive_provider_outage_in_cache(){
    let dir=tempfile::tempdir().unwrap();let db=connect_database(&format!("sqlite://{}",dir.path().join("test.db").to_string_lossy().replace('\\',"/"))).await.unwrap();
    sqlx::query("INSERT INTO tracks (id,deezer_id,title,artist,artist_id,album,album_id,duration_sec) VALUES ('deezer_42',42,'Song','Artist',7,'Album',9,200)").execute(&db).await.unwrap();
    let provider=Router::new().route("/api/get",get(|axum::extract::Query(query):axum::extract::Query<std::collections::HashMap<String,String>>|async move{
        assert_eq!(query.get("duration").map(String::as_str),Some("200"));
        Json(json!({"id":12,"trackName":"Song","artistName":"Artist","albumName":"Album","duration":200,"instrumental":false,"syncedLyrics":"[00:01.00]An invented test line","plainLyrics":"An invented test line"}))
    }));
    let (provider_url,provider_task)=serve(provider).await;
    let mut state=AppState::new(db.clone(),"http://invalid.example".into()).unwrap();state.lyrics_base=provider_url;
    let (url,server)=serve(app(state,dir.path().into())).await;let client=reqwest::Client::new();
    let first:Value=client.get(format!("{url}/api/lyrics/deezer_42")).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(first["status"],"synced");assert_eq!(first["provider_id"],12);
    provider_task.abort();
    let cached:Value=client.get(format!("{url}/api/lyrics/deezer_42")).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(cached,first);
    sqlx::query("UPDATE lyrics_cache SET translated_lrc=? WHERE track_id='deezer_42'")
        .bind("[00:01.00]Тестовая строка").execute(&db).await.unwrap();
    let translated: Value=client.post(format!("{url}/api/lyrics/deezer_42/translation")).send().await.unwrap()
        .error_for_status().unwrap().json().await.unwrap();
    assert_eq!(translated["translated_lrc"], "[00:01.00]Тестовая строка");
    assert_eq!(client.post(format!("{url}/api/prefetch")).json(&json!({"ids":["invalid"]})).send().await.unwrap().status(),reqwest::StatusCode::BAD_REQUEST);
    server.abort();db.close().await;
}
