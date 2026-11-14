use crate::{AppState,ApiError,Track,Artist,analysis::{Vector,cosine,normalize,encode_vector}};
use futures_util::{stream,StreamExt,TryStreamExt};
use axum::{Json,extract::{State,Path,Query},http::HeaderMap};
use linfa::{DatasetBase,traits::{Fit,Predict}};
use linfa_clustering::KMeans;
use ndarray::Array2;
use serde::{Deserialize,Serialize};
use serde_json::{Value,json};
use sqlx::Row;
use std::{collections::{HashMap,HashSet},sync::atomic::Ordering};

// A deliberately varied starting collection, not a claim about chart positions.
// Search results must exactly match the requested name before they become seeds.
const EDITORIAL_ARTISTS:&[&str]=&[
    "Кино","Земфира","Баста","Моя Мишель","Мот","Сплин","ЛСП","Zivert",
    "Скриптонит","Три дня дождя","Макс Корж","Мумий Тролль","ANNA ASTI","Би-2",
    "Дайте танк (!)","Комната культуры","Мельница","Хаски","Noize MC","ATL",
    "PHARAOH","Markul","OG Buda","SALUKI","FEDUK","Многоточие","polnalyubvi",
    "ssshhhiiittt!","Дора","Мэйби Бэйби","Моя дорогая","IC3PEAK","Gone.Fludd",
    "Miyagi & Andy Panda","Rauf & Faik","МОНЕТОЧКА",
];
fn name_key(name:&str)->String{name.chars().filter(|c|c.is_alphanumeric()).flat_map(char::to_lowercase).collect()}
async fn favorite_list(state:&AppState,uid:i64)->Result<Vec<Artist>,ApiError>{
    let rows=sqlx::query("SELECT a.id,a.name,a.picture_url FROM favorite_artists f JOIN catalog_artists a ON a.id=f.artist_id WHERE f.user_id=? ORDER BY f.position").bind(uid).fetch_all(&state.db).await?;
    Ok(rows.into_iter().map(|r|Artist{id:r.get("id"),name:r.get("name"),picture_url:r.get("picture_url")}).collect())
}
pub async fn artists(State(state):State<AppState>,headers:HeaderMap)->Result<Json<Value>,ApiError>{
    let uid=user(&state,&headers).await?;Ok(Json(json!({"artists":favorite_list(&state,uid).await?})))
}
#[derive(Deserialize)]pub struct ArtistPreferences{artist_ids:Vec<i64>}
async fn canonical_artist(state:&AppState,id:i64)->Result<Artist,ApiError>{
    if let Some(row)=sqlx::query("SELECT id,name,picture_url FROM catalog_artists WHERE id=?").bind(id).fetch_optional(&state.db).await?{
        return Ok(Artist{id:row.get("id"),name:row.get("name"),picture_url:row.get("picture_url")});
    }
    let data=state.catalog(&format!("/artist/{id}"),&[]).await?;let artist=crate::normalize_artist(&data);
    if artist.id!=id||artist.name.trim().is_empty(){return Err(ApiError::not_found());}Ok(artist)
}
async fn artist_top(state:&AppState,id:i64,editorial:bool)->Result<Vec<Track>,ApiError>{
    let data=state.catalog(&format!("/artist/{id}/top"),&[("limit","12".into())]).await?;
    let tracks:Vec<_>=crate::items(&data).iter().filter_map(crate::normalize_track).filter(|t|t.artist_id==id||t.contributors.iter().any(|a|a.id==id)).collect();
    crate::save_tracks(&state.db,&tracks).await?;
    if editorial{let mut tx=state.db.begin().await?;for t in &tracks{sqlx::query("INSERT OR IGNORE INTO editorial_tracks(track_id) VALUES (?)").bind(&t.id).execute(&mut *tx).await?;}tx.commit().await?;}
    state.analysis.enqueue(tracks.iter().map(|t|t.id.clone()),false);Ok(tracks)
}
pub async fn set_artists(State(state):State<AppState>,headers:HeaderMap,Json(body):Json<ArtistPreferences>)->Result<Json<Value>,ApiError>{
    if body.artist_ids.len()>50||body.artist_ids.iter().any(|id|*id<=0){return Err(ApiError::bad_request("Выберите не больше 50 исполнителей."));}
    let uid=user(&state,&headers).await?;let mut seen=HashSet::new();let ids:Vec<_>=body.artist_ids.into_iter().filter(|id|seen.insert(*id)).collect();
    // Validate against catalog metadata; arbitrary client labels never enter taste.
    let selected:Vec<_>=stream::iter(ids.clone().into_iter().map(|id:i64|{let state=state.clone();async move{canonical_artist(&state,id).await}})).buffered(4).try_collect().await?;
    crate::save_entities(&state.db,&selected,&[]).await?;
    {
        let _guard=state.recommendation_lock.lock().await;
        let mut tx=state.db.begin().await?;
        sqlx::query("DELETE FROM favorite_artists WHERE user_id=?").bind(uid).execute(&mut *tx).await?;
        for(position,a)in selected.iter().enumerate(){sqlx::query("INSERT INTO favorite_artists(user_id,artist_id,position) VALUES (?,?,?)").bind(uid).bind(a.id).bind(position as i64).execute(&mut *tx).await?;}
        sqlx::query("DELETE FROM daily_mixes WHERE user_id=?").bind(uid).execute(&mut *tx).await?;
        let sessions=sqlx::query("SELECT id,state_json FROM wave_sessions WHERE user_id=?").bind(uid).fetch_all(&mut *tx).await?;
        for row in sessions{if let Ok(mut wave)=serde_json::from_str::<WaveState>(row.get("state_json")){
            wave.rebuild_tail=true;wave.centroids.clear();wave.muted_clusters.clear();wave.muted_artists.clear();wave.last_cluster=None;wave.skip_count=0;
            sqlx::query("UPDATE wave_sessions SET state_json=? WHERE id=? AND user_id=?").bind(serde_json::to_string(&wave).unwrap()).bind(row.get::<String,_>("id")).bind(uid).execute(&mut *tx).await?;
        }}
        tx.commit().await?;
    }
    // Prepare a useful first queue before acknowledging a small selection. The
    // rest is background work; failed providers never roll back saved choices.
    let warm=stream::iter(ids.clone().into_iter().take(4).map(|id:i64|{let state=state.clone();async move{artist_top(&state,id,false).await}})).buffer_unordered(4).collect::<Vec<_>>();
    let _=tokio::time::timeout(std::time::Duration::from_secs(8),warm).await;
    let background=state.clone();tokio::spawn(async move{
        for id in ids{let _=artist_top(&background,id,false).await;expand(&background,id).await;}
    });
    Ok(Json(json!({"artists":selected})))
}
async fn seed_artist(state:&AppState,name:&str)->Result<(),ApiError>{
    let cached:Option<i64>=sqlx::query_scalar("SELECT artist_id FROM editorial_artists WHERE query=?").bind(name).fetch_optional(&state.db).await?;
    // The catalog has two exact matches for ATL. Use the intended artist ID.
    let id=if name=="ATL"&&cached!=Some(66220192){
        let artist=canonical_artist(state,66220192).await?;
        crate::save_entities(&state.db,std::slice::from_ref(&artist),&[]).await?;
        sqlx::query("INSERT INTO editorial_artists(query,artist_id) VALUES (?,?) ON CONFLICT(query) DO UPDATE SET artist_id=excluded.artist_id")
            .bind(name).bind(artist.id).execute(&state.db).await?;
        artist.id
    }else if let Some(id)=cached{id}else{
        let data=state.catalog("/search/artist",&[("q",name.to_string()),("limit","8".into())]).await?;
        let artist=crate::items(&data).iter().map(crate::normalize_artist).find(|a|a.id>0&&name_key(&a.name)==name_key(name)).ok_or_else(ApiError::not_found)?;
        crate::save_entities(&state.db,std::slice::from_ref(&artist),&[]).await?;
        sqlx::query("INSERT OR IGNORE INTO editorial_artists(query,artist_id) VALUES (?,?)").bind(name).bind(artist.id).execute(&state.db).await?;artist.id
    };
    let has_tracks:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM tracks t JOIN editorial_tracks e ON e.track_id=t.id WHERE t.artist_id=?)").bind(id).fetch_one(&state.db).await?;
    if !has_tracks{artist_top(state,id,true).await?;}Ok(())
}
async fn bootstrap(state:&AppState,all:bool){
    let sentinel=if all{-2}else{-1};
    {let mut recent=state.expansions.lock().await;if recent.get(&sentinel).is_some_and(|at|at.elapsed()<std::time::Duration::from_secs(60)){return;}recent.insert(sentinel,std::time::Instant::now());}
    let limit=if all{EDITORIAL_ARTISTS.len()}else{12};
    let names:Vec<String>=EDITORIAL_ARTISTS.iter().take(limit).map(|name|name.to_string()).collect();
    let job=stream::iter(names.into_iter().map(|name:String|{let state=state.clone();async move{seed_artist(&state,&name).await}})).buffer_unordered(4).collect::<Vec<_>>();
    let _=tokio::time::timeout(std::time::Duration::from_secs(16),job).await;
}
#[derive(Deserialize)]
pub struct ArtistPage { index: Option<u32> }

