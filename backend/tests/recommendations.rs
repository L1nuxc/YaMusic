use axum::{Router,Json,routing::get};
use serde_json::{json,Value};
use yamusic_server::{AppState,app,connect_database,audio::AudioService,analysis::encode_vector};
use reqwest::{Client,StatusCode};

async fn serve(router:Router)->(String,tokio::task::JoinHandle<()>){
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let url=format!("http://{}",listener.local_addr().unwrap());
    let task=tokio::spawn(async move{axum::serve(listener,router).await.unwrap();});(url,task)
}
async fn event(client:&Client,url:&str,profile:&str,id:&str,action:&str,key:&str,session:Option<&str>)->reqwest::Response{
    client.post(format!("{url}/api/interactions")).header("X-YaMusic-Profile",profile).json(&json!({"track_id":id,"action":action,"event_id":key,"session_id":session,"listen_ratio":0.02,"listened_sec":2.})).send().await.unwrap()
}
#[tokio::test]
async fn reactions_are_idempotent_profiles_are_isolated_and_wave_refills(){
    let dir=tempfile::tempdir().unwrap();let db=connect_database(&format!("sqlite://{}",dir.path().join("test.db").to_string_lossy().replace('\\',"/"))).await.unwrap();
    let upstream=Router::new().route("/artist/{id}/radio",get(||async{Json(json!({"data":[]}))})).route("/artist/{id}/related",get(||async{Json(json!({"data":[]}))}));let(catalog,catalog_task)=serve(upstream).await;
    let mut state=AppState::new(db.clone(),catalog).unwrap();state.audio=AudioService::configured(db.clone(),dir.path().join("cache"),1024*1024,"missing-test-extractor".into());
    for i in 1..=80{
        let mut vector=vec![0f32;512];vector[if i==2{1}else{0}]=1.;
        sqlx::query("INSERT INTO tracks(id,deezer_id,title,artist,artist_id,album,album_id,duration_sec,embedding) VALUES (?,?,?,?,?,'Test album',1,100,?)")
            .bind(format!("deezer_{i}")).bind(i).bind(format!("Track {i}")).bind(format!("Artist {}",i%8)).bind(i%8).bind(encode_vector(&vector)).execute(&db).await.unwrap();
        state.analysis.vectors.write().unwrap().insert(format!("deezer_{i}"),vector);
    }
    let(url,task)=serve(app(state.clone(),dir.path().into())).await;let client=Client::new();let a="test-profile-aaaaaaaa";let b="test-profile-bbbbbbbb";
    assert_eq!(client.get(format!("{url}/api/recommendations/status")).send().await.unwrap().status(),StatusCode::BAD_REQUEST);
    for _ in 0..2{assert_eq!(event(&client,&url,a,"deezer_1","like","test-event-like-0001",None).await.status(),StatusCode::OK);}
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM interactions WHERE action_type='like'").fetch_one(&db).await.unwrap(),1);
    event(&client,&url,a,"deezer_1","unlike","test-event-unlike-01",None).await.error_for_status().unwrap();
    event(&client,&url,a,"deezer_1","like","test-event-like-0001",None).await.error_for_status().unwrap();
    let status:Value=client.get(format!("{url}/api/recommendations/status")).header("X-YaMusic-Profile",a).send().await.unwrap().json().await.unwrap();assert!(status["likes"].as_array().unwrap().is_empty(),"an old delivery retry must not undo an unlike");
    for(i,key)in [(1,"test-new-like-00001"),(2,"test-new-like-00002")]{event(&client,&url,a,&format!("deezer_{i}"),"like",key,None).await.error_for_status().unwrap();}
    event(&client,&url,a,"deezer_5","dislike","test-new-dislike-05",None).await.error_for_status().unwrap();
    let status:Value=client.get(format!("{url}/api/recommendations/status")).header("X-YaMusic-Profile",b).send().await.unwrap().json().await.unwrap();assert!(status["likes"].as_array().unwrap().is_empty());assert!(status["dislikes"].as_array().unwrap().is_empty());
    let first:Value=client.post(format!("{url}/api/wave")).header("X-YaMusic-Profile",a).json(&json!({})).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(first["tracks"].as_array().unwrap().len(),6);assert_eq!(first["personalized"],true);assert!(!first["tracks"].as_array().unwrap().iter().any(|t|t["id"]=="deezer_5"));let session=first["session_id"].as_str().unwrap();let current=first["tracks"][0]["id"].as_str().unwrap();
    assert_eq!(client.post(format!("{url}/api/wave/{session}/next")).header("X-YaMusic-Profile",b).json(&json!({"current_id":current})).send().await.unwrap().status(),StatusCode::NOT_FOUND);
    event(&client,&url,a,current,"early_skip","test-skip-event-0001",Some(session)).await.error_for_status().unwrap();let next=first["tracks"][1]["id"].as_str().unwrap();
    let second:Value=client.post(format!("{url}/api/wave/{session}/next")).header("X-YaMusic-Profile",a).json(&json!({"current_id":next})).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();assert_eq!(second["tracks"].as_array().unwrap().len(),6);assert_eq!(second["tracks"][0]["id"],next);assert!(!second["tracks"].as_array().unwrap().iter().any(|t|t["id"]==current));
    event(&client,&url,a,next,"early_skip","test-skip-event-0002",Some(session)).await.error_for_status().unwrap();
    let saved:String=sqlx::query_scalar("SELECT state_json FROM wave_sessions WHERE id=?").bind(session).fetch_one(&db).await.unwrap();let saved:Value=serde_json::from_str(&saved).unwrap();assert!(!saved["muted_clusters"].as_array().unwrap().is_empty());
    let fast_next=first["tracks"][3]["id"].as_str().unwrap();
    let raced=client.post(format!("{url}/api/wave/{session}/next")).header("X-YaMusic-Profile",a).json(&json!({"current_id":fast_next})).send().await.unwrap();assert_eq!(raced.status(),StatusCode::OK,"an already offered song remains valid after a fast skip races a tail rebuild");
    let invalid=client.post(format!("{url}/api/interactions")).header("X-YaMusic-Profile",a).json(&json!({"track_id":"deezer_1","action":"complete","event_id":"test-fake-end-event","listen_ratio":0.99,"listened_sec":2.})).send().await.unwrap();assert_eq!(invalid.status(),StatusCode::BAD_REQUEST);
    let daily:Value=client.get(format!("{url}/api/daily-mix")).header("X-YaMusic-Profile",a).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();let list=daily["tracks"].as_array().unwrap();assert_eq!(list.len(),50);for(i,t)in list.iter().enumerate(){assert!(!list[i.saturating_sub(3)..i].iter().any(|other|other["artist_id"]==t["artist_id"]));}
    let again:Value=client.get(format!("{url}/api/daily-mix")).header("X-YaMusic-Profile",a).send().await.unwrap().json().await.unwrap();assert_eq!(daily,again,"the complete daily mix stays fixed within the day");
    let data:Vec<(String,Vec<u8>)>=sqlx::query_as("SELECT id,embedding FROM tracks WHERE embedding IS NOT NULL").fetch_all(&db).await.unwrap();assert_eq!(data.len(),80);assert!(data.iter().all(|(_,v)|v.len()==2048));
    let personalized:Value=client.get(format!("{url}/api/mixes")).header("X-YaMusic-Profile",a)
        .send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    let playlists=personalized["mixes"].as_array().unwrap();
    let kinds:Vec<_>=playlists.iter().map(|playlist|playlist["id"].as_str().unwrap()).collect();
    assert_eq!(kinds,["daily","weekly","discovery","artist","style"]);
    assert_eq!(playlists[0]["tracks"],daily["tracks"]);
    for playlist in playlists {
        assert!(playlist["tracks"].as_array().unwrap().iter().all(|track| track["id"]!="deezer_5"));
    }
    assert!(playlists[2]["tracks"].as_array().unwrap().iter().all(|track| track["id"]!="deezer_1"&&track["id"]!="deezer_2"));
    task.abort();catalog_task.abort();db.close().await;
}

