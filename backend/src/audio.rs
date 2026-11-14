//! Full-length public audio resolution, bounded streaming and disk LRU.
//! No cookies, account credentials, DRM or authentication bypasses are used.
use crate::{ApiError, Track};
use axum::{body::Body, http::{Request, StatusCode, Method, header}, response::Response};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{SqlitePool, Row};
use std::{collections::{HashMap,HashSet,VecDeque}, path::PathBuf, process::Stdio, sync::{Arc, Weak, Mutex as StdMutex, atomic::{AtomicUsize, Ordering}}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, process::Command, sync::{Mutex, Notify, Semaphore, watch}};
use tower::ServiceExt;
use tower_http::services::ServeFile;

const INITIAL_BUFFER_SECONDS: f64 = 33.0;
const START_BUFFER: u64 = 256 * 1024;
const STREAM_WINDOW: u64 = 1024 * 1024;
const MAX_FILE: u64 = 80 * 1024 * 1024;
const SOUNDCLOUD_FORMAT: &str = "bestaudio[protocol=https]/bestaudio[protocol=http]/bestaudio[protocol=m3u8_native][container=m4a_dash]";
type Locks = Mutex<HashMap<String,Weak<Mutex<()>>>>;
type Active = Arc<StdMutex<HashMap<String,usize>>>;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Candidate {
    pub source: String, pub page_url: String, pub title: String, pub artist: String,
    pub duration: f64, pub upload_date: Option<String>, pub score: i32,
    #[serde(skip_serializing)] pub url: String,
    pub content_type: String, pub byte_len: u64,
    #[serde(default)] pub segmented: bool,
    #[serde(default)] segments: Vec<String>,
    #[serde(default)] segment_durations: Vec<f64>,
}
impl Candidate {
    fn has_segment_timing(&self) -> bool {
        self.segments.len() >= 2 && self.segment_durations.len() + 1 == self.segments.len()
    }

    fn initial_segments(&self) -> usize {
        let mut seconds = 0.0;
        self.segment_durations.iter().take_while(|duration| {
            let include = seconds < INITIAL_BUFFER_SECONDS;
            seconds += **duration;
            include
        }).count()
    }
}

struct BufferGate {
    touched: Instant,
    resume: watch::Sender<bool>,
}