pub async fn artist_suggestions(State(state):State<AppState>,Query(page):Query<ArtistPage>)->Result<Json<Value>,ApiError>{
    const PAGE_SIZE: usize=24;
    let index=page.index.unwrap_or(0);
    if index==0 {
        let background=state.clone();
        tokio::spawn(async move {bootstrap(&background,true).await;});
    }
    let rows=sqlx::query(
        "SELECT a.id,a.name,a.picture_url FROM catalog_artists a
         WHERE a.name<>''
         ORDER BY EXISTS(SELECT 1 FROM editorial_artists e WHERE e.artist_id=a.id) DESC, a.id
         LIMIT ? OFFSET ?"
    ).bind((PAGE_SIZE+1) as i64).bind(i64::from(index)).fetch_all(&state.db).await?;
    let next_index=(rows.len()>PAGE_SIZE).then(||u64::from(index)+PAGE_SIZE as u64);
    let artists:Vec<_>=rows.into_iter().take(PAGE_SIZE)
        .map(|r|Artist{id:r.get("id"),name:r.get("name"),picture_url:r.get("picture_url")}).collect();
    Ok(Json(json!({"artists":artists,"next_index":next_index,"source":"catalog"})))
}

pub async fn related_artists(State(state):State<AppState>,Path(id):Path<String>)->Result<Json<Value>,ApiError>{
    let id=crate::parse_id(&id)?;
    let data=state.catalog(&format!("/artist/{id}/related"),&[("limit","8".into())]).await?;
    let mut seen=HashSet::from([id]);
    let artists:Vec<_>=crate::items(&data).iter().map(crate::normalize_artist)
        .filter(|artist|artist.id>0&&!artist.name.trim().is_empty()&&seen.insert(artist.id))
        .take(8).collect();
    crate::save_entities(&state.db,&artists,&[]).await?;
    Ok(Json(json!({"artists":artists})))
}
pub async fn discover(State(state):State<AppState>,headers:HeaderMap)->Result<Json<Value>,ApiError>{
    bootstrap(&state,false).await;
    let tracks=sqlx::query_as::<_,Track>("SELECT t.* FROM editorial_tracks e JOIN tracks t ON t.id=e.track_id WHERE EXISTS (SELECT 1 FROM editorial_artists a WHERE a.artist_id=t.artist_id) ORDER BY t.updated_at DESC LIMIT 500").fetch_all(&state.db).await?;
    if let Some(user)=crate::auth::session_user(&state,&headers).await? {
        if let Some(discovery)=explore_taste(&state,user).await? { return Ok(Json(discovery)); }
    }
    // Round-robin artists so a single recently fetched album cannot fill home.
    let mut selected=Vec::new();let mut remaining=tracks;let mut used=HashSet::new();
    while !remaining.is_empty()&&selected.len()<48{if !remaining.iter().any(|t|!used.contains(&t.artist_id)){used.clear();}let index=remaining.iter().position(|t|!used.contains(&t.artist_id)).unwrap_or(0);let t=remaining.remove(index);used.insert(t.artist_id);selected.push(t);}
    let background=state.clone();tokio::spawn(async move{bootstrap(&background,true).await;});
    Ok(Json(json!({"tracks":selected,"source":"editorial_ru","personalized":false})))
}

pub(crate) struct WavePreferences {
    pub artists: Vec<String>,
    pub blocked: HashSet<String>,
    favorites: HashSet<i64>,
    centroids: Vec<Vector>,
}

