use axum::{Router, Json, routing::get};
use reqwest::StatusCode;
use serde_json::{json, Value};
use yamusic_server::{AppState, app, connect_database};

fn fixture_track() -> Value {
    json!({"id":42,"title":"Test song","duration":217,"explicit_lyrics":true,"preview":"https://cdnt-preview.dzcdn.net/fixture.mp3","artist":{"id":7,"name":"Test artist"},"album":{"id":9,"title":"Test album","cover_big":"https://cdn-images.dzcdn.net/fixture.jpg"}})
}
fn detailed_track() -> Value {
    let mut track = fixture_track();
    track["contributors"] = json!([
        {"id":7,"name":"Test artist","role":"Main"},
        {"id":8,"name":"GreyRock","role":"Main"},
        {"id":10,"name":"Guest","role":"Featured"},
        {"id":8,"name":"GreyRock","role":"Main"}
    ]);
    track
}
async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}",listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener,router).await.unwrap(); });
    (url,task)
}
#[tokio::test]
async fn catalog_request_persists_real_normalized_metadata_and_rejects_invalid_inputs() {
    let dir = tempfile::tempdir().unwrap();
    let db_url = format!("sqlite://{}",dir.path().join("test.db").to_string_lossy().replace('\\',"/"));
    let db = connect_database(&db_url).await.unwrap();
    let mode: String = sqlx::query_scalar("PRAGMA journal_mode").fetch_one(&db).await.unwrap();
    assert_eq!(mode,"wal");
    let upstream = Router::new()
        .route("/search/track",get(|| async { Json(json!({"data":[fixture_track()],"total":1})) }))
        .route("/search/artist",get(|| async { Json(json!({"data":[{"id":7,"name":"Test artist","picture_big":"https://cdn-images.dzcdn.net/artist.jpg"}],"total":1})) }))
        .route("/search/album",get(|| async { Json(json!({"data":[{"id":9,"title":"Test album","artist":{"id":7,"name":"Test artist"},"cover_big":"https://cdn-images.dzcdn.net/fixture.jpg"}],"total":1})) }))
        .route("/track/{id}",get(|| async { Json(detailed_track()) }));
    let (catalog_url,upstream_task) = serve(upstream).await;
    let mut state = AppState::new(db.clone(),catalog_url).unwrap();
    state.audio = yamusic_server::audio::AudioService::configured(db.clone(),dir.path().join("audio"),1024,"missing-test-resolver".into());
    let (url,server_task) = serve(app(state,dir.path().into())).await;
    let client = reqwest::Client::new();
    let response = client.get(format!("{url}/api/search")).query(&[("q","test")]).send().await.unwrap();
    assert_eq!(response.status(),StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["tracks"][0]["id"],"deezer_42");
    assert_eq!(body["tracks"][0]["is_explicit"],true);
    assert_eq!(body["tracks"][0]["contributors"].as_array().unwrap().len(),3);
    assert_eq!(body["tracks"][0]["contributors"][1]["name"],"GreyRock");
    assert_eq!(body["tracks"][0]["contributors"][1]["id"],8);
    assert_eq!(body["albums"][0]["id"],9);
    assert_eq!(body["artists"][0]["name"],"Test artist");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM tracks WHERE id='deezer_42'").fetch_one(&db).await.unwrap();
    assert_eq!(count,1);
    // A second cached request must upsert, not duplicate or erase future embeddings.
    sqlx::query("UPDATE tracks SET embedding=zeroblob(2048) WHERE id='deezer_42'").execute(&db).await.unwrap();
    client.get(format!("{url}/api/search?q=test")).send().await.unwrap().error_for_status().unwrap();
    let size: i64 = sqlx::query_scalar("SELECT length(embedding) FROM tracks WHERE id='deezer_42'").fetch_one(&db).await.unwrap();
    assert_eq!(size,2048);
    let credits: String = sqlx::query_scalar("SELECT contributors_json FROM tracks WHERE id='deezer_42'").fetch_one(&db).await.unwrap();
    assert_eq!(serde_json::from_str::<Value>(&credits).unwrap().as_array().unwrap().len(),3,"compact search must not erase detailed credits");
    for query in ["q=", "q=test&limit=0", "q=test&limit=51", "q=test&type=unknown", "q=test&index=10001"] {
        assert_eq!(client.get(format!("{url}/api/search?{query}")).send().await.unwrap().status(),StatusCode::BAD_REQUEST);
    }
    assert_eq!(client.get(format!("{url}/api/tracks/invalid")).send().await.unwrap().status(),StatusCode::BAD_REQUEST);
    assert_eq!(client.get(format!("{url}/api/does-not-exist")).send().await.unwrap().status(),StatusCode::NOT_FOUND);
    let no_redirect = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let preview = no_redirect.get(format!("{url}/api/preview/deezer_42")).send().await.unwrap();
    assert_eq!(preview.status(),StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(preview.headers()["location"],"https://cdnt-preview.dzcdn.net/fixture.mp3");
    // The internal analysis preview exists, but listening never falls back to it.
    for endpoint in ["playback", "stream"] {
        let unavailable = no_redirect.get(format!("{url}/api/{endpoint}/deezer_42")).send().await.unwrap();
        assert_eq!(unavailable.status(),StatusCode::SERVICE_UNAVAILABLE);
        assert!(!unavailable.headers().contains_key("location"));
        let body: Value = unavailable.json().await.unwrap();
        assert_eq!(body["error"]["code"],"full_audio_unavailable");
    }
    server_task.abort(); upstream_task.abort(); db.close().await;
}

#[tokio::test]
async fn sparse_artist_top_is_extended_with_verified_solo_and_collaboration_tracks() {
    let dir = tempfile::tempdir().unwrap();
    let db = connect_database(&format!("sqlite://{}",dir.path().join("test.db").to_string_lossy().replace('\\',"/"))).await.unwrap();
    let upstream = Router::new()
        .route("/artist/8",get(||async{Json(json!({"id":8,"name":"GreyRock"}))}))
        .route("/artist/8/top",get(||async{Json(json!({"data":[]}))}))
        .route("/artist/8/albums",get(||async{Json(json!({"data":[{"id":9,"title":"Collaboration"}]}))}))
        .route("/album/9",get(||async{
            let mut other=fixture_track();other["id"]=json!(43);
            Json(json!({"id":9,"title":"Collaboration","artist":{"id":7,"name":"Test artist"},"tracks":{"data":[fixture_track(),other]}}))
        }))
        .route("/track/{id}",get(|axum::extract::Path(id): axum::extract::Path<u64>|async move{
            let mut track = if id==42 {detailed_track()} else {fixture_track()};
            track["id"]=json!(id);Json(track)
        }));
    let (catalog_url,upstream_task)=serve(upstream).await;
    let mut state=AppState::new(db.clone(),catalog_url).unwrap();
    state.audio=yamusic_server::audio::AudioService::configured(db.clone(),dir.path().join("audio"),1024,"missing-test-resolver".into());
    let (url,server_task)=serve(app(state,dir.path().into())).await;
    let body: Value=reqwest::get(format!("{url}/api/artists/8")).await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(body["artist"]["name"],"GreyRock");
    assert_eq!(body["tracks_source"],"top_and_discography");
    let tracks=body["tracks"].as_array().unwrap();
    assert_eq!(tracks.len(),1,"exclude album tracks that do not actually credit this artist");
    assert_eq!(tracks[0]["id"],"deezer_42");
    assert_eq!(tracks[0]["artist_id"],7,"preserve the collaboration's original primary artist");
    server_task.abort();upstream_task.abort();db.close().await;
}