async fn wait_for_buffer(gate: Option<watch::Receiver<bool>>) {
    if let Some(mut gate) = gate {
        let _ = gate.wait_for(|ready| *ready).await;
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct PlaybackInfo {
    pub mode: String, pub source: String, pub duration_sec: f64,
    pub cached: bool, pub uncensored_score: i32, pub uncensored_confirmed: bool,
}
pub struct AudioService {
    db: SqlitePool, client: reqwest::Client, root: PathBuf, budget: u64,
    binary: PathBuf, workers: Semaphore, background_workers: Semaphore, foreground:AtomicUsize,
    resolutions: Mutex<HashMap<String,(Instant,Option<Candidate>)>>,
    locks: Locks, cache_io: Mutex<()>, active: Active,
    prefetch: Arc<PrefetchQueue>,
    youtube_blocked_until: Mutex<Option<Instant>>,
    buffers: StdMutex<HashMap<(String, String), BufferGate>>,
}
#[derive(Default)]
struct PrefetchQueue {
    jobs: StdMutex<PrefetchJobs>,
    ready: Notify,
}
#[derive(Default)]
struct PrefetchJobs {
    pending: VecDeque<(String, bool)>,
    running: HashSet<String>,
}
struct ActiveGuard { active: Active, id: String }
impl Drop for ActiveGuard {
    fn drop(&mut self) { if let Ok(mut map)=self.active.lock() { if let Some(count)=map.get_mut(&self.id) { *count=count.saturating_sub(1); if *count==0 {map.remove(&self.id);} } } }
}
struct PartialGuard { path: PathBuf }
impl Drop for PartialGuard {
    fn drop(&mut self) { let _=std::fs::remove_file(&self.path); }
}

impl AudioService {
    pub fn new(db: SqlitePool) -> Arc<Self> {
        let configured=std::env::var("AUDIO_CACHE_DIR").unwrap_or_else(|_| "data/audio".into());
        let root=std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join(configured);
        let local=PathBuf::from(if cfg!(windows) {".tools/bin/yt-dlp.exe"}else{".tools/bin/yt-dlp"});
        let binary=std::env::var_os("YT_DLP_PATH").map(PathBuf::from).unwrap_or_else(|| if local.exists(){local}else{PathBuf::from("yt-dlp")});
        let budget=std::env::var("AUDIO_CACHE_GB").ok().and_then(|v|v.parse::<f64>().ok()).filter(|v|v.is_finite()&&*v>0.0&&*v<=1000.0).unwrap_or(15.0);
        Self::configured(db,root,(budget*1_000_000_000.0) as u64,binary)
    }
    pub fn configured(db:SqlitePool,root:PathBuf,budget:u64,binary:PathBuf)->Arc<Self> {
        let foreground_workers=worker_limit("AUDIO_FOREGROUND_WORKERS");
        let background_workers = worker_limit("AUDIO_BACKGROUND_WORKERS");
        let prefetch = Arc::new(PrefetchQueue::default());
        let service=Arc::new(Self {
            db,root,budget,binary,client:reqwest::Client::builder().timeout(Duration::from_secs(180)).connect_timeout(Duration::from_secs(8)).redirect(reqwest::redirect::Policy::none()).build().expect("valid HTTP client"),
            workers:Semaphore::new(foreground_workers),background_workers:Semaphore::new(background_workers),foreground:AtomicUsize::new(0),resolutions:Mutex::new(HashMap::new()),locks:Mutex::new(HashMap::new()),cache_io:Mutex::new(()),active:Arc::new(StdMutex::new(HashMap::new())),
            prefetch: prefetch.clone(),
            youtube_blocked_until: Mutex::new(None),
            buffers: StdMutex::new(HashMap::new()),
        });
        for _ in 0..background_workers {
            let weak = Arc::downgrade(&service);
            let queue = prefetch.clone();
            tokio::spawn(async move {
                loop {
                    let Some(service) = weak.upgrade() else { break; };
                    let ready = queue.ready.notified();
                    tokio::pin!(ready);
                    ready.as_mut().enable();
                    let id = {
                        let mut jobs = queue.jobs.lock().unwrap();
                        jobs.pending.pop_front().map(|(id, _)| {
                            jobs.running.insert(id.clone());
                            id
                        })
                    };
                    let Some(id) = id else {
                        drop(service);
                        tokio::select! {
                            _ = ready => {},
                            _ = tokio::time::sleep(Duration::from_secs(30)) => {},
                        }
                        continue;
                    };
                    let _running = QueuedGuard { queue: queue.clone(), id: id.clone() };
                    let Ok(Some(track)) = sqlx::query_as::<_, Track>("SELECT * FROM tracks WHERE id=?")
                        .bind(&id).fetch_optional(&service.db).await else { continue; };
                    if service.cached(&id).await.ok().flatten().is_none() {
                        if let Ok(Some(candidate)) = service.resolve_priority(&track, true).await {
                            let _ = service.warm_start(&track, &candidate).await;
                        }
                    }
                }
            });
        }
        let weak=Arc::downgrade(&service);
        tokio::spawn(async move {
            let mut interval=tokio::time::interval(Duration::from_secs(60));
            interval.tick().await;
            loop { interval.tick().await; let Some(service)=weak.upgrade()else{break;}; if let Err(error)=service.evict().await {tracing::warn!(%error,"Audio cache cleanup failed");} }
        });
        service
    }
    pub fn prefetch(&self, ids: impl IntoIterator<Item=String>) {
        self.schedule_prefetch(ids, false);
    }
    pub fn prefetch_playback(&self, ids: impl IntoIterator<Item=String>) {
        self.schedule_prefetch(ids, true);
    }
    fn schedule_prefetch(&self, ids: impl IntoIterator<Item=String>, priority: bool) {
        let ids: Vec<_> = ids.into_iter().take(5).filter(|id| valid_id(id)).collect();
        let mut jobs = self.prefetch.jobs.lock().unwrap();
        for id in ids.into_iter().rev() {
            if jobs.running.contains(&id) { continue; }
            if let Some(index) = jobs.pending.iter().position(|(queued, _)| queued == &id) {
                if !priority { continue; }
                jobs.pending.remove(index);
            }
            if priority {
                jobs.pending.push_front((id, true));
                jobs.pending.truncate(20);
            } else if jobs.pending.len() < 20 {
                let after_playback = jobs.pending.iter().take_while(|(_, priority)| *priority).count();
                jobs.pending.insert(after_playback, (id, false));
            }
        }
        drop(jobs);
        self.prefetch.ready.notify_waiters();
        self.prefetch.ready.notify_one();
    }
    async fn lock(&self,key:String)->Arc<Mutex<()>> {
        let mut map=self.locks.lock().await;
        if let Some(lock)=map.get(&key).and_then(Weak::upgrade){return lock;}
        map.retain(|_,lock|lock.strong_count()>0);
        let lock=Arc::new(Mutex::new(()));map.insert(key,Arc::downgrade(&lock));lock
    }
    fn path(&self,id:&str)->PathBuf {self.root.join(format!("{id}.audio"))}
    async fn cached(&self,id:&str)->Result<Option<(PathBuf,String,f64,i32)>,ApiError> {
        let row=sqlx::query("SELECT a.file_size_bytes,a.content_type,a.duration_sec,a.is_uncensored_score,a.source_title,t.title AS expected_title,t.artist AS expected_artist FROM audio_cache a JOIN tracks t ON t.id=a.track_id WHERE a.track_id=? AND a.local_file_path IS NOT NULL").bind(id).fetch_optional(&self.db).await?;
        if let Some(row)=row {
            let path=self.path(id);
            let valid_version=version_matches(row.get::<&str,_>("source_title"),row.get::<&str,_>("expected_title"),row.get::<&str,_>("expected_artist"));
            if let Ok(meta)=tokio::fs::metadata(&path).await { if valid_version && meta.len()>0 && meta.len()==row.get::<i64,_>("file_size_bytes") as u64 {
                return Ok(Some((path,row.get("content_type"),row.get::<Option<f64>,_>("duration_sec").unwrap_or(0.0),row.get("is_uncensored_score"))));
            }}
            sqlx::query("DELETE FROM audio_cache WHERE track_id=?").bind(id).execute(&self.db).await?;
        }
        Ok(None)
    }
    pub async fn info(&self,t:&Track)->Result<PlaybackInfo,ApiError> {
        if let Some((_,_,duration,score))=self.cached(&t.id).await? {return Ok(PlaybackInfo{mode:"full".into(),source:"cache".into(),duration_sec:duration,cached:true,uncensored_score:score,uncensored_confirmed:false});}
        if let Some(c)=self.resolve(t).await? {Ok(PlaybackInfo{mode:"full".into(),source:c.source,duration_sec:c.duration,cached:false,uncensored_score:c.score,uncensored_confirmed:false})}
        else {Err(ApiError::full_audio_unavailable())}
    }
    fn buffer_gate(&self, id: &str, token: &str, continued: bool) -> Option<watch::Receiver<bool>> {
        if !valid_id(id) || token.len() != 36 || !token.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-') {
            return None;
        }
        let mut buffers = self.buffers.lock().ok()?;
        buffers.retain(|_, gate| gate.resume.receiver_count() > 0 || gate.touched.elapsed() < Duration::from_secs(1800));
        let key = (id.to_owned(), token.to_owned());
        if buffers.len() >= 2048 && !buffers.contains_key(&key) {
            let oldest = buffers.iter().filter(|(_, gate)| gate.resume.receiver_count() == 0)
                .min_by_key(|(_, gate)| gate.touched).map(|(key, _)| key.clone());
            buffers.remove(&oldest?);
        }
        let gate = buffers.entry(key).or_insert_with(|| BufferGate {
            touched: Instant::now(),
            resume: watch::channel(false).0,
        });
        gate.touched = Instant::now();
        if continued { gate.resume.send_replace(true); }
        Some(gate.resume.subscribe())
    }
    pub fn continue_stream(&self, id: &str, token: &str) -> Result<(), ApiError> {
        self.buffer_gate(id, token, true).ok_or_else(|| ApiError::bad_request("Некорректный буфер воспроизведения."))?;
        Ok(())
    }
    fn requested_gate(&self, id: &str, request: &Request<Body>) -> Option<watch::Receiver<bool>> {
        let token = request.uri().query()?.split('&').find_map(|part| part.strip_prefix("buffer="))?;
        self.buffer_gate(id, token, false)
    }
    pub fn has_foreground_work(&self)->bool {self.foreground.load(Ordering::Relaxed)>0}
    pub async fn resolve(&self,t:&Track)->Result<Option<Candidate>,ApiError> {self.resolve_priority(t,false).await}
    async fn resolve_priority(&self,t:&Track,background:bool)->Result<Option<Candidate>,ApiError> {
        let _foreground=if !background{self.foreground.fetch_add(1,Ordering::Relaxed);Some(ForegroundGuard(&self.foreground))}else{None};
        // Background preparation cannot own the foreground resolver lock.
        let mutex=self.lock(format!("resolve:{}:{}",if background{"bg"}else{"fg"},t.id)).await;
        let _guard=mutex.lock().await;
        {
            let map=self.resolutions.lock().await;
            if let Some((at,result))=map.get(&t.id){if at.elapsed()<Duration::from_secs(600)&&result.as_ref().is_some_and(|c|(!c.segmented||c.has_segment_timing())&&candidate_unexpired(c)){return Ok(result.clone());}}
        }
        let row=sqlx::query("SELECT candidate_json,expires_at FROM audio_resolutions WHERE track_id=?").bind(&t.id).fetch_optional(&self.db).await?;
        let previous=row.as_ref().and_then(|r|serde_json::from_str::<Candidate>(r.get::<&str,_>("candidate_json")).ok()).filter(|c|version_matches(&c.title,&t.title,&t.artist));
        if row.as_ref().is_some_and(|r|r.get::<i64,_>("expires_at")>now_seconds() as i64) {
            if let Some(c)=previous.as_ref().filter(|c|candidate_unexpired(c) && (!c.segmented||c.has_segment_timing())){self.remember(&t.id,Some(c.clone())).await;return Ok(Some(c.clone()));}
        }
        let query=format!("{} {}",t.artist,t.title);
        let search=async {
            let primary=async {
                if let Some(old)=previous.as_ref().filter(|c|c.source=="soundcloud") {
                    if let Ok(Some(c))=self.enrich(old.clone(),t,background).await{return Some(c);}
                }
                self.lookup("soundcloud",&query,t,background).await.ok().flatten()
            };
            let backup=async {
                // Give SoundCloud first access to the extractor when only one slot is available.
                tokio::time::sleep(Duration::from_millis(150)).await;
                if let Some(old)=previous.as_ref().filter(|c|c.source=="youtube") {
                    if let Ok(Some(c))=self.enrich(old.clone(),t,background).await{return Some(c);}
                }
                self.lookup("youtube",&query,t,background).await.ok().flatten()
            };
            prefer_primary(primary,backup,Duration::from_millis(700)).await
        };
        let resolution=async {
            if background {search.await} else {
                // A click may arrive while the same song is already being
                // prepared. Reuse that result immediately instead of waiting
                // for the duplicate extractor to finish its network requests.
                tokio::select!{result=search=>result,result=self.wait_prepared(&t.id)=>Some(result)}
            }
        };
        let result = tokio::time::timeout(Duration::from_secs(if background { 18 } else { 24 }), resolution).await;
        let completed = result.is_ok();
        let best = result.ok().flatten();
        if let Some(c)=best.as_ref(){
            let mut value=serde_json::to_value(c).map_err(|_|media_error("resolution serialization failed"))?;
            value["url"]=Value::String(c.url.clone());
            let expires=reqwest::Url::parse(&c.url).ok().and_then(|u|u.query_pairs().find(|(k,_)|k=="expire").and_then(|(_,v)|v.parse::<u64>().ok())).map(|v|v.saturating_sub(20)).unwrap_or(now_seconds()+600).min(now_seconds()+3600);
            sqlx::query("INSERT INTO audio_resolutions (track_id,candidate_json,source_url,expires_at) VALUES (?,?,?,?) ON CONFLICT(track_id) DO UPDATE SET candidate_json=excluded.candidate_json,source_url=excluded.source_url,expires_at=excluded.expires_at,updated_at=CURRENT_TIMESTAMP")
                .bind(&t.id).bind(value.to_string()).bind(&c.page_url).bind(expires as i64).execute(&self.db).await?;
        }
        if completed && best.is_some() { self.remember(&t.id,best.clone()).await; }
        Ok(best)
    }
    async fn wait_prepared(&self,id:&str)->Candidate {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let result=self.resolutions.lock().await.get(id).filter(|(at,c)|at.elapsed()<Duration::from_secs(600)&&c.as_ref().is_some_and(candidate_unexpired)).and_then(|(_,c)|c.clone());
            if let Some(c)=result {
                if !c.segmented||c.has_segment_timing(){return c;}
            }
        }
    }
    async fn remember(&self,id:&str,result:Option<Candidate>) {
        let mut map=self.resolutions.lock().await;map.retain(|_,(at,_)|at.elapsed()<Duration::from_secs(600));
        if result.is_none()&&map.get(id).is_some_and(|(_,c)|c.as_ref().is_some_and(candidate_unexpired)){return;}
        if map.len()>=256{if let Some(old)=map.iter().min_by_key(|(_, (at,_))|*at).map(|(key,_)|key.clone()){map.remove(&old);}}
        map.insert(id.into(),(Instant::now(),result));
    }
    async fn lookup(&self,source:&str,query:&str,t:&Track,background:bool)->Result<Option<Candidate>,()> {
        if source=="soundcloud" {
            // SoundCloud can return the top match and its stream together. The
            // common path needs one extractor process instead of search+enrich.
            let target=format!("scsearch1:{query}");
            if let Ok(data)=self.run(&["-f",SOUNDCLOUD_FORMAT,"--dump-single-json",&target],background).await {
                let value=data["entries"].as_array().and_then(|v|v.first()).unwrap_or(&data);
                if let Some(c)=candidate(value,source,t) {
                    if let Ok(Some(c))=self.ready(c,value,t,background).await{return Ok(Some(c));}
                }
            }
        }
        // Filter cheap search metadata before extracting any media. A blocked or
        // mismatched first hit must not consume the entire playback deadline.
        let target=format!("{}6:{query}",if source=="youtube"{"ytsearch"}else{"scsearch"});
        let data=self.run(&["--flat-playlist","--dump-single-json",&target],background).await?;
        let mut choices:Vec<_>=data["entries"].as_array().into_iter().flatten().filter_map(|v|candidate_from_metadata(v, source, t, false)).collect();
        choices.sort_by_key(|c|std::cmp::Reverse(c.score));
        for c in choices.into_iter().take(4){if let Ok(Some(c))=self.enrich(c,t,background).await{return Ok(Some(c));}}
        Ok(None)
    }
    async fn enrich(&self,c:Candidate,t:&Track,background:bool)->Result<Option<Candidate>,()> {
        let format=if c.source=="soundcloud"{SOUNDCLOUD_FORMAT}else{"bestaudio[protocol=https]/bestaudio[protocol=http]/best[protocol=https]"};
        let data=self.run(&["--no-playlist","--js-runtimes","node","-f",format,"--dump-single-json",&c.page_url],background).await?;
        let Some(c)=candidate(&data,&c.source,t)else{return Ok(None);};self.ready(c,&data,t,background).await
    }
    async fn ready(&self,mut c:Candidate,data:&Value,t:&Track,background:bool)->Result<Option<Candidate>,()> {
        c.url=data["url"].as_str().unwrap_or("").into();if !allowed_media_url(&c.url){return Ok(None);}
        if data["protocol"]=="m3u8_native" && data["container"]=="m4a_dash" && c.source=="soundcloud" {
            return self.prepare_hls(c,t).await.map(Some);
        }
        c.content_type=match data["ext"].as_str(){Some("m4a"|"mp4")=>"audio/mp4",Some("webm")=>"audio/webm",Some("ogg"|"opus")=>"audio/ogg",Some("mp3")=>"audio/mpeg",_=>return Ok(None)}.into();
        let mut probe=tokio::time::timeout(Duration::from_secs(5),self.request(&c.url,Some("bytes=0-262143"),Method::GET)).await.map_err(|_|())?.map_err(|_|())?;
        let kind=probe.headers().get(header::CONTENT_TYPE).and_then(|v|v.to_str().ok()).unwrap_or("");
        if !probe.status().is_success()||!(kind.starts_with("audio/")||kind.starts_with("video/")||kind.starts_with("application/octet-stream")){return Ok(None);}
        c.byte_len=if probe.status()==StatusCode::PARTIAL_CONTENT{probe.headers().get(header::CONTENT_RANGE).and_then(|v|v.to_str().ok()).and_then(parse_content_range).filter(|(start,_,_)|*start==0).map(|(_,_,total)|total).unwrap_or(0)}else{probe.content_length().unwrap_or(0)};
        if c.byte_len==0||c.byte_len>MAX_FILE{return Ok(None);}
        if !background { return Ok(Some(c)); }
        let take=c.byte_len.min(START_BUFFER) as usize;
        let mut head=Vec::with_capacity(take);
        let read=async {while head.len()<take {let Some(chunk)=probe.chunk().await.map_err(|_|())?else{break;};head.extend_from_slice(&chunk[..chunk.len().min(take-head.len())]);}Ok::<_,()>(())};
        let _ = tokio::time::timeout(Duration::from_secs(4), read).await;
        if !head.is_empty() { self.save_head(t, &c, &head).await; }
        Ok(Some(c))
    }
    async fn save_head(&self, t: &Track, c: &Candidate, head: &[u8]) {
        let _io = self.cache_io.lock().await;
        let _ = tokio::fs::create_dir_all(&self.root).await;
        let temp = self.root.join(format!("{}.headtmp", t.id));
        let _partial = PartialGuard { path: temp.clone() };
        if tokio::fs::write(&temp, head).await.is_ok()
            && tokio::fs::rename(&temp, self.root.join(format!("{}.head", t.id))).await.is_ok()
        {
            let _ = sqlx::query("INSERT INTO audio_heads (track_id,stream_url,byte_len,head_size) VALUES (?,?,?,?) ON CONFLICT(track_id) DO UPDATE SET stream_url=excluded.stream_url,byte_len=excluded.byte_len,head_size=excluded.head_size,last_accessed_at=CURRENT_TIMESTAMP")
                .bind(&t.id).bind(&c.url).bind(c.byte_len as i64).bind(head.len() as i64).execute(&self.db).await;
        }
    }
    async fn prepare_hls(&self, mut c: Candidate, t: &Track) -> Result<Candidate, ()> {
        let fetch_playlist = async {
            let response = self.request(&c.url, None, Method::GET).await.map_err(|_| ())?;
            if !response.status().is_success() { return Err(()); }
            bounded_bytes(response, 256 * 1024).await
        };
        let playlist = tokio::time::timeout(Duration::from_secs(5), fetch_playlist).await.map_err(|_| ())??;
        (c.segments, c.segment_durations) = hls_segments(std::str::from_utf8(&playlist).map_err(|_| ())?, &c.url, c.duration).ok_or(())?;
        c.segmented = true;
        c.content_type = "audio/mp4".into();
        let (mut init, first) = tokio::try_join!(
            self.fetch_segment(&c.segments[0]), self.fetch_segment(&c.segments[1])
        ).map_err(|_| ())?;
        init.extend(first);
        self.save_head(t, &c, &init).await;
        Ok(c)
    }
    async fn warm_start(&self, track: &Track, candidate: &Candidate) -> Result<(), ()> {
        if candidate.segmented || self.head(track, candidate).await.is_some() { return Ok(()); }
        let limit = START_BUFFER.min(candidate.byte_len);
        if limit == 0 { return Err(()); }
        let fetch = async {
            let (response, end) = self.fragment(candidate, 0, limit - 1).await.map_err(|_| ())?;
            if end >= START_BUFFER { return Err(()); }
            bounded_bytes(response, START_BUFFER as usize).await
        };
        let bytes = tokio::time::timeout(Duration::from_secs(4), fetch).await.map_err(|_| ())??;
        if !bytes.is_empty() { self.save_head(track, candidate, &bytes).await; }
        Ok(())
    }
    async fn fetch_segment(&self, url: &str) -> Result<Vec<u8>, std::io::Error> {
        for _ in 0..2 {
            let fetch = async {
                let response = self.request(url, None, Method::GET).await.map_err(|_| ())?;
                if !response.status().is_success() { return Err(()); }
                bounded_bytes(response, 4 * 1024 * 1024).await
            };
            if let Ok(Ok(bytes)) = tokio::time::timeout(Duration::from_secs(5), fetch).await {
                if !bytes.is_empty() { return Ok(bytes); }
            }
        }
        Err(std::io::Error::other("audio segment unavailable"))
    }
    async fn stream_hls(self: &Arc<Self>, t: &Track, c: Candidate, request: Request<Body>) -> Result<Response, ApiError> {
        // A fragmented MP4 can play while it arrives. Its total byte length is
        // known only after assembly, so Range is available from the disk cache.
        let response = Response::builder().header(header::CONTENT_TYPE, "audio/mp4")
            .header(header::CACHE_CONTROL, "no-store").header("x-yamusic-mode", "full");
        if request.method() == Method::HEAD {
            return response.body(Body::empty()).map_err(|_| media_error("head response failed"));
        }
        let head = if let Some(head) = self.head(t, &c).await {
            head
        } else {
            let (mut init, first) = tokio::try_join!(
                self.fetch_segment(&c.segments[0]), self.fetch_segment(&c.segments[1])
            ).map_err(|_| media_error("audio start unavailable"))?;
            init.extend(first);
            init.into()
        };
        let lock = self.lock(format!("file:{}", t.id)).await;
        let writer = lock.try_lock_owned().ok();
        let partial = self.root.join(format!("{}.part", t.id));
        let file = if writer.is_some() {
            let _ = tokio::fs::create_dir_all(&self.root).await;
            tokio::fs::File::create(&partial).await.ok()
        } else { None };
        let part = file.as_ref().map(|_| PartialGuard { path: partial });
        let service = self.clone();
        let remaining = c.segments.len() - 1;
        let gate = self.requested_gate(&t.id, &request);
        let initial_segments = c.initial_segments();
        let urls = c.segments[2..].to_vec();
        let segments = futures_util::stream::iter(urls.into_iter().enumerate().map(move |(index, url)| {
            let service = service.clone();
            let gate = gate.clone().filter(|_| index + 1 >= initial_segments);
            async move {
                wait_for_buffer(gate).await;
                service.fetch_segment(&url).await.map(axum::body::Bytes::from)
            }
        })).buffered(3);
        let active = self.active_guard(&t.id);
        let state = StreamState {
            file, upstream: None, head: None, service: self.clone(), track: t.clone(),
            candidate: c, count: 0, length: None, position: 0, end: 0, segment_end: 0,
            retries: 0, buffer_gate: None, _part: part, _writer: writer, _active: active,
        };
        let body = futures_util::stream::try_unfold(
            (state, Some(head), Box::pin(segments), remaining),
            |(mut state, head, mut segments, remaining)| async move {
                let chunk = match head {
                    Some(bytes) => bytes,
                    None => match segments.next().await {
                        Some(result) => result?,
                        None => return Ok::<_, std::io::Error>(None),
                    }
                };
                state.count += chunk.len() as u64;
                if state.count > MAX_FILE { return Err(std::io::Error::other("audio exceeds size limit")); }
                if let Some(file) = state.file.as_mut() {
                    if state.count > state.service.budget || file.write_all(&chunk).await.is_err() {
                        state.file = None;
                    }
                }
                if remaining == 1 { state.finish().await; }
                Ok(Some((chunk, (state, None, segments, remaining - 1))))
            }
        );
        response.body(Body::from_stream(body)).map_err(|_| media_error("invalid audio response"))
    }
    async fn run(&self,args:&[&str],background:bool)->Result<Value,()> {
        let youtube = args.last().is_some_and(|target| target.starts_with("ytsearch") || target.starts_with("https://www.youtube.com/") || target.starts_with("https://youtube.com/"));
        if youtube && self.youtube_blocked_until.lock().await.is_some_and(|until| until > Instant::now()) { return Err(()); }
        let pool=if background{&self.background_workers}else{&self.workers};
        // A 1-worker VPS must allow the speculative backup to wait for an
        // in-flight extractor; the whole resolution still has its own deadline.
        let _permit=tokio::time::timeout(Duration::from_secs(35),pool.acquire()).await.map_err(|_|())?.map_err(|_|())?;
        if youtube && self.youtube_blocked_until.lock().await.is_some_and(|until| until > Instant::now()) { return Err(()); }
        let mut command=Command::new(&self.binary);
        command.args(["--ignore-config","--no-warnings","--skip-download","--socket-timeout","6","--retries","0","--no-progress"])
            .args(args).stdin(Stdio::null()).stderr(Stdio::piped()).stdout(Stdio::piped()).kill_on_drop(true);
        #[cfg(windows)] command.creation_flags(0x08000000);
        let mut child=command.spawn().map_err(|_|())?;let stdout=child.stdout.take().ok_or(())?;let mut buffer=Vec::new();
        let stderr = child.stderr.take().ok_or(())?;
        let mut errors = Vec::new();
        let read = async {
            let mut stdout = stdout.take(6 * 1024 * 1024 + 1);
            let mut stderr = stderr.take(64 * 1024 + 1);
            tokio::try_join!(
                stdout.read_to_end(&mut buffer),
                stderr.read_to_end(&mut errors)
            )
        };
        let result=tokio::time::timeout(Duration::from_secs(12),read).await;
        if !matches!(result,Ok(Ok(_)))||buffer.len()>6*1024*1024||errors.len()>64*1024{tracing::warn!(background,"Audio extractor timed out or exceeded output limit");let _=child.kill().await;return Err(());}
        let status=tokio::time::timeout(Duration::from_secs(2),child.wait()).await.map_err(|_|())?.map_err(|_|())?;
        if !status.success() {
            let sign_in_required = youtube && String::from_utf8_lossy(&errors).contains("Sign in to confirm");
            if sign_in_required { *self.youtube_blocked_until.lock().await = Some(Instant::now() + Duration::from_secs(60)); }
            tracing::warn!(background, sign_in_required, code=?status.code(), "Audio extractor failed");
            return Err(());
        }
        serde_json::from_slice(&buffer).map_err(|_| ())
    }
    async fn head(&self,t:&Track,c:&Candidate)->Option<axum::body::Bytes> {
        let _io=self.cache_io.lock().await;
        let row=sqlx::query("SELECT head_size FROM audio_heads WHERE track_id=? AND stream_url=? AND byte_len=?").bind(&t.id).bind(&c.url).bind(c.byte_len as i64).fetch_optional(&self.db).await.ok()??;
        let bytes=tokio::fs::read(self.root.join(format!("{}.head",t.id))).await.ok()?;
        if bytes.len()!=row.get::<i64,_>("head_size") as usize{return None;}
        let _=sqlx::query("UPDATE audio_heads SET last_accessed_at=CURRENT_TIMESTAMP WHERE track_id=?").bind(&t.id).execute(&self.db).await;
        Some(bytes.into())
    }
    async fn request(&self,url:&str,range:Option<&str>,method:Method)->Result<reqwest::Response,ApiError> {
        let mut current=url.to_string();
        for _ in 0..5 {
            if !allowed_media_url(&current) {return Err(media_error("unsupported media host"));}
            let mut request=self.client.request(method.clone(),&current).timeout(Duration::from_secs(25));
            if let Some(range)=range{request=request.header(header::RANGE,range);}
            let response=request.send().await.map_err(ApiError::upstream)?;
            if response.status().is_redirection() {
                let location=response.headers().get(header::LOCATION).and_then(|h|h.to_str().ok()).ok_or_else(||media_error("invalid redirect"))?;
                current=reqwest::Url::parse(&current).and_then(|u|u.join(location)).map_err(|_|media_error("invalid redirect"))?.to_string();
                continue;
            }
            return Ok(response);
        }
        Err(media_error("too many redirects"))
    }
    pub async fn stream(self:&Arc<Self>,t:&Track,request:Request<Body>)->Result<Response,ApiError> {
        // A reader is marked active under the same lock used by eviction.
        let io=self.cache_io.lock().await;
        if let Some((path,mime,duration,_))=self.cached(&t.id).await? {
            let guard=self.active_guard(&t.id);
            sqlx::query("UPDATE audio_cache SET last_accessed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE track_id=?").bind(&t.id).execute(&self.db).await?;
            let gate = self.requested_gate(&t.id, &request);
            let bytes = if gate.is_some() { tokio::fs::metadata(&path).await.ok().map(|meta| meta.len()) } else { None };
            let response=ServeFile::new(path).oneshot(request).await.map_err(|_|media_error("cache read failed"))?;
            let (mut parts,body)=response.into_parts();parts.headers.insert(header::CONTENT_TYPE,mime.parse().map_err(|_|media_error("invalid audio type"))?);
            if parts.status.is_success() {
                parts.headers.insert("x-yamusic-mode", header::HeaderValue::from_static("full"));
            }
            drop(io);
            let start = parts.headers.get(header::CONTENT_RANGE).and_then(|value| value.to_str().ok())
                .and_then(parse_content_range).map_or(0, |(start, _, _)| start);
            let length = parts.headers.get(header::CONTENT_LENGTH).and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok()).unwrap_or(0);
            let gate = bytes.zip(gate).filter(|_| parts.status.is_success()).and_then(|(bytes, gate)| {
                let limit = initial_byte_limit(bytes, duration);
                (start < limit && limit < start.saturating_add(length)).then_some((limit, gate))
            });
            let stream = futures_util::stream::try_unfold(
                (Body::new(body).into_data_stream(), guard, start, gate),
                |(mut stream, guard, mut position, mut gate)| async move {
                    if gate.as_ref().is_some_and(|(limit, _)| position >= *limit) {
                        wait_for_buffer(gate.take().map(|(_, gate)| gate)).await;
                    }
                    let Some(chunk) = stream.next().await else { return Ok::<_, axum::Error>(None); };
                    let chunk = chunk?;
                    position += chunk.len() as u64;
                    Ok(Some((chunk, (stream, guard, position, gate))))
                },
            );
            return Ok(Response::from_parts(parts,Body::from_stream(stream)));
        }
        drop(io);
        if request.uri().query().is_some_and(|q|q.split('&').any(|p|p=="refresh=1")) {
            self.invalidate(&t.id).await?;
        }
        if let Some(candidate)=self.resolve(t).await? {
            if self.cached(&t.id).await?.is_some(){return Box::pin(self.stream(t,request)).await;}
            let retry = !request.uri().query().is_some_and(|q| q.split('&').any(|p| p == "refresh=1"));
            let original_query = request.uri().query().unwrap_or_default();
            let mut renewal = Request::builder().method(request.method()).uri(format!("/?refresh=1&{original_query}"));
            if let Some(range) = request.headers().get(header::RANGE) {
                renewal = renewal.header(header::RANGE, range);
            }
            let response = if candidate.segmented {
                self.stream_hls(t, candidate, request).await
            } else {
                self.stream_full(t, candidate, request).await
            };
            if retry && response.as_ref().is_err_and(|error| error.status.is_server_error()) {
                return Box::pin(self.stream(t, renewal.body(Body::empty()).map_err(|_| media_error("invalid retry"))?)).await;
            }
            return response;
        }
        Err(ApiError::full_audio_unavailable())
    }
    async fn invalidate(&self,id:&str)->Result<(),ApiError> {
        // Keep the public page so resolve can renew its signed media URL first.
        self.resolutions.lock().await.remove(id);
        sqlx::query("UPDATE audio_resolutions SET expires_at=0 WHERE track_id=?").bind(id).execute(&self.db).await?;
        Ok(())
    }
    fn active_guard(&self,id:&str)->ActiveGuard {
        if let Ok(mut map)=self.active.lock(){*map.entry(id.into()).or_default()+=1;}
        ActiveGuard{active:self.active.clone(),id:id.into()}
    }
    async fn fragment(&self,c:&Candidate,start:u64,end:u64)->Result<(reqwest::Response,u64),ApiError> {
        let response=self.request(&c.url,Some(&format!("bytes={start}-{end}")),Method::GET).await?;
        if response.status()==StatusCode::PARTIAL_CONTENT {
            let range=response.headers().get(header::CONTENT_RANGE).and_then(|v|v.to_str().ok()).and_then(parse_content_range).ok_or_else(||media_error("missing upstream byte range"))?;
            if range.0!=start||range.1>end||range.2!=c.byte_len{return Err(media_error("upstream byte range mismatch"));}
            return Ok((response,range.1));
        }
        if response.status()==StatusCode::OK&&start==0&&response.content_length()==Some(c.byte_len){return Ok((response,c.byte_len-1));}
        Err(media_error("upstream audio rejected byte range"))
    }
    async fn stream_full(self:&Arc<Self>,t:&Track,c:Candidate,request:Request<Body>)->Result<Response,ApiError> {
        let range=request.headers().get(header::RANGE).map(|h|h.to_str().map(str::to_owned)).transpose().map_err(|_|ApiError::bad_request("Некорректная перемотка."))?;
        if range.as_ref().is_some_and(|r|!valid_range(r)){return Err(ApiError::bad_request("Поддерживается один диапазон байтов."));}
        let Some((start,end))=requested_range(range.as_deref(),c.byte_len)else{
            return Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE).header(header::CONTENT_RANGE,format!("bytes */{}",c.byte_len)).header(header::ACCEPT_RANGES,"bytes").body(Body::empty()).map_err(|_|media_error("range response failed"));
        };
        let length=end-start+1;
        let mut response=Response::builder().status(if range.is_some(){StatusCode::PARTIAL_CONTENT}else{StatusCode::OK})
            .header(header::CONTENT_TYPE,&c.content_type).header(header::ACCEPT_RANGES,"bytes").header(header::CONTENT_LENGTH,length).header("x-yamusic-mode","full");
        if range.is_some(){response=response.header(header::CONTENT_RANGE,format!("bytes {start}-{end}/{}",c.byte_len));}
        if request.method()==Method::HEAD{return response.body(Body::empty()).map_err(|_|media_error("head response failed"));}
        // A direct file has a byte length but may have a variable bitrate.
        // Leave headroom so metadata, container overhead and bitrate peaks fit.
        let initial_limit = initial_byte_limit(c.byte_len, c.duration);
        let gate = self.requested_gate(&t.id, &request).filter(|_| start < initial_limit);
        let initial_request_end = if gate.is_some() {
            end.min(initial_limit - 1)
        } else { end };
        let head=if start < START_BUFFER {
            self.head(t,&c).await.filter(|head| start < head.len() as u64).map(|head| head.slice(start as usize..))
        } else { None };
        let (upstream,segment_end)=if head.is_some(){(None,0)}else{let first = self.fragment(&c,start,initial_request_end.min(start.saturating_add(STREAM_WINDOW - 1)));
            let (response,end)=tokio::time::timeout(Duration::from_secs(5), first).await.map_err(|_|media_error("audio startup timeout"))??;(Some(response),end)};
        let lock=self.lock(format!("file:{}",t.id)).await;
        let write_guard=if start==0&&end+1==c.byte_len&&c.byte_len<=self.budget{lock.try_lock_owned().ok()}else{None};
        let file=if write_guard.is_some(){tokio::fs::create_dir_all(&self.root).await.ok();tokio::fs::File::create(self.root.join(format!("{}.part",t.id))).await.ok()}else{None};
        let part=if file.is_some(){Some(PartialGuard{path:self.root.join(format!("{}.part",t.id))})}else{None};
        let active=self.active_guard(&t.id);
        let state=StreamState {file,upstream,head,service:self.clone(),track:t.clone(),candidate:c,count:0,length:Some(length),position:start,end,segment_end,retries:0,buffer_gate:gate.map(|gate| (initial_limit,gate)),_part:part,_writer:write_guard,_active:active};
        response.body(stream_body(state)).map_err(|_|media_error("invalid stream response"))
    }
    pub async fn evict(&self)->Result<(),sqlx::Error> {
        let _io=self.cache_io.lock().await;
        let heads=sqlx::query("SELECT track_id,head_size FROM audio_heads ORDER BY last_accessed_at ASC").fetch_all(&self.db).await?;
        let mut head_bytes=heads.iter().map(|r|r.get::<i64,_>("head_size").max(0) as u64).sum::<u64>();
        let mut head_count=heads.len();
        for row in heads {
            if head_bytes<=(self.budget/4).min(16*1024*1024)&&head_count<=64{break;}
            let id:String=row.get("track_id");if !valid_id(&id){continue;}
            if self.active.lock().map(|m|m.contains_key(&id)).unwrap_or(true){continue;}
            match tokio::fs::remove_file(self.root.join(format!("{id}.head"))).await{Ok(())=>{},Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{},Err(_)=>continue,}
            sqlx::query("DELETE FROM audio_heads WHERE track_id=?").bind(id).execute(&self.db).await?;
            head_bytes=head_bytes.saturating_sub(row.get::<i64,_>("head_size").max(0) as u64);head_count=head_count.saturating_sub(1);
        }
        let rows=sqlx::query("SELECT track_id,file_size_bytes FROM audio_cache WHERE local_file_path IS NOT NULL ORDER BY last_accessed_at ASC,track_id ASC").fetch_all(&self.db).await?;
        let known:std::collections::HashSet<String>=rows.iter().map(|r|r.get("track_id")).collect();
        let known_heads:HashSet<String>=sqlx::query_scalar("SELECT track_id FROM audio_heads").fetch_all(&self.db).await?.into_iter().collect();
        if let Ok(mut entries)=tokio::fs::read_dir(&self.root).await {
            while let Ok(Some(entry))=entries.next_entry().await {
                let name=entry.file_name();let Some(name)=name.to_str()else{continue;};
                let Some((id,ext))=name.rsplit_once('.')else{continue;};
                if !valid_id(id)||!matches!(ext,"part"|"audio"|"head"|"headtmp"){continue;}
                if !entry.file_type().await.is_ok_and(|kind|kind.is_file()){continue;}
                if self.active.lock().map(|m|m.contains_key(id)).unwrap_or(true){continue;}
                let stale_part=matches!(ext,"part"|"headtmp")&&entry.metadata().await.ok().and_then(|m|m.modified().ok()).and_then(|at|at.elapsed().ok()).is_some_and(|age|age>Duration::from_secs(3600));
                if stale_part || (ext=="audio"&&!known.contains(id)) || (ext=="head"&&!known_heads.contains(id)){let _=tokio::fs::remove_file(entry.path()).await;}
            }
        }
        let mut total=rows.iter().map(|r|r.get::<i64,_>("file_size_bytes").max(0) as u64).sum::<u64>()+head_bytes;
        for row in rows {
            if total<=self.budget{break;}
            let id:String=row.get("track_id");if !valid_id(&id){continue;}
            if self.active.lock().map(|m|m.contains_key(&id)).unwrap_or(true){continue;}
            let path=self.path(&id);
            let removed=match tokio::fs::remove_file(path).await {Ok(())=>true,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>true,Err(_)=>false};
            if removed {sqlx::query("DELETE FROM audio_cache WHERE track_id=?").bind(id).execute(&self.db).await?;total=total.saturating_sub(row.get::<i64,_>("file_size_bytes").max(0) as u64);}
        }
        Ok(())
    }
}
struct StreamState {
    // Drop the open file before deleting its partial path (important on Windows).
    file: Option<tokio::fs::File>, upstream: Option<reqwest::Response>, head:Option<axum::body::Bytes>,
    service: Arc<AudioService>, track:Track, candidate:Candidate, count:u64, length:Option<u64>,
    position:u64,end:u64,segment_end:u64,retries:u8,
    buffer_gate: Option<(u64, watch::Receiver<bool>)>,
    _part:Option<PartialGuard>, _writer:Option<tokio::sync::OwnedMutexGuard<()>>, _active:ActiveGuard,
}
impl StreamState {
    async fn finish(&mut self) {
        let Some(mut output)=self.file.take()else{return;};
        if self.count==0 || self.length.is_some_and(|n|n!=self.count) || output.flush().await.is_err(){return;}
        drop(output);
        let service=&self.service;let t=&self.track;let c=&self.candidate;
        let _io=service.cache_io.lock().await;
        if tokio::fs::rename(service.root.join(format!("{}.part",t.id)),service.path(&t.id)).await.is_err(){return;}
        let saved=sqlx::query("INSERT INTO audio_cache (track_id,source_type,source_url,local_file_path,file_size_bytes,is_uncensored_score,content_type,source_title,duration_sec,last_accessed_at) VALUES (?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(track_id) DO UPDATE SET source_type=excluded.source_type,source_url=excluded.source_url,local_file_path=excluded.local_file_path,file_size_bytes=excluded.file_size_bytes,is_uncensored_score=excluded.is_uncensored_score,content_type=excluded.content_type,source_title=excluded.source_title,duration_sec=excluded.duration_sec,last_accessed_at=excluded.last_accessed_at")
            .bind(&t.id).bind(&c.source).bind(&c.page_url).bind(service.path(&t.id).to_string_lossy().to_string()).bind(self.count as i64).bind(c.score).bind(&c.content_type).bind(&c.title).bind(c.duration).execute(&service.db).await;
        if saved.is_err(){let _=tokio::fs::remove_file(service.path(&t.id)).await;}
    }
}
fn stream_body(state:StreamState)->Body {
    let stream=futures_util::stream::try_unfold(state,|mut state|async move {
            loop {
                if state.position>state.end{state.finish().await;return Ok::<_,std::io::Error>(None);}
                if let Some(chunk)=state.head.take(){
                    let remaining=state.end-state.position+1;let chunk=if chunk.len() as u64>remaining{chunk.slice(..remaining as usize)}else{chunk};
                    state.position+=chunk.len() as u64;state.count+=chunk.len() as u64;
                    if let Some(file)=state.file.as_mut(){if file.write_all(&chunk).await.is_err(){state.file=None;}}
                    if state.position>state.end{state.finish().await;}return Ok(Some((chunk,state)));
                }
                if state.buffer_gate.as_ref().is_some_and(|(limit, _)| state.position >= *limit) {
                    wait_for_buffer(state.buffer_gate.take().map(|(_, gate)| gate)).await;
                }
                if state.upstream.is_none(){
                    let end = state.buffer_gate.as_ref().map_or(state.end, |(limit, _)| state.end.min(limit - 1));
                    let (response,end)=state.service.fragment(&state.candidate,state.position,end.min(state.position.saturating_add(STREAM_WINDOW - 1))).await.map_err(|_|std::io::Error::other("audio reconnect failed"))?;
                    state.upstream=Some(response);state.segment_end=end;
                }
                match state.upstream.as_mut().unwrap().chunk().await {
                    Ok(Some(chunk))=>{
                        let remaining=state.end-state.position+1;
                        let chunk=if chunk.len() as u64>remaining{chunk.slice(..remaining as usize)}else{chunk};
                        if chunk.is_empty(){continue;}
                        state.position+=chunk.len() as u64;state.count+=chunk.len() as u64;
                        if let Some(output)=state.file.as_mut(){if output.write_all(&chunk).await.is_err(){state.file=None;}}
                        if state.position>state.end {state.finish().await;}
                        return Ok(Some((chunk,state)));
                    }
                    Ok(None)|Err(_)=>{
                        state.upstream=None;
                        if state.position<=state.segment_end{state.retries+=1;if state.retries>2{return Err(std::io::Error::other("audio interrupted repeatedly"));}}
                        else{state.retries=0;}
                    }
                }
            }
        });
    Body::from_stream(stream)
}
struct QueuedGuard { queue: Arc<PrefetchQueue>, id: String }
impl Drop for QueuedGuard {
    fn drop(&mut self) { self.queue.jobs.lock().unwrap().running.remove(&self.id); }
}
fn worker_limit(key:&str)->usize {std::env::var(key).ok().and_then(|s|s.parse().ok()).unwrap_or(2).clamp(1,2)}
async fn prefer_primary<T>(primary:impl std::future::Future<Output=Option<T>>,backup:impl std::future::Future<Output=Option<T>>,budget:Duration)->Option<T> {
    let grace=tokio::time::sleep(budget);
    tokio::pin!(primary,backup,grace);
    tokio::select! {
        result=&mut primary=>match result {Some(value)=>Some(value),None=>backup.await},
        result=&mut backup=>match result {
            Some(fallback)=>tokio::select!{result=&mut primary=>result.or(Some(fallback)),_=&mut grace=>Some(fallback)},
            None=>primary.await,
        },
        _=&mut grace=>tokio::select! {
            result=&mut primary=>match result{Some(value)=>Some(value),None=>backup.await},
            result=&mut backup=>match result{Some(value)=>Some(value),None=>primary.await},
        },
    }
}
async fn bounded_bytes(mut response:reqwest::Response,limit:usize)->Result<Vec<u8>,()> {
    let mut bytes=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|())? {
        if bytes.len().saturating_add(chunk.len())>limit{return Err(());}
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn hls_segments(playlist:&str,base:&str,expected_duration:f64)->Option<(Vec<String>, Vec<f64>)> {
    // Support complete, unencrypted fMP4 VOD only. Never cache a preview or
    // concatenate transport-stream audio under an MP4 content type.
    if !playlist.starts_with("#EXTM3U") || !playlist.lines().any(|l|l.trim()=="#EXT-X-ENDLIST") || playlist.contains("#EXT-X-KEY:") || playlist.contains("#EXT-X-BYTERANGE:"){return None;}
    let base=reqwest::Url::parse(base).ok()?;let mut result=Vec::new();let mut duration=0.0;
    let mut durations = Vec::new();
    for line in playlist.lines().map(str::trim) {
        let url=if let Some(map)=line.strip_prefix("#EXT-X-MAP:URI=\"") {
            if !result.is_empty(){return None;}Some(map.split('"').next()?)
        }else if let Some(info)=line.strip_prefix("#EXTINF:") {
            let value=info.split(',').next()?.parse::<f64>().ok()?;
            if !value.is_finite()||value<=0.0{return None;}duration+=value;durations.push(value);None
        }else if !line.is_empty()&&!line.starts_with('#') {
            if result.is_empty(){return None;}Some(line)
        }else{None};
        if let Some(url)=url {
            let url=base.join(url).ok()?.to_string();if !allowed_media_url(&url){return None;}
            result.push(url);if result.len()>512{return None;}
        }
    }
    if result.len()<2 || durations.len() + 1 != result.len() || (duration-expected_duration).abs()>4.0{return None;}
    Some((result, durations))
}
struct ForegroundGuard<'a>(&'a AtomicUsize);
impl Drop for ForegroundGuard<'_>{fn drop(&mut self){self.0.fetch_sub(1,Ordering::Relaxed);}}
fn initial_byte_limit(bytes: u64, duration: f64) -> u64 {
    let estimate = ((INITIAL_BUFFER_SECONDS + 8.0) / duration.max(1.0) * bytes as f64).ceil() as u64;
    estimate.max(START_BUFFER).min(bytes)
}
fn now_seconds()->u64 {SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()}
fn candidate_unexpired(c:&Candidate)->bool{reqwest::Url::parse(&c.url).ok().and_then(|u|u.query_pairs().find(|(k,_)|k=="expire").and_then(|(_,v)|v.parse::<u64>().ok())).is_none_or(|expiry|expiry>now_seconds()+20)}
fn media_error(detail:&str)->ApiError {ApiError::provider(detail.into())}
fn valid_id(id:&str)->bool {id.strip_prefix("deezer_").is_some_and(|n|!n.is_empty()&&n.chars().all(|c|c.is_ascii_digit()))}
pub fn valid_range(value:&str)->bool {
    let Some(value)=value.strip_prefix("bytes=")else{return false;};let Some((a,b))=value.split_once('-')else{return false;};
    !value.contains(',')&&!(a.is_empty()&&b.is_empty())&&(a.is_empty()||a.parse::<u64>().is_ok())&&(b.is_empty()||b.parse::<u64>().is_ok())&&
        (a.is_empty()||b.is_empty()||a.parse::<u64>().unwrap()<=b.parse::<u64>().unwrap())
}
fn parse_content_range(value:&str)->Option<(u64,u64,u64)> {
    let value=value.strip_prefix("bytes ")?;let (span,total)=value.split_once('/')?;let (start,end)=span.split_once('-')?;
    let (start,end,total)=(start.parse().ok()?,end.parse().ok()?,total.parse().ok()?);
    if start>end||end>=total{return None;}Some((start,end,total))
}
fn requested_range(value:Option<&str>,total:u64)->Option<(u64,u64)> {
    if total==0{return None;}
    let Some(value)=value else{return Some((0,total-1));};
    if !valid_range(value){return None;}
    let (start,end)=value.strip_prefix("bytes=")?.split_once('-')?;
    if start.is_empty(){let suffix:u64=end.parse().ok()?;return if suffix>0{Some((total.saturating_sub(suffix),total-1))}else{None};}
    let start:u64=start.parse().ok()?;if start>=total{return None;}
    let end=if end.is_empty(){total-1}else{end.parse::<u64>().ok()?.min(total-1)};
    if start>end{return None;}Some((start,end))
}
fn normalized(value:&str)->String {value.to_lowercase().chars().filter(|c|c.is_alphanumeric()).collect()}
fn phrase(value:&str,needle:&str)->bool {
    let words=value.split(|c:char|!c.is_alphanumeric()).filter(|w|!w.is_empty()).collect::<Vec<_>>().join(" ");
    format!(" {words} ").contains(&format!(" {needle} "))
}
fn version_matches(title:&str,expected:&str,artist:&str)->bool {
    let lowered=title.to_lowercase().replacen(&artist.to_lowercase(),"",1);let expected=expected.to_lowercase();
    for word in ["clean","radio edit","censored","cover","кавер","speed up","sped up","nightcore","slowed","remix","ремикс","live","лайв","концерт","concert","tour version","vk музыка летом","выступление"] {
        if phrase(&lowered,word)&&!phrase(&expected,word){return false;}
    }
    true
}
pub fn candidate(v:&Value,source:&str,t:&Track)->Option<Candidate> {
    candidate_from_metadata(v, source, t, true)
}
fn candidate_from_metadata(v:&Value,source:&str,t:&Track,complete:bool)->Option<Candidate> {
    let title=v["title"].as_str()?;let artist=v["artist"].as_str().or(v["uploader"].as_str()).or(v["channel"].as_str()).unwrap_or("");
    let reported_duration = v["duration"].as_f64();
    let duration = reported_duration.unwrap_or(t.duration_sec as f64);
    if (complete && reported_duration.is_none()) || !duration.is_finite() || (duration-t.duration_sec as f64).abs()>4.0{return None;}
    let lowered=title.to_lowercase();let expected=t.title.to_lowercase();
    if !version_matches(title,&expected,&t.artist){return None;}
    let original=normalized(&crate::lyrics::clean_title(&t.title));let name=normalized(title);
    if original.is_empty()||!name.contains(&original){return None;}
    let requested_artist=normalized(&t.artist);if requested_artist.is_empty() || (complete && !normalized(&format!("{title} {artist}")).contains(&requested_artist)){return None;}
    let page=v["webpage_url"].as_str().or(v["url"].as_str())?;
    let valid_page=reqwest::Url::parse(page).ok().is_some_and(|url|url.scheme()=="https"&&url.host_str().is_some_and(|h|h=="www.youtube.com"||h=="youtube.com"||h=="soundcloud.com"||h=="api.soundcloud.com"));
    if !valid_page{return None;}
    let date=v["upload_date"].as_str().map(str::to_owned);
    let mut score=50-(duration-t.duration_sec as f64).abs().round() as i32*3;
    if !complete && normalized(&format!("{title} {artist}")).contains(&requested_artist) { score += 40; }
    if date.as_ref().is_some_and(|d|d.len()==8&&d.chars().all(|c|c.is_ascii_digit())&&d.as_str()<"20260301"){score+=50;}
    if ["uncensored","без цензуры","explicit","original"].iter().any(|w|lowered.contains(w)){score+=30;}
    if lowered.contains("official audio"){score+=15;}if lowered.contains("official video"){score-=10;}
    Some(Candidate{source:source.into(),page_url:page.into(),title:title.into(),artist:artist.into(),duration,upload_date:date,score,url:String::new(),content_type:"audio/mpeg".into(),byte_len:0,segmented:false,segments:Vec::new(),segment_durations:Vec::new()})
}
pub fn allowed_media_url(value:&str)->bool {
    reqwest::Url::parse(value).ok().is_some_and(|u|u.scheme()=="https"&&u.username().is_empty()&&u.password().is_none()&&u.port_or_known_default()==Some(443)&&u.host_str().is_some_and(|host|["googlevideo.com","sndcdn.com","soundcloud.com","soundcloud.cloud","dzcdn.net"].iter().any(|suffix|host==*suffix||host.ends_with(&format!(".{suffix}")))))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test] async fn soundcloud_priority_and_backup_deadline() {
        let primary=async{tokio::time::sleep(Duration::from_millis(20)).await;Some("soundcloud")};
        assert_eq!(prefer_primary(primary,async{Some("youtube")},Duration::from_secs(1)).await,Some("soundcloud"),"a faster YouTube result must not win over the primary");
        assert_eq!(prefer_primary(async{None},async{Some("youtube")},Duration::from_secs(1)).await,Some("youtube"));
        let result=tokio::time::timeout(Duration::from_secs(1),prefer_primary(std::future::pending::<Option<&str>>(),async{Some("youtube")},Duration::from_millis(20))).await.unwrap();
        assert_eq!(result,Some("youtube"),"a hung primary must not block a ready backup");
        let slow=async{tokio::time::sleep(Duration::from_millis(40)).await;Some("soundcloud")};
        assert_eq!(prefer_primary(slow,async{None},Duration::from_millis(10)).await,Some("soundcloud"),"keep the only working source alive after the preference grace period");
    }
    #[test] fn hls_requires_full_unencrypted_fmp4_and_safe_hosts(){
        let playlist="#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:10,\n1.m4s\n#EXTINF:10,\n2.m4s\n#EXT-X-ENDLIST\n";
        let base="https://playback.media-streaming.soundcloud.cloud/test/index.m3u8";
        assert_eq!(hls_segments(playlist,base,20.0).unwrap().0.len(),3);
        assert!(hls_segments(playlist,base,120.0).is_none(),"preview must not be accepted as full audio");
        for bad in [playlist.replace("init.mp4","https://127.0.0.1/init"),playlist.replace("#EXT-X-ENDLIST","#EXT-X-KEY:METHOD=AES-128"),playlist.replace("#EXT-X-MAP:URI=\"init.mp4\"","")] {assert!(hls_segments(&bad,base,20.0).is_none());}
        assert!(!version_matches("madk1d, greyrock - распять (29.08.2025 москва @ vk музыка летом)","распять","GreyRock"));
        assert!(version_matches("распять","распять","GreyRock"));
        assert!(version_matches("Song (Live)","Song (Live)","Artist"));
    }
    #[tokio::test] async fn prepared_head_and_persisted_resolution_start_without_network_or_extractor(){
        let dir=tempfile::tempdir().unwrap();let db=crate::connect_database(&format!("sqlite://{}",dir.path().join("test.db").to_string_lossy().replace('\\',"/"))).await.unwrap();
        sqlx::query("INSERT INTO tracks (id,deezer_id,title,artist,artist_id,album,album_id,duration_sec) VALUES ('deezer_42',42,'Song','Artist',1,'Album',1,200)").execute(&db).await.unwrap();
        let t=sqlx::query_as::<_,Track>("SELECT * FROM tracks WHERE id='deezer_42'").fetch_one(&db).await.unwrap();
        let service=AudioService::configured(db.clone(),dir.path().join("audio"),4096,PathBuf::from("must-not-run"));tokio::fs::create_dir_all(&service.root).await.unwrap();
        let mut c=candidate(&serde_json::json!({"title":"Artist - Song","uploader":"Artist","duration":200,"url":"https://www.youtube.com/watch?v=fixture"}),"youtube",&t).unwrap();c.url="https://fixture.googlevideo.com/audio".into();c.byte_len=2048;
        let mut value=serde_json::to_value(&c).unwrap();value["url"]=Value::String(c.url.clone());
        sqlx::query("INSERT INTO audio_resolutions(track_id,candidate_json,source_url,expires_at) VALUES (?,?,?,?)").bind(&t.id).bind(value.to_string()).bind(&c.page_url).bind((now_seconds()+60) as i64).execute(&db).await.unwrap();
        tokio::fs::write(service.root.join("deezer_42.head"),vec![17u8;1024]).await.unwrap();
        sqlx::query("INSERT INTO audio_heads(track_id,stream_url,byte_len,head_size) VALUES (?,?,2048,1024)").bind(&t.id).bind(&c.url).execute(&db).await.unwrap();
        let request=Request::builder().header(header::RANGE,"bytes=0-1023").body(Body::empty()).unwrap();
        let response=tokio::time::timeout(Duration::from_secs(1),service.stream(&t,request)).await.unwrap().unwrap();assert_eq!(response.status(),StatusCode::PARTIAL_CONTENT);
        assert_eq!(axum::body::to_bytes(response.into_body(),2048).await.unwrap().as_ref(),vec![17u8;1024]);
        service.remember(&t.id,None).await;
        assert!(service.resolve(&t).await.unwrap().is_some(),"a failed background attempt must not erase a prepared source");
        service.invalidate(&t.id).await.unwrap();
        let expiry:i64=sqlx::query_scalar("SELECT expires_at FROM audio_resolutions WHERE track_id=?").bind(&t.id).fetch_one(&db).await.unwrap();
        assert_eq!(expiry,0,"refresh expires the persisted signed URL too");
        assert!(service.resolve(&t).await.unwrap().is_none(),"refresh must not return a stale prepared URL when renewal fails");
        drop(service);db.close().await;
    }
    #[test] fn byte_range_and_upstream_url_validation(){
        for range in ["bytes=0-","bytes=10-99","bytes=-200"]{assert!(valid_range(range));}
        for range in ["bytes=-","bytes=5-1","bytes=1-2,4-5","bytes=abc-","bytes=0-18446744073709551616"]{assert!(!valid_range(range));}
        assert!(allowed_media_url("https://rr1.googlevideo.com/videoplayback?x=1"));
        for url in ["http://rr1.googlevideo.com/a","https://127.0.0.1/a","https://googlevideo.com.evil.test/a","https://user:pass@sndcdn.com/a","https://sndcdn.com:8080/a"]{assert!(!allowed_media_url(url));}
        assert_eq!(parse_content_range("bytes 0-999/1000"),Some((0,999,1000)));
        assert_eq!(requested_range(Some("bytes=-20"),100),Some((80,99)));assert_eq!(requested_range(Some("bytes=50-200"),100),Some((50,99)));assert_eq!(requested_range(Some("bytes=100-"),100),None);
    }
    #[test] fn resolution_rejects_wrong_versions_and_dates_are_only_a_score(){
        let t:Track=serde_json::from_value(serde_json::json!({"id":"deezer_42","deezer_id":42,"title":"Test Song","artist":"Test Artist","artist_id":1,"album":"Album","album_id":1,"cover_url":"","duration_sec":200,"is_explicit":true,"preview_url":""})).unwrap();
        let mut v=serde_json::json!({"title":"Test Artist - Test Song (Official Audio)","duration":200,"url":"https://www.youtube.com/watch?v=fixture","uploader":"Test Artist","upload_date":"20250101"});
        let original=candidate(&v,"youtube",&t).unwrap();assert!(original.score>50);
        v["title"]=serde_json::json!("Test Artist - Test Song uncensored");assert!(candidate(&v,"youtube",&t).is_some());
        v["duration"]=serde_json::json!(30);assert!(candidate(&v,"youtube",&t).is_none());
        v["duration"]=serde_json::json!(200);v["title"]=serde_json::json!("Test Artist - Test Song clean");assert!(candidate(&v,"youtube",&t).is_none());
        v["title"]=serde_json::json!("Test Artist - Different song");assert!(candidate(&v,"youtube",&t).is_none());
    }
    #[tokio::test] async fn cached_range_is_exact_and_lru_keeps_active_streams(){
        let dir=tempfile::tempdir().unwrap();
        let db=crate::connect_database(&format!("sqlite://{}",dir.path().join("test.db").to_string_lossy().replace('\\',"/"))).await.unwrap();
        sqlx::query("INSERT INTO tracks (id,deezer_id,title,artist,artist_id,album,album_id,duration_sec) VALUES ('deezer_42',42,'Song','Artist',1,'Album',1,200)").execute(&db).await.unwrap();
        let root=dir.path().join("audio");tokio::fs::create_dir_all(&root).await.unwrap();
        let file=root.join("deezer_42.audio");tokio::fs::write(&file,(0u8..128).collect::<Vec<_>>()).await.unwrap();
        sqlx::query("INSERT INTO audio_cache (track_id,source_type,source_url,local_file_path,file_size_bytes,content_type,duration_sec) VALUES ('deezer_42','youtube','fixture',?,128,'audio/webm',200)").bind(file.to_string_lossy().to_string()).execute(&db).await.unwrap();
        let service=AudioService::configured(db.clone(),root,64,PathBuf::from("missing-fixture-binary"));
        let t=sqlx::query_as::<_,Track>("SELECT * FROM tracks WHERE id='deezer_42'").fetch_one(&db).await.unwrap();
        let request=Request::builder().header(header::RANGE,"bytes=10-19").body(Body::empty()).unwrap();
        let response=service.stream(&t,request).await.unwrap();
        assert_eq!(response.status(),StatusCode::PARTIAL_CONTENT);assert_eq!(response.headers()[header::CONTENT_RANGE],"bytes 10-19/128");
        assert_eq!(response.headers()[header::CONTENT_TYPE],"audio/webm");
        service.evict().await.unwrap();assert!(file.exists(),"active cached readers must be protected");
        let body=axum::body::to_bytes(response.into_body(),1000).await.unwrap();assert_eq!(body.as_ref(),&(10u8..20).collect::<Vec<_>>());
        service.evict().await.unwrap();assert!(!file.exists());
        let count:i64=sqlx::query_scalar("SELECT count(*) FROM audio_cache").fetch_one(&db).await.unwrap();assert_eq!(count,0);
        drop(service);db.close().await;
    }
    #[tokio::test]
    async fn cached_audio_waits_at_the_initial_buffer_until_playback_releases_it() {
        let dir = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}", dir.path().join("test.db").to_string_lossy().replace('\\', "/"));
        let db = crate::connect_database(&url).await.unwrap();
        sqlx::query("INSERT INTO tracks (id,deezer_id,title,artist,artist_id,album,album_id,duration_sec) VALUES ('deezer_42',42,'Song','Artist',1,'Album',1,180)").execute(&db).await.unwrap();
        let track = sqlx::query_as::<_, Track>("SELECT * FROM tracks WHERE id='deezer_42'").fetch_one(&db).await.unwrap();
        let service = AudioService::configured(db.clone(), dir.path().join("audio"), 2 * 1024 * 1024, "not-used".into());
        tokio::fs::create_dir_all(&service.root).await.unwrap();
        let size = 1024 * 1024;
        let path = service.path(&track.id);
        tokio::fs::write(&path, vec![7; size]).await.unwrap();
        sqlx::query("INSERT INTO audio_cache (track_id,source_type,source_url,local_file_path,file_size_bytes,content_type,duration_sec) VALUES ('deezer_42','youtube','fixture',?,?,'audio/webm',180)")
            .bind(path.to_string_lossy().as_ref()).bind(size as i64).execute(&db).await.unwrap();
        let token = "12345678-1234-1234-1234-123456789abc";
        let request = Request::builder().uri(format!("/?buffer={token}")).header(header::RANGE, "bytes=0-").body(Body::empty()).unwrap();
        let response = service.stream(&track, request).await.unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        let mut body = response.into_body().into_data_stream();
        let limit = initial_byte_limit(size as u64, track.duration_sec as f64);
        let mut received = 0;
        while received < limit {
            received += body.next().await.unwrap().unwrap().len() as u64;
        }
        assert!(received < size as u64);
        assert!(tokio::time::timeout(Duration::from_millis(50), body.next()).await.is_err());
        service.continue_stream(&track.id, token).unwrap();
        while let Some(chunk) = body.next().await { received += chunk.unwrap().len() as u64; }
        assert_eq!(received, size as u64);
    }
    #[tokio::test] async fn cache_commits_before_last_bytes_even_if_reader_never_polls_eof(){
        let dir=tempfile::tempdir().unwrap();
        let db=crate::connect_database(&format!("sqlite://{}",dir.path().join("test.db").to_string_lossy().replace('\\',"/"))).await.unwrap();
        sqlx::query("INSERT INTO tracks (id,deezer_id,title,artist,artist_id,album,album_id,duration_sec) VALUES ('deezer_42',42,'Song','Artist',1,'Album',1,200)").execute(&db).await.unwrap();
        let track=sqlx::query_as::<_,Track>("SELECT * FROM tracks WHERE id='deezer_42'").fetch_one(&db).await.unwrap();
        let upstream=axum::Router::new().route("/audio",axum::routing::get(||async{vec![42u8;1024]}));
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let url=format!("http://{}/audio",listener.local_addr().unwrap());
        let server=tokio::spawn(async move{axum::serve(listener,upstream).await.unwrap();});
        let response=reqwest::get(url).await.unwrap();
        let service=AudioService::configured(db.clone(),dir.path().join("audio"),2048,PathBuf::from("not-used"));
        tokio::fs::create_dir_all(&service.root).await.unwrap();
        let partial=service.root.join("deezer_42.part");let file=tokio::fs::File::create(&partial).await.unwrap();
        let mut selected=candidate(&serde_json::json!({"title":"Artist - Song","uploader":"Artist","duration":200,"url":"https://www.youtube.com/watch?v=fixture"}),"youtube",&track).unwrap();selected.byte_len=1024;
        let state=StreamState{file:Some(file),upstream:Some(response),head:None,service:service.clone(),track,candidate:selected,count:0,length:Some(1024),position:0,end:1023,segment_end:1023,retries:0,buffer_gate:None,_part:Some(PartialGuard{path:partial}),_writer:None,_active:service.active_guard("deezer_42")};
        let mut body=Box::pin(stream_body(state).into_data_stream());let mut received=0;
        while received<1024 {received+=body.next().await.unwrap().unwrap().len();}
        // An HTTP reader can stop at Content-Length without asking for EOF.
        let count:i64=sqlx::query_scalar("SELECT count(*) FROM audio_cache WHERE track_id='deezer_42' AND file_size_bytes=1024").fetch_one(&db).await.unwrap();
        assert_eq!(count,1);drop(body);
        assert_eq!(tokio::fs::read(service.path("deezer_42")).await.unwrap(),vec![42u8;1024]);
        server.abort();drop(service);db.close().await;
    }
}