impl WavePreferences {
    pub fn affinity(&self, track: &Track, vector: Option<&Vector>) -> f32 {
        let similarity=vector.and_then(|vector|self.centroids.iter()
            .map(|center|cosine(vector,center)).max_by(f32::total_cmp)).unwrap_or(0.0).max(0.0);
        let familiar=self.favorites.contains(&track.artist_id) ||
            track.contributors.iter().any(|credit|self.favorites.contains(&credit.id));
        similarity+if familiar {0.2}else{0.0}
    }
}

pub(crate) async fn wave_preferences(state:&AppState,user:i64)->Result<WavePreferences,ApiError> {
    let favorites=favorite_list(state,user).await?;
    let mut artists:Vec<_>=favorites.iter().map(|artist|artist.name.clone()).take(6).collect();
    let recent:Vec<String>=sqlx::query_scalar("SELECT t.artist FROM interactions i JOIN tracks t ON t.id=i.track_id
        WHERE i.user_id=? AND i.action_type IN ('complete','like') AND t.artist<>''
        GROUP BY t.artist ORDER BY sum(CASE i.action_type WHEN 'complete' THEN 2 ELSE 1 END) DESC, max(i.id) DESC LIMIT 6")
        .bind(user).fetch_all(&state.db).await?;
    for name in recent { if !artists.contains(&name) { artists.push(name); } }
    let blocked=sqlx::query_scalar("SELECT track_id FROM user_track_flags WHERE user_id=? AND is_disliked=1")
        .bind(user).fetch_all(&state.db).await?.into_iter().collect();
    let blobs:Vec<Vec<u8>>=sqlx::query_scalar("SELECT centroid_vector FROM user_taste_clusters WHERE user_id=?")
        .bind(user).fetch_all(&state.db).await?;
    let centroids=blobs.iter().filter_map(|blob|crate::analysis::decode_vector(blob)).collect();
    Ok(WavePreferences{artists,blocked,favorites:favorites.into_iter().map(|artist|artist.id).collect(),centroids})
}

async fn explore_taste(state:&AppState,user:i64)->Result<Option<Value>,ApiError>{
    let profile=wave_preferences(state,user).await?;
    if profile.centroids.is_empty() { return Ok(None); }
    let candidates=sqlx::query_as::<_,Track>("SELECT t.* FROM tracks t WHERE t.embedding IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM interactions i WHERE i.user_id=? AND i.track_id=t.id)
        AND NOT EXISTS(SELECT 1 FROM user_track_flags f WHERE f.user_id=? AND f.track_id=t.id AND (f.is_liked=1 OR f.is_disliked=1))
        ORDER BY t.updated_at DESC LIMIT 2500")
        .bind(user).bind(user).fetch_all(&state.db).await?;
    let mut ranked={
        let vectors=state.analysis.vectors.read().unwrap();
        candidates.into_iter().filter_map(|track|{
            if profile.favorites.contains(&track.artist_id)||profile.artists.contains(&track.artist){return None;}
            let vector=vectors.get(&track.id)?;
            let nearest=profile.centroids.iter().map(|center|cosine(vector,center)).max_by(f32::total_cmp)?;
            // Favor unexplored tracks at some distance from the taste clusters.
            (nearest>=0.20).then_some(((nearest-0.57).abs(),track))
        }).collect::<Vec<_>>()
    };
    ranked.sort_by(|a,b|a.0.total_cmp(&b.0));
    let mut artists=HashSet::new();
    let tracks:Vec<_>=ranked.into_iter().map(|(_,track)|track).filter(|track|artists.insert(track.artist_id)).take(20).collect();
    Ok((!tracks.is_empty()).then(||json!({"tracks":tracks,"source":"explore","personalized":true})))
}

fn valid_token(s:&str)->bool{s.len()>=16&&s.len()<=64&&s.chars().all(|c|c.is_ascii_alphanumeric()||c=='-')}
async fn user(state:&AppState,headers:&HeaderMap)->Result<i64,ApiError>{
    if let Some(id)=crate::auth::session_user(state,headers).await?{return Ok(id);}
    let profile=headers.get("x-yamusic-profile").and_then(|v|v.to_str().ok()).filter(|s|valid_token(s)).ok_or_else(||ApiError::bad_request("Не найден профиль этого браузера."))?;
    let mut tx=state.db.begin_with("BEGIN IMMEDIATE").await?;
    if let Some(id)=sqlx::query_scalar("SELECT user_id FROM device_profiles WHERE profile_id=?").bind(profile).fetch_optional(&mut *tx).await?{return Ok(id);}
    let id=sqlx::query("INSERT INTO users(first_name) VALUES ('')").execute(&mut *tx).await?.last_insert_rowid();
    sqlx::query("INSERT INTO device_profiles(profile_id,user_id) VALUES (?,?)").bind(profile).bind(id).execute(&mut *tx).await?;tx.commit().await?;Ok(id)
}
#[derive(Deserialize)]pub struct Interaction{
    track_id:String,action:String,event_id:String,
    #[serde(default)]listen_ratio:f64,#[serde(default)]listened_sec:f64,
    #[serde(default)]session_id:Option<String>,
}
pub async fn interact(State(state):State<AppState>,headers:HeaderMap,Json(body):Json<Interaction>)->Result<Json<Value>,ApiError>{
    let _guard=state.recommendation_lock.lock().await;
    if !valid_token(&body.event_id)||!["like","unlike","dislike","undislike","complete","early_skip"].contains(&body.action.as_str())||!body.listen_ratio.is_finite()||!(0.0..=1.).contains(&body.listen_ratio)||!body.listened_sec.is_finite()||body.listened_sec<0.{return Err(ApiError::bad_request("Некорректное действие с песней."));}
    let uid=user(&state,&headers).await?;let track=crate::stored_track(&state,&body.track_id).await?;
    if body.action=="complete"&&(body.listen_ratio<=0.8||body.listened_sec<track.duration_sec as f64*0.8){return Err(ApiError::bad_request("Песня ещё не прослушана целиком."));}
    if body.action=="early_skip"&&body.listened_sec>=30.{return Err(ApiError::bad_request("Это не ранний пропуск."));}
    let mut tx=state.db.begin().await?;
    let existed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM reaction_receipts WHERE user_id=? AND event_id=?)").bind(uid).bind(&body.event_id).fetch_one(&mut *tx).await?;
    let mut changed=!existed;
    if !existed{
        sqlx::query("INSERT INTO reaction_receipts(user_id,event_id) VALUES (?,?)").bind(uid).bind(&body.event_id).execute(&mut *tx).await?;
        if ["like","unlike","dislike","undislike"].contains(&body.action.as_str()){
            sqlx::query("INSERT OR IGNORE INTO user_track_flags(user_id,track_id) VALUES (?,?)").bind(uid).bind(&track.id).execute(&mut *tx).await?;
            let flag=if body.action.ends_with("dislike"){"is_disliked"}else{"is_liked"};
            let active=!body.action.starts_with("un");
            let old:i64=sqlx::query_scalar(&format!("SELECT {flag} FROM user_track_flags WHERE user_id=? AND track_id=?")).bind(uid).bind(&track.id).fetch_one(&mut *tx).await?;changed=(old!=0)!=active;
            if changed{
                sqlx::query(&format!("UPDATE user_track_flags SET {flag}=? WHERE user_id=? AND track_id=?")).bind(active).bind(uid).bind(&track.id).execute(&mut *tx).await?;
                if !active{let action=if flag=="is_liked"{"like"}else{"dislike"};sqlx::query("DELETE FROM interactions WHERE user_id=? AND track_id=? AND action_type=?").bind(uid).bind(&track.id).bind(action).execute(&mut *tx).await?;}
            }
        }
        if changed&&!body.action.starts_with("un"){
            sqlx::query("INSERT INTO interactions(user_id,track_id,action_type,listen_ratio,event_id) VALUES (?,?,?,?,?)").bind(uid).bind(&track.id).bind(&body.action).bind(body.listen_ratio).bind(&body.event_id).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    state.analysis.enqueue([track.id.clone()],true);
    if changed&&(body.action=="like"||body.action=="complete"){
        let state=state.clone();let artist=track.artist_id;tokio::spawn(async move{expand(&state,artist).await;});
    }
    if changed&&["early_skip","dislike","complete","like","unlike","undislike"].contains(&body.action.as_str()){
        if let Some(session)=body.session_id.as_ref().filter(|s|valid_token(s)){
            if let Some(row)=sqlx::query_scalar::<_,String>("SELECT state_json FROM wave_sessions WHERE id=? AND user_id=?").bind(session).bind(uid).fetch_optional(&state.db).await?{
                if let Ok(mut wave)=serde_json::from_str::<WaveState>(&row){
                    if body.action!="early_skip" || !wave.feedback.contains(&track.id){
                        let vectors=state.analysis.vectors.read().unwrap().clone();
                        let cluster=vectors.get(&track.id).and_then(|v|nearest(v,&wave.centroids));
                        if body.action=="complete"{wave.last_cluster=None;wave.skip_count=0;}else if body.action=="early_skip"{wave.record_skip(&track,cluster);}
                        if body.action=="early_skip"{wave.feedback.push(track.id.clone());}
                        // Refill the tail on the next advance; keep the playing song.
                        wave.rebuild_tail=true;
                        sqlx::query("UPDATE wave_sessions SET state_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").bind(serde_json::to_string(&wave).unwrap()).bind(session).bind(uid).execute(&state.db).await?;
                    }
                }
            }
        }
    }
    Ok(Json(json!({"accepted":true})))
}
pub async fn status(State(state):State<AppState>,headers:HeaderMap)->Result<Json<Value>,ApiError>{
    let uid=user(&state,&headers).await?;
    let reactions=sqlx::query("SELECT track_id,is_liked,is_disliked FROM user_track_flags WHERE user_id=?").bind(uid).fetch_all(&state.db).await?;
    let blocked_tracks=sqlx::query_as::<_,Track>("SELECT t.* FROM tracks t JOIN user_track_flags f ON f.track_id=t.id WHERE f.user_id=? AND f.is_disliked=1 ORDER BY t.title LIMIT 5000").bind(uid).fetch_all(&state.db).await?;
    let analyzed=state.analysis.vectors.read().unwrap().len();
    Ok(Json(json!({"available":state.analysis.available.load(Ordering::Relaxed),"analyzed_tracks":analyzed,"pending":state.analysis.pending(),"analyzing":state.analysis.running.load(Ordering::Relaxed),"likes":reactions.iter().filter(|r|r.get::<i64,_>("is_liked")!=0).map(|r|r.get::<String,_>("track_id")).collect::<Vec<_>>(),"dislikes":reactions.iter().filter(|r|r.get::<i64,_>("is_disliked")!=0).map(|r|r.get::<String,_>("track_id")).collect::<Vec<_>>(),"blocked_tracks":blocked_tracks})))
}
#[derive(Default)]struct Taste{weights:HashMap<String,f32>,centroids:Vec<Vector>,blocked:HashSet<String>,favorites:HashSet<i64>,editorial:HashSet<String>,explicit_artists:HashSet<i64>,cached_audio:HashSet<String>,cold_start:bool}
impl Taste{fn personalized(&self)->bool{!self.centroids.is_empty()||!self.favorites.is_empty()}}
pub fn event_weight(action:&str,complete_number:u32,days:f32)->f32{
    let base=match action{"complete"=>2.*0.5f32.powi(complete_number.saturating_sub(1).min(256) as i32),"like"=>1.,"early_skip"=>-1.,"dislike"=>-5.,_=>0.};base*(-0.01*days.max(0.)).exp()
}
async fn taste(state:&AppState,uid:i64,vectors:&HashMap<String,Vector>)->Result<Taste,ApiError>{
    let rows=sqlx::query("SELECT track_id,action_type,max(0,julianday('now')-julianday(created_at)) AS age FROM interactions WHERE user_id=? ORDER BY created_at,id").bind(uid).fetch_all(&state.db).await?;
    let mut result=Taste::default();let mut counts=HashMap::<String,u32>::new();
    for row in rows{let id:String=row.get("track_id");let action:String=row.get("action_type");let count=counts.entry(id.clone()).or_default();if action=="complete"{*count+=1;}*result.weights.entry(id).or_default()+=event_weight(&action,*count,row.get::<f64,_>("age") as f32);}
    result.blocked=sqlx::query_scalar("SELECT track_id FROM user_track_flags WHERE user_id=? AND is_disliked=1").bind(uid).fetch_all(&state.db).await?.into_iter().collect();
    result.favorites=sqlx::query_scalar("SELECT artist_id FROM favorite_artists WHERE user_id=?").bind(uid).fetch_all(&state.db).await?.into_iter().collect();
    result.editorial=sqlx::query_scalar("SELECT e.track_id FROM editorial_tracks e JOIN tracks t ON t.id=e.track_id WHERE EXISTS (SELECT 1 FROM editorial_artists a WHERE a.artist_id=t.artist_id)").fetch_all(&state.db).await?.into_iter().collect();
    result.explicit_artists=sqlx::query_scalar("SELECT DISTINCT t.artist_id FROM tracks t JOIN interactions i ON i.track_id=t.id WHERE i.user_id=? AND i.action_type IN ('like','complete')").bind(uid).fetch_all(&state.db).await?.into_iter().collect();
    result.cold_start=result.favorites.is_empty()&&result.weights.values().all(|w|*w<=0.);
    if result.cold_start {
        result.cached_audio=sqlx::query_scalar("SELECT track_id FROM audio_cache WHERE local_file_path IS NOT NULL AND file_size_bytes>0")
            .fetch_all(&state.db).await?.into_iter().collect();
    }
    let mut positives:Vec<_>=result.weights.iter().filter(|(id,w)|**w>0.&&!result.blocked.contains(*id)).filter_map(|(id,w)|vectors.get(id).map(|v|(id.clone(),v.clone(),*w))).collect();
    // Artist selection supplies a small real-audio prior, never fake listens or
    // likes. Several artists stay separate through the same K-Means pipeline.
    let seed_tracks=sqlx::query("SELECT t.id,t.artist_id FROM tracks t JOIN favorite_artists f ON f.artist_id=t.artist_id WHERE f.user_id=? ORDER BY t.updated_at DESC").bind(uid).fetch_all(&state.db).await?;
    let mut per_artist=HashMap::<i64,usize>::new();
    for row in seed_tracks{let id:String=row.get("id");let count=per_artist.entry(row.get("artist_id")).or_default();if *count<3&&!result.blocked.contains(&id)&&!result.weights.contains_key(&id){if let Some(v)=vectors.get(&id){positives.push((id,v.clone(),0.35));*count+=1;}}}
    positives.sort_by(|a,b|a.0.cmp(&b.0));let positives:Vec<_>=positives.into_iter().map(|(_,v,w)|(v,w)).collect();
    result.centroids=tokio::task::spawn_blocking(move||cluster(&positives)).await.unwrap_or_default();
    let mut tx=state.db.begin().await?;sqlx::query("DELETE FROM user_taste_clusters WHERE user_id=?").bind(uid).execute(&mut *tx).await?;
    for(i,vector)in result.centroids.iter().enumerate(){sqlx::query("INSERT INTO user_taste_clusters(user_id,cluster_index,centroid_vector,track_count) VALUES (?,?,?,?)").bind(uid).bind(i as i64).bind(encode_vector(vector)).bind(result.weights.len() as i64).execute(&mut *tx).await?;}
    tx.commit().await?;Ok(result)
}
fn cluster(positive:&[(Vector,f32)])->Vec<Vector>{
    if positive.is_empty(){return vec![];}let n=positive.len();let k=n.min(5);
    let Ok(data)=Array2::from_shape_vec((n,512),positive.iter().flat_map(|(v,_)|v.clone()).collect())else{return vec![];};
    let dataset=DatasetBase::from(data).with_weights(ndarray::Array1::from_iter(positive.iter().map(|(_,w)|*w)));let Ok(model)=KMeans::params(k).n_runs(2).max_n_iterations(40).fit(&dataset)else{return vec![];};
    let labels=model.predict(&dataset);let mut centers=vec![vec![0f32;512];k];
    for((v,w),label)in positive.iter().zip(labels.iter()){for(i,x)in v.iter().enumerate(){centers[*label][i]+=x*w;}}
    centers.retain_mut(|v|normalize(v));centers
}
fn nearest(vector:&[f32],centers:&[Vector])->Option<usize>{centers.iter().enumerate().max_by(|(_,a),(_,b)|cosine(vector,a).total_cmp(&cosine(vector,b))).map(|(i,_)|i)}
#[derive(Default,Serialize,Deserialize)]struct WaveState{
    queue:Vec<String>,recent:Vec<String>,muted_clusters:Vec<usize>,muted_artists:Vec<i64>,last_cluster:Option<usize>,skip_count:usize,feedback:Vec<String>,
    #[serde(default)]centroids:Vec<Vector>,#[serde(default)]rebuild_tail:bool,
    #[serde(default)]offered:Vec<String>,
}
impl WaveState{
    fn record_skip(&mut self,t:&Track,cluster:Option<usize>){
        if cluster.is_some()&&cluster==self.last_cluster{self.skip_count+=1;}else{self.skip_count=1;self.last_cluster=cluster;}
        if self.skip_count>=2{if let Some(c)=cluster{if !self.muted_clusters.contains(&c){self.muted_clusters.push(c);}}if !self.muted_artists.contains(&t.artist_id){self.muted_artists.push(t.artist_id);}}
    }
}
#[derive(Deserialize)]pub struct Advance{current_id:String}
#[derive(Serialize,Deserialize)]pub struct QueueResult{session_id:String,tracks:Vec<Track>,personalized:bool,learning:bool}
async fn pool(state:&AppState)->Result<Vec<Track>,ApiError>{Ok(sqlx::query_as::<_,Track>("SELECT * FROM tracks ORDER BY updated_at DESC LIMIT 10000").fetch_all(&state.db).await?)}
fn rank(tracks:&[Track],taste:&Taste,vectors:&HashMap<String,Vector>,wave:&WaveState)->Vec<Track>{
    let mut scored:Vec<_>=tracks.iter().enumerate().filter(|(_,t)|!taste.blocked.contains(&t.id)&&!wave.recent.contains(&t.id)&&!wave.queue.contains(&t.id)).filter_map(|(index,t)|{
        let favorite=taste.favorites.contains(&t.artist_id)||t.contributors.iter().any(|a|taste.favorites.contains(&a.id));
        let explicit=favorite||taste.explicit_artists.contains(&t.artist_id)||taste.weights.get(&t.id).is_some_and(|w|*w>0.);
        let editorial=taste.editorial.contains(&t.id);
        if taste.cold_start&&!editorial{return None;}
        if taste.centroids.is_empty()&&!taste.favorites.is_empty()&&!explicit&&!editorial{return None;}
        let vector=vectors.get(&t.id);if !taste.centroids.is_empty()&&vector.is_none()&&!favorite{return None;}
        let nearest=vector.and_then(|v|nearest(v,&taste.centroids));
        let similarity=if taste.centroids.is_empty(){0.}else{vector.map(|v|taste.centroids.iter().map(|c|cosine(v,c)).fold(-1f32,f32::max)).unwrap_or(0.)};
        let weight=taste.weights.get(&t.id).copied().unwrap_or(0.);
        let penalty=if wave.muted_artists.contains(&t.artist_id){1.0}else{0.}+if nearest.is_some_and(|c|wave.muted_clusters.contains(&c)){0.5}else{0.};
        let negative=vector.map(|v|taste.weights.iter().filter(|(_,w)|**w<0.).filter_map(|(id,w)|vectors.get(id).map(|n|cosine(v,n).max(0.)*(-*w).min(5.)/5.)).fold(0f32,f32::max)).unwrap_or(0.);
        let artist_prior=if favorite{if taste.centroids.is_empty(){2.0}else{0.3}}else{0.};
        let editorial_prior=if editorial{0.12}else{0.};
        Some((t.clone(),similarity+artist_prior+editorial_prior+weight.clamp(-5.,3.)*0.04-penalty-negative*0.35,index))
    }).collect();scored.sort_by(|a,b|b.1.total_cmp(&a.1).then_with(||a.2.cmp(&b.2)));scored.into_iter().map(|(t,_,_)|t).collect()
}
fn fill_wave(wave:&mut WaveState,tracks:&[Track],taste:&Taste,vectors:&HashMap<String,Vector>){
    let mut ranked=rank(tracks,taste,vectors,wave);
    // Release old history for small catalogs, preserving the playing song.
    while ranked.len()+wave.queue.len()<6&&!wave.recent.is_empty(){wave.recent.remove(0);ranked=rank(tracks,taste,vectors,wave);}
    if wave.queue.is_empty()&&taste.cold_start {
        if let Some(index)=ranked.iter().position(|track|taste.cached_audio.contains(&track.id)) {
            wave.queue.push(ranked.remove(index).id);
        }
    }
    let mut known=ranked.iter().filter(|t|taste.weights.get(&t.id).is_some_and(|w|*w>0.)).cloned().collect::<Vec<_>>();
    let mut new=ranked.into_iter().filter(|t|!taste.weights.get(&t.id).is_some_and(|w|*w>0.)).collect::<Vec<_>>();
    // One playing song plus five ahead: three discoveries, two familiar songs.
    let mut familiar=wave.queue.iter().skip(1).filter(|id|taste.weights.get(*id).is_some_and(|w|*w>0.)).count();
    for position in wave.queue.len()..6{
        let wants_known=position>0&&familiar<2&&(position==2||position>=5-(2-familiar));
        let recent_artists:Vec<_>=wave.queue.iter().rev().chain(wave.recent.iter().rev()).take(if taste.cold_start{5}else{2})
            .filter_map(|id|tracks.iter().find(|t|&t.id==id).map(|t|t.artist_id)).collect();
        let (primary,secondary)=if wants_known{(&mut known,&mut new)}else{(&mut new,&mut known)};
        let mut next=None;
        for gap in (0..=recent_artists.len()).rev() {
            let excluded=&recent_artists[..gap];
            if let Some(index)=primary.iter().position(|t|!excluded.contains(&t.artist_id)) {
                next=Some(primary.remove(index));break;
            }
            if let Some(index)=secondary.iter().position(|t|!excluded.contains(&t.artist_id)) {
                next=Some(secondary.remove(index));break;
            }
        }
        if let Some(t)=next{if position>0&&taste.weights.get(&t.id).is_some_and(|w|*w>0.){familiar+=1;}wave.queue.push(t.id);}
    }
    for id in &wave.queue{if !wave.offered.contains(id){wave.offered.push(id.clone());}}
    if wave.offered.len()>40{wave.offered.drain(..wave.offered.len()-40);}
}
fn materialize(ids:&[String],tracks:&[Track],blocked:&HashSet<String>)->Vec<Track>{let by_id:HashMap<_,_>=tracks.iter().map(|t|(&t.id,t)).collect();ids.iter().filter(|id|!blocked.contains(*id)).filter_map(|id|by_id.get(id).map(|t|(*t).clone())).collect()}
pub async fn start_wave(State(state):State<AppState>,headers:HeaderMap)->Result<Json<QueueResult>,ApiError>{
    bootstrap(&state,false).await;
    let _guard=state.recommendation_lock.lock().await;
    let uid=user(&state,&headers).await?;let tracks=pool(&state).await?;let vectors=state.analysis.vectors.read().unwrap().clone();let taste=taste(&state,uid,&vectors).await?;let mut wave=WaveState{centroids:taste.centroids.clone(),..Default::default()};fill_wave(&mut wave,&tracks,&taste,&vectors);
    let id:String=sqlx::query_scalar("SELECT lower(hex(randomblob(16)))").fetch_one(&state.db).await?;
    sqlx::query("DELETE FROM wave_sessions WHERE updated_at<datetime('now','-1 day') OR (user_id=? AND id IN (SELECT id FROM wave_sessions WHERE user_id=? ORDER BY updated_at DESC LIMIT -1 OFFSET 4))").bind(uid).bind(uid).execute(&state.db).await?;
    sqlx::query("INSERT INTO wave_sessions(id,user_id,state_json) VALUES (?,?,?)").bind(&id).bind(uid).bind(serde_json::to_string(&wave).unwrap()).execute(&state.db).await?;
    let list=materialize(&wave.queue,&tracks,&taste.blocked);state.audio.prefetch_playback(list.iter().map(|t|t.id.clone()));state.analysis.enqueue(list.iter().map(|t|t.id.clone()),true);
    Ok(Json(QueueResult{session_id:id,tracks:list,personalized:taste.personalized(),learning:taste.centroids.is_empty()}))
}
pub async fn next_wave(State(state):State<AppState>,headers:HeaderMap,Path(id):Path<String>,Json(body):Json<Advance>)->Result<Json<QueueResult>,ApiError>{
    let _guard=state.recommendation_lock.lock().await;
    let uid=user(&state,&headers).await?;
    let raw=sqlx::query_scalar::<_,String>("SELECT state_json FROM wave_sessions WHERE id=? AND user_id=?").bind(&id).bind(uid).fetch_optional(&state.db).await?.ok_or_else(ApiError::not_found)?;
    let mut wave:WaveState=serde_json::from_str(&raw).map_err(|_|ApiError::not_found())?;
    if let Some(position)=wave.queue.iter().position(|t|t==&body.current_id){let removed:Vec<_>=wave.queue.drain(..position).collect();wave.recent.extend(removed);}
    else if wave.offered.contains(&body.current_id){
        // A fast second skip can start an already prepared song while the
        // previous request is rebuilding its old tail. Keep that song playing.
        if let Some(previous)=wave.queue.first(){wave.recent.push(previous.clone());}
        wave.queue=vec![body.current_id.clone()];wave.rebuild_tail=true;
    }else if !wave.recent.contains(&body.current_id){return Err(ApiError::bad_request("Песня не относится к этой волне."));}
    if wave.recent.len()>30{wave.recent.drain(..wave.recent.len()-30);}
    wave.feedback.retain(|id|wave.recent.contains(id)||wave.queue.contains(id));
    let tracks=pool(&state).await?;let vectors=state.analysis.vectors.read().unwrap().clone();let taste=taste(&state,uid,&vectors).await?;
    if wave.centroids!=taste.centroids {
        wave.centroids=taste.centroids.clone();
        wave.muted_clusters.clear();
        wave.last_cluster=None;
    }
    if wave.rebuild_tail{wave.queue.truncate(1);wave.rebuild_tail=false;}
    wave.queue.retain(|id|!taste.blocked.contains(id));fill_wave(&mut wave,&tracks,&taste,&vectors);
    sqlx::query("UPDATE wave_sessions SET state_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").bind(serde_json::to_string(&wave).unwrap()).bind(&id).bind(uid).execute(&state.db).await?;
    let list=materialize(&wave.queue,&tracks,&taste.blocked);state.audio.prefetch_playback(list.iter().skip(1).map(|t|t.id.clone()));state.analysis.enqueue(list.iter().map(|t|t.id.clone()),true);
    Ok(Json(QueueResult{session_id:id,tracks:list,personalized:taste.personalized(),learning:taste.centroids.is_empty()}))
}
pub fn smooth_order(mut ranked:Vec<Track>,vectors:&HashMap<String,Vector>,limit:usize)->Vec<Track>{
    let mut result:Vec<Track>=Vec::new();
    while !ranked.is_empty()&&result.len()<limit{
        let previous=result.last().and_then(|t|vectors.get(&t.id));let recent:HashSet<_>=result.iter().rev().take(3).map(|t|t.artist_id).collect();
        let next=ranked.iter().enumerate().filter(|(_,t)|!recent.contains(&t.artist_id)).max_by(|(ia,a),(ib,b)|{
            let score=|i:usize,t:&Track|previous.zip(vectors.get(&t.id)).map(|(a,b)|cosine(a,b)).unwrap_or(0.)-i as f32*0.0001;
            score(*ia,a).total_cmp(&score(*ib,b))
        }).map(|(i,_)|i);
        let Some(i)=next else{break;};result.push(ranked.remove(i));
    }result
}
pub async fn daily(State(state):State<AppState>,headers:HeaderMap)->Result<Json<Value>,ApiError>{
    bootstrap(&state,false).await;
    let _guard=state.recommendation_lock.lock().await;
    let uid=user(&state,&headers).await?;let day:String=sqlx::query_scalar("SELECT date('now')").fetch_one(&state.db).await?;let tracks=pool(&state).await?;
    let vectors=state.analysis.vectors.read().unwrap().clone();let taste=taste(&state,uid,&vectors).await?;
    if let Some(row)=sqlx::query("SELECT track_ids_json,personalized FROM daily_mixes WHERE user_id=? AND day=? AND algorithm_version=2").bind(uid).bind(&day).fetch_optional(&state.db).await?{
        let ids:Vec<String>=serde_json::from_str(row.get("track_ids_json")).unwrap_or_default();
        if row.get::<i64,_>("personalized")!=0||!taste.personalized(){return Ok(Json(json!({"tracks":materialize(&ids,&tracks,&taste.blocked),"day":day,"personalized":row.get::<i64,_>("personalized")!=0})));}
    }
    let ranked=rank(&tracks,&taste,&vectors,&WaveState::default());let ordered=smooth_order(ranked,&vectors,50);
    // An empty catalog is transient; don't freeze an empty mix for a whole day.
    if ordered.len()==50{
        let ids:Vec<_>=ordered.iter().map(|t|&t.id).collect();sqlx::query("INSERT INTO daily_mixes(user_id,day,track_ids_json,personalized,algorithm_version) VALUES (?,?,?,?,2) ON CONFLICT(user_id,day) DO UPDATE SET track_ids_json=excluded.track_ids_json,personalized=excluded.personalized,algorithm_version=2").bind(uid).bind(&day).bind(serde_json::to_string(&ids).unwrap()).bind(taste.personalized()).execute(&state.db).await?;
        sqlx::query("DELETE FROM daily_mixes WHERE day<date('now','-7 days')").execute(&state.db).await?;
    }
    state.analysis.enqueue(ordered.iter().map(|t|t.id.clone()),false);
    Ok(Json(json!({"tracks":ordered,"day":day,"personalized":taste.personalized()})))
}
pub async fn expand(state:&AppState,artist:i64){
    if artist<=0{return;}
    {let mut recent=state.expansions.lock().await;recent.retain(|_,at|at.elapsed()<std::time::Duration::from_secs(600));if recent.contains_key(&artist){return;}if recent.len()>=128{return;}recent.insert(artist,std::time::Instant::now());}
    // Deezer radio supplies catalog candidates. The sound vector, not a shared
    // artist label, decides their personalized ranking after analysis.
    let Ok(radio)=state.catalog(&format!("/artist/{artist}/radio"),&[("limit","50".into())]).await else{return;};
    let mut tracks:Vec<_>=crate::items(&radio).iter().filter_map(crate::normalize_track).collect();
    if let Ok(related)=state.catalog(&format!("/artist/{artist}/related"),&[("limit","3".into())]).await{
        for other in crate::items(&related).iter().take(3){let id=crate::number(other,"id");if let Ok(top)=state.catalog(&format!("/artist/{id}/top"),&[("limit","10".into())]).await{tracks.extend(crate::items(&top).iter().filter_map(crate::normalize_track));}}
    }
    if crate::save_tracks(&state.db,&tracks).await.is_ok(){state.analysis.enqueue(tracks.into_iter().map(|t|t.id),false);}
}
#[cfg(test)]mod tests{
    use super::*;
    fn t(id:usize,artist:i64)->Track{Track{id:format!("deezer_{id}"),deezer_id:id as i64,title:id.to_string(),artist:artist.to_string(),artist_id:artist,album:String::new(),album_id:1,cover_url:String::new(),duration_sec:100,is_explicit:false,preview_url:String::new(),contributors:vec![]}}
    #[test]fn repeat_weights_decay_and_negative_signs(){assert_eq!(event_weight("complete",1,0.),2.);assert_eq!(event_weight("complete",2,0.),1.);assert_eq!(event_weight("complete",3,0.),0.5);assert!((event_weight("like",0,100.)-(-1f32).exp()).abs()<1e-6);assert_eq!(event_weight("early_skip",0,0.),-1.);assert_eq!(event_weight("dislike",0,0.),-5.);}
    #[test]fn buffer_has_three_new_two_known_and_never_blocked(){let tracks:Vec<_>=(1..12).map(|i|t(i,i as i64)).collect();let mut taste=Taste::default();taste.weights.insert("deezer_1".into(),1.);taste.weights.insert("deezer_2".into(),2.);taste.blocked.insert("deezer_3".into());let mut wave=WaveState::default();fill_wave(&mut wave,&tracks,&taste,&HashMap::new());assert_eq!(wave.queue.len(),6);assert!(!wave.queue.contains(&"deezer_3".into()));assert_eq!(wave.queue.iter().skip(1).filter(|id|taste.weights.contains_key(*id)).count(),2);}
    #[test]fn daily_artist_gap_and_nearest_neighbor(){let tracks:Vec<_>=(0..80).map(|i|t(i,(i%7) as i64)).collect();let mut vectors=HashMap::new();for t in &tracks{let mut v=vec![0.;512];v[t.deezer_id as usize%2]=1.;vectors.insert(t.id.clone(),v);}let result=smooth_order(tracks,&vectors,50);assert_eq!(result.len(),50);for(i,t)in result.iter().enumerate(){assert!(!result[i.saturating_sub(3)..i].iter().any(|p|p.artist_id==t.artist_id));}}
    #[test]fn two_skips_penalize_cluster_and_artist(){let mut wave=WaveState::default();wave.record_skip(&t(1,5),Some(2));assert!(wave.muted_clusters.is_empty());wave.record_skip(&t(2,8),Some(2));assert_eq!(wave.muted_clusters,vec![2]);assert_eq!(wave.muted_artists,vec![8]);}
    #[test]fn negative_sound_penalty_and_cold_order(){
        let tracks=vec![t(1,1),t(2,2),t(3,3)];let mut a=vec![0.;512];a[0]=1.;let mut b=vec![0.;512];b[1]=1.;let vectors=HashMap::from([("deezer_1".into(),a.clone()),("deezer_2".into(),b),("deezer_3".into(),a.clone())]);
        let mut taste=Taste::default();let cold=rank(&tracks,&taste,&vectors,&WaveState::default());assert_eq!(cold[0].id,"deezer_1");
        taste.centroids=vec![a];taste.weights.insert("deezer_3".into(),-5.);taste.blocked.insert("deezer_3".into());let with_penalty=rank(&tracks,&taste,&vectors,&WaveState::default());assert_eq!(with_penalty.len(),2);assert!(!with_penalty.iter().any(|t|t.id=="deezer_3"));
        let mut wave=WaveState::default();wave.muted_clusters.push(0);wave.muted_artists.push(1);let penalized=rank(&tracks,&taste,&vectors,&wave);assert_eq!(penalized[0].id,"deezer_2");
    }
    #[test]fn small_wave_keeps_refilling_after_all_tracks_have_played(){
        let tracks=vec![t(1,1),t(2,2)];
        let mut wave=WaveState{queue:vec![tracks[0].id.clone()],recent:vec![tracks[1].id.clone()],..Default::default()};
        for _ in 0..20 {
            fill_wave(&mut wave,&tracks,&Taste::default(),&HashMap::new());
            assert_eq!(wave.queue.len(),2);
            wave.recent.push(wave.queue.remove(0));
        }
    }
    #[test]fn cold_wave_does_not_fill_with_the_most_recent_artist(){
        let mut tracks:Vec<_>=(1..=12).map(|i|t(i,1)).collect();
        tracks.extend((13..=17).map(|i|t(i,i as i64)));
        let taste=Taste{cold_start:true,editorial:tracks.iter().map(|t|t.id.clone()).collect(),..Default::default()};
        let mut wave=WaveState::default();
        fill_wave(&mut wave,&tracks,&taste,&HashMap::new());
        assert_eq!(materialize(&wave.queue,&tracks,&taste.blocked).iter().map(|t|t.artist_id).collect::<HashSet<_>>().len(),6);
    }
    #[test]fn kmeans_keeps_separate_musical_directions(){let positive:Vec<_>=(0..6).map(|i|{let mut v=vec![0.;512];v[i%3]=1.;(v,1.)}).collect();let centers=cluster(&positive);assert!(!centers.is_empty());assert!(centers.len()<=5);assert!(centers.iter().all(|v|(cosine(v,v)-1.).abs()<1e-5));}
    #[test]fn editorial_cold_start_is_explicit_and_foreign_favorite_is_respected(){
        let tracks=vec![t(1,100),t(2,200),t(3,300)];
        let mut taste=Taste{cold_start:true,editorial:HashSet::from(["deezer_2".into()]),..Default::default()};
        let result=rank(&tracks,&taste,&HashMap::new(),&WaveState::default());assert_eq!(result.iter().map(|t|t.id.as_str()).collect::<Vec<_>>(),vec!["deezer_2"]);
        taste.cold_start=false;taste.favorites.insert(300);
        let result=rank(&tracks,&taste,&HashMap::new(),&WaveState::default());assert_eq!(result[0].id,"deezer_3");assert!(!result.iter().any(|t|t.id=="deezer_1"));assert!(taste.personalized());
        taste.blocked.insert("deezer_3".into());assert!(rank(&tracks,&taste,&HashMap::new(),&WaveState::default()).iter().all(|t|t.id!="deezer_3"));
    }
    #[test]fn favorite_collaborator_is_used_before_audio_analysis(){
        let mut collaboration=t(1,100);collaboration.contributors.push(crate::ArtistCredit{id:200,name:"Guest".into(),role:"Featured".into()});
        let mut taste=Taste::default();taste.favorites.insert(200);taste.centroids=vec![vec![1.;512]];
        let result=rank(&[t(2,100),collaboration],&taste,&HashMap::new(),&WaveState::default());assert_eq!(result.len(),1);assert_eq!(result[0].id,"deezer_1");
    }
}