#[tokio::test]
async fn artist_preferences_are_canonical_isolated_and_rebuild_recommendations(){
    let dir=tempfile::tempdir().unwrap();let db=connect_database(&format!("sqlite://{}",dir.path().join("preferences.db").to_string_lossy().replace('\\',"/"))).await.unwrap();
    let upstream=Router::new()
        .route("/search/artist",get(||async{Json(json!({"data":[]}))}))
        .route("/artist/{id}/top",get(||async{Json(json!({"data":[]}))}))
        .route("/artist/{id}/radio",get(||async{Json(json!({"data":[]}))}))
        .route("/artist/{id}/related",get(||async{Json(json!({"data":[]}))}));
    let(catalog,catalog_task)=serve(upstream).await;let mut state=AppState::new(db.clone(),catalog).unwrap();
    state.audio=AudioService::configured(db.clone(),dir.path().join("cache"),1024*1024,"missing-test-extractor".into());
    // Artist 90 is an explicitly chosen foreign artist; Latin spelling in
    // editorial artist 1 still belongs to the Russian starting collection.
    for(id,name)in [(1,"Zivert"),(2,"Русский артист 2"),(3,"Русский артист 3"),(4,"Русский артист 4"),(90,"Foreign Favorite")]{
        sqlx::query("INSERT INTO catalog_artists(id,name,picture_url,data_json) VALUES (?,?,'','{}')").bind(id).bind(name).execute(&db).await.unwrap();
        if id!=90{sqlx::query("INSERT INTO editorial_artists(query,artist_id) VALUES (?,?)").bind(name).bind(id).execute(&db).await.unwrap();}
        for index in 0..15{
            let track_id=format!("deezer_{}",id*100+index);
            sqlx::query("INSERT INTO tracks(id,deezer_id,title,artist,artist_id,album,album_id,duration_sec) VALUES (?,?,?,?,?,'Album',1,200)")
                .bind(&track_id).bind(id*100+index).bind(format!("Song {index}")).bind(name).bind(id).execute(&db).await.unwrap();
            if id!=90{sqlx::query("INSERT INTO editorial_tracks(track_id) VALUES (?)").bind(track_id).execute(&db).await.unwrap();}
        }
    }
    let(url,task)=serve(app(state,dir.path().into())).await;let client=Client::new();let profile="preferences-profile-a";let other="preferences-profile-b";
    let daily:Value=client.get(format!("{url}/api/daily-mix")).header("X-YaMusic-Profile",profile).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(daily["tracks"].as_array().unwrap().len(),50);assert!(daily["tracks"].as_array().unwrap().iter().all(|t|t["artist_id"]!=90));
    let first:Value=client.post(format!("{url}/api/wave")).header("X-YaMusic-Profile",profile).json(&json!({})).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    let session=first["session_id"].as_str().unwrap();let current=first["tracks"][0]["id"].as_str().unwrap();
    let selected:Value=client.put(format!("{url}/api/recommendations/artists")).header("X-YaMusic-Profile",profile).json(&json!({"artist_ids":[90,90]})).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(selected["artists"].as_array().unwrap().len(),1);assert_eq!(selected["artists"][0]["name"],"Foreign Favorite");
    let restored:Value=client.get(format!("{url}/api/recommendations/artists")).header("X-YaMusic-Profile",profile).send().await.unwrap().json().await.unwrap();assert_eq!(restored,selected);
    let isolated:Value=client.get(format!("{url}/api/recommendations/artists")).header("X-YaMusic-Profile",other).send().await.unwrap().json().await.unwrap();assert!(isolated["artists"].as_array().unwrap().is_empty());
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM daily_mixes").fetch_one(&db).await.unwrap(),0,"artist edits invalidate fixed daily mixes");
    let saved:String=sqlx::query_scalar("SELECT state_json FROM wave_sessions WHERE id=?").bind(session).fetch_one(&db).await.unwrap();let saved:Value=serde_json::from_str(&saved).unwrap();assert_eq!(saved["rebuild_tail"],true);assert_eq!(saved["queue"][0],current);
    let rebuilt:Value=client.post(format!("{url}/api/wave/{session}/next")).header("X-YaMusic-Profile",profile).json(&json!({"current_id":current})).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(rebuilt["tracks"][0]["id"],current);assert!(rebuilt["tracks"].as_array().unwrap().iter().skip(1).any(|t|t["artist_id"]==90));assert_eq!(rebuilt["personalized"],true);
    let invalid=client.put(format!("{url}/api/recommendations/artists")).header("X-YaMusic-Profile",profile).json(&json!({"artist_ids":[-1]})).send().await.unwrap();assert_eq!(invalid.status(),StatusCode::BAD_REQUEST);
    let still_saved:Value=client.get(format!("{url}/api/recommendations/artists")).header("X-YaMusic-Profile",profile).send().await.unwrap().json().await.unwrap();assert_eq!(still_saved,selected);
    client.put(format!("{url}/api/recommendations/artists")).header("X-YaMusic-Profile",profile).json(&json!({"artist_ids":[]})).send().await.unwrap().error_for_status().unwrap();
    let cleared:Value=client.post(format!("{url}/api/wave")).header("X-YaMusic-Profile",profile).json(&json!({})).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();assert_eq!(cleared["personalized"],false);assert!(cleared["tracks"].as_array().unwrap().iter().all(|t|t["artist_id"]!=90));
    task.abort();catalog_task.abort();db.close().await;
}
