//! CPU-only CLAP audio embeddings. Inference never runs on an async executor.
use crate::{Track,audio::AudioService};
use std::{collections::{HashMap,HashSet,VecDeque},io::Cursor,path::PathBuf,sync::{Arc,Mutex,RwLock,atomic::{AtomicBool,Ordering}},time::Duration};
use sqlx::SqlitePool;
use rubato::Resampler;
use rustfft::{FftPlanner,num_complex::Complex};
use symphonia::core::{audio::SampleBuffer,codecs::DecoderOptions,formats::FormatOptions,io::MediaSourceStream,meta::MetadataOptions,probe::Hint};

pub type Vector=Vec<f32>;
pub struct Analyzer {
    db:SqlitePool,
    pub vectors:RwLock<HashMap<String,Vector>>,
    queue:Mutex<VecDeque<String>>, queued:Mutex<HashSet<String>>,
    started:AtomicBool, pub running:AtomicBool, pub available:AtomicBool,
    failed:Mutex<HashMap<String,(std::time::Instant,u8)>>,
}
impl Analyzer {
    pub fn new(db:SqlitePool)->Arc<Self>{Arc::new(Self{db,vectors:RwLock::new(HashMap::new()),queue:Mutex::new(VecDeque::new()),queued:Mutex::new(HashSet::new()),started:AtomicBool::new(false),running:AtomicBool::new(false),available:AtomicBool::new(false),failed:Mutex::new(HashMap::new())})}
    pub fn enqueue(&self,ids:impl IntoIterator<Item=String>,urgent:bool){
        if !self.started.load(Ordering::Relaxed){return;}
        let mut added=0;
        for id in ids.into_iter().take(64){
            if self.vectors.read().unwrap().contains_key(&id)||self.failed.lock().unwrap().get(&id).is_some_and(|(at,attempt)|at.elapsed()<Duration::from_secs(300*2u64.pow((*attempt).min(4) as u32))){continue;}
            let mut queued=self.queued.lock().unwrap();let mut queue=self.queue.lock().unwrap();
            if queued.contains(&id){if urgent{if let Some(position)=queue.iter().position(|v|v==&id){queue.remove(position);queue.push_front(id);}}continue;}
            if queue.len()>=64{continue;}queued.insert(id.clone());
            if urgent{queue.push_front(id);}else{queue.push_back(id);}
            added+=1;if added>=12{break;}
        }
    }
    pub fn pending(&self)->usize{self.queue.lock().unwrap().len()}
    pub async fn start(self:&Arc<Self>,audio:Arc<AudioService>)->Result<(),sqlx::Error>{
        if self.started.swap(true,Ordering::Relaxed){return Ok(());}
        let rows=sqlx::query_as::<_,(String,Vec<u8>)>("SELECT id,embedding FROM tracks WHERE embedding IS NOT NULL").fetch_all(&self.db).await?;
        for(id,blob)in rows{if let Some(v)=decode_vector(&blob){self.vectors.write().unwrap().insert(id,v);}}
        let ready=model_path().exists()&&runtime_path().exists();self.available.store(ready,Ordering::Relaxed);
        if !ready{tracing::warn!("Audio analysis disabled: run npm run setup:analysis");return Ok(());}
        let ids=sqlx::query_scalar::<_,String>("SELECT id FROM tracks WHERE embedding IS NULL AND preview_url<>'' ORDER BY updated_at DESC LIMIT 12").fetch_all(&self.db).await?;self.enqueue(ids,false);
        let service=self.clone();
        tokio::spawn(async move{
            let client=reqwest::Client::builder().timeout(Duration::from_secs(15)).connect_timeout(Duration::from_secs(4)).build().unwrap();
            let backfill_limit=std::env::var("ANALYSIS_BACKFILL_LIMIT").ok().and_then(|s|s.parse::<usize>().ok()).unwrap_or(200).min(10000);
            let mut engine=None;
            let mut idle=std::time::Instant::now();
            loop{
                // A click owns network/CPU priority; a running single-thread inference
                // finishes, but no further analysis is started until resolution ends.
                if audio.has_foreground_work(){tokio::time::sleep(Duration::from_millis(500)).await;continue;}
                let id=service.queue.lock().unwrap().pop_front();
                let Some(id)=id else{
                    if service.vectors.read().unwrap().len()<backfill_limit{
                        if let Ok(ids)=sqlx::query_scalar::<_,String>("SELECT id FROM tracks WHERE embedding IS NULL AND preview_url<>'' ORDER BY updated_at DESC LIMIT 64").fetch_all(&service.db).await{service.enqueue(ids,false);}
                    }
                    if idle.elapsed()>Duration::from_secs(30){engine=None;}
                    tokio::time::sleep(Duration::from_secs(1)).await;continue;
                };
                let track=sqlx::query_as::<_,Track>("SELECT * FROM tracks WHERE id=?").bind(&id).fetch_optional(&service.db).await.ok().flatten();
                if let Some(track)=track{
                    service.running.store(true,Ordering::Relaxed);
                    let bytes=fetch_preview(&client,&track).await;
                    let result=if let Ok(bytes)=bytes{
                        let previous=engine.take();
                        match tokio::task::spawn_blocking(move||{
                            let mut engine=match previous{Some(v)=>v,None=>Engine::new().map_err(|e|format!("CLAP initialization: {e}"))?};
                            let result=engine.embed(&bytes);Ok::<_,String>((engine,result))
                        }).await{
                            Ok(Ok((value,result)))=>{engine=Some(value);result},
                            Ok(Err(e))=>Err(e),Err(e)=>Err(e.to_string()),
                        }
                    }else{Err("preview unavailable".into())};
                    match result{
                        Ok(vector)=>{
                            if sqlx::query("UPDATE tracks SET embedding=? WHERE id=?").bind(encode_vector(&vector)).bind(&id).execute(&service.db).await.is_ok(){service.vectors.write().unwrap().insert(id.clone(),vector);}
                        },
                        Err(error)=>{tracing::warn!(track_id=%id,%error,"Audio analysis deferred");let mut failed=service.failed.lock().unwrap();failed.retain(|_,(at,_)|at.elapsed()<Duration::from_secs(86400));if failed.len()<512{let attempt=failed.get(&id).map(|(_,n)|n+1).unwrap_or(0);failed.insert(id.clone(),(std::time::Instant::now(),attempt.min(4)));}}
                    }
                    service.running.store(false,Ordering::Relaxed);idle=std::time::Instant::now();
                }
                service.queued.lock().unwrap().remove(&id);
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        });Ok(())
    }
}
fn model_path()->PathBuf{std::env::var_os("CLAP_MODEL_PATH").map(PathBuf::from).unwrap_or_else(||"models/clap-audio-int8.onnx".into())}
fn runtime_path()->PathBuf{std::env::var_os("ORT_DYLIB_PATH").map(PathBuf::from).unwrap_or_else(||if cfg!(windows){".tools/onnxruntime/onnxruntime-win-x64-1.22.0/lib/onnxruntime.dll".into()}else{".tools/onnxruntime/onnxruntime-linux-x64-1.22.0/lib/libonnxruntime.so".into()})}
async fn fetch_preview(client:&reqwest::Client,t:&Track)->Result<Vec<u8>,String>{
    let mut url=t.preview_url.clone();
    for attempt in 0..2{
        let parsed=reqwest::Url::parse(&url).map_err(|_|"invalid preview")?;
        if !crate::audio::allowed_media_url(parsed.as_str())||!parsed.host_str().is_some_and(|h|h=="dzcdn.net"||h.ends_with(".dzcdn.net")){return Err("invalid preview host".into());}
        let response=client.get(parsed).send().await;
        if let Ok(mut response)=response{if response.status().is_success(){
            let mut bytes=Vec::new();while let Some(chunk)=response.chunk().await.map_err(|_|"preview read")?{if bytes.len()+chunk.len()>2*1024*1024{return Err("preview too large".into());}bytes.extend_from_slice(&chunk);}return Ok(bytes);
        }}
        if attempt==0{
            let data:serde_json::Value=client.get(format!("https://api.deezer.com/track/{}",t.deezer_id)).send().await.map_err(|_|"preview refresh")?.json().await.map_err(|_|"preview metadata")?;
            url=data["preview"].as_str().unwrap_or("").into();
        }
    }Err("preview unavailable".into())
}
pub fn normalize(v:&mut[f32])->bool{let norm=v.iter().map(|x|x*x).sum::<f32>().sqrt();if !norm.is_finite()||norm<1e-8{return false;}for x in v{*x/=norm;}true}
pub fn cosine(a:&[f32],b:&[f32])->f32{a.iter().zip(b).map(|(x,y)|x*y).sum()}
pub fn encode_vector(v:&[f32])->Vec<u8>{v.iter().flat_map(|v|v.to_le_bytes()).collect()}
pub fn decode_vector(bytes:&[u8])->Option<Vector>{if bytes.len()!=2048{return None;}let mut v:Vec<_>=bytes.chunks_exact(4).map(|b|f32::from_le_bytes(b.try_into().unwrap())).collect();if normalize(&mut v){Some(v)}else{None}}

struct Engine{session:ort::session::Session,mel:Vec<Vec<(usize,f32)>>,fft:Arc<dyn rustfft::Fft<f32>>,window:Vec<f32>}
impl Engine{
    fn new()->Result<Self,String>{
        ort::init_from(runtime_path().to_string_lossy().as_ref()).commit().map_err(|e|e.to_string())?;
        let session=ort::session::Session::builder().map_err(|e|e.to_string())?.with_intra_threads(1).map_err(|e|e.to_string())?.with_inter_threads(1).map_err(|e|e.to_string())?.with_memory_pattern(false).map_err(|e|e.to_string())?.commit_from_file(model_path()).map_err(|e|e.to_string())?;
        let fft=FftPlanner::new().plan_fft_forward(1024);
        let window=(0..1024).map(|i|0.5-0.5*(std::f32::consts::TAU*i as f32/1024.).cos()).collect();
        let mel=mel_filters().into_iter().map(|filter|filter.into_iter().enumerate().filter(|(_,w)|*w>0.).collect()).collect();
        Ok(Self{session,mel,fft,window})
    }
    fn embed(&mut self,bytes:&[u8])->Result<Vector,String>{
        let (samples,rate)=decode_mp3(bytes).map_err(|e|format!("MP3 decoding: {e}"))?;let samples=resample(&samples,rate).map_err(|e|format!("resampling: {e}"))?;
        if samples.len()<4800{return Err("audio too short".into());}
        let mut sum=vec![0f32;512];let windows=samples.len().div_ceil(480000).min(3);
        for part in 0..windows{
            let start=(part*480000).min(samples.len().saturating_sub(480000));
            let data=repeat_pad(&samples[start..samples.len().min(start+480000)]);
            let features=self.features(&data);
            let input=ort::value::Tensor::from_array(([1usize,1,1001,64],features)).map_err(|e|e.to_string())?;
            let output=self.session.run(ort::inputs!["input_features"=>input]).map_err(|e|e.to_string())?;
            let(_,values)=output["audio_embeds"].try_extract_tensor::<f32>().map_err(|e|e.to_string())?;
            if values.len()!=512||values.iter().any(|v|!v.is_finite()){return Err("invalid CLAP output".into());}
            for(i,v)in values.iter().enumerate(){sum[i]+=v;}
        }
        if !normalize(&mut sum){return Err("empty CLAP output".into());}Ok(sum)
    }
    fn features(&self,data:&[f32])->Vec<f32>{
        let mut output=vec![0.;1001*64];let mut buffer=vec![Complex::new(0.,0.);1024];
        let mut scratch=vec![Complex::new(0.,0.);self.fft.get_inplace_scratch_len()];
        for frame in 0..1001{
            for(i,value)in buffer.iter_mut().enumerate(){let mut p=frame as isize*480+i as isize-512;if p<0{p=-p;}if p>=data.len() as isize{p=2*data.len() as isize-2-p;}*value=Complex::new(data[p as usize]*self.window[i],0.);}
            self.fft.process_with_scratch(&mut buffer,&mut scratch);
            for(m,filter)in self.mel.iter().enumerate(){let power=filter.iter().map(|(i,w)|buffer[*i].norm_sqr()*w).sum::<f32>();output[frame*64+m]=10.*power.max(1e-10).log10();}
        }output
    }
}
/// Explicit diagnostic entry point; the HTTP server only uses its queued worker.
pub fn analyze_mp3(bytes:&[u8])->Result<Vector,String>{Engine::new()?.embed(bytes)}
fn decode_mp3(bytes:&[u8])->Result<(Vec<f32>,usize),String>{
    // Deezer previews may begin with a valid empty ID3v2 tag. Symphonia's
    // metadata reader treats that zero-length tag as an unexpected EOF.
    // Remove only the bounded metadata tag; MPEG/Xing frames remain untouched.
    let bytes=strip_id3(bytes)?;
    let source=MediaSourceStream::new(Box::new(Cursor::new(bytes.to_vec())),Default::default());let mut hint=Hint::new();hint.with_extension("mp3");
    let mut format=symphonia::default::get_probe().format(&hint,source,&FormatOptions::default(),&MetadataOptions::default()).map_err(|e|e.to_string())?.format;
    let track=format.default_track().ok_or("no audio track")?;let id=track.id;let rate=track.codec_params.sample_rate.ok_or("missing sample rate")? as usize;
    if !(8000..=192000).contains(&rate){return Err("unsupported sample rate".into());}
    let mut decoder=symphonia::default::get_codecs().make(&track.codec_params,&DecoderOptions::default()).map_err(|e|e.to_string())?;
    let mut mono=Vec::new();
    while let Ok(packet)=format.next_packet(){if packet.track_id()!=id{continue;}let Ok(decoded)=decoder.decode(&packet)else{continue;};let channels=decoded.spec().channels.count();if channels==0||channels>8{return Err("invalid channels".into());}
        let mut buffer=SampleBuffer::<f32>::new(decoded.capacity() as u64,*decoded.spec());buffer.copy_interleaved_ref(decoded);
        mono.extend(buffer.samples().chunks_exact(channels).map(|f|f.iter().sum::<f32>()/channels as f32));if mono.len()>=rate*30{break;}
    }mono.truncate(rate*30);if mono.iter().any(|x|!x.is_finite()){return Err("invalid audio".into());}Ok((mono,rate))
}
fn strip_id3(bytes:&[u8])->Result<&[u8],String>{
    if !bytes.starts_with(b"ID3"){return Ok(bytes);}
    if bytes.len()<10||!(2..=4).contains(&bytes[3])||bytes[6..10].iter().any(|v|v&0x80!=0){return Err("invalid ID3 header".into());}
    let size=bytes[6..10].iter().fold(0usize,|n,v|(n<<7)|*v as usize);
    let end=10+size+if bytes[3]==4&&bytes[5]&0x10!=0{10}else{0};
    bytes.get(end..).ok_or_else(||"truncated ID3 metadata".into())
}
fn resample(data:&[f32],rate:usize)->Result<Vec<f32>,String>{
    if rate==48000{return Ok(data.to_vec());}let mut r=rubato::FftFixedIn::<f32>::new(rate,48000,1024,2,1).map_err(|e|e.to_string())?;
    let mut output=Vec::new();for chunk in data.chunks(1024){let mut input=vec![0.;1024];input[..chunk.len()].copy_from_slice(chunk);let result=r.process(&[input],None).map_err(|e|e.to_string())?;output.extend_from_slice(&result[0]);}
    for _ in 0..3{output.extend_from_slice(&r.process(&[vec![0.;1024]],None).map_err(|e|e.to_string())?[0]);}
    let delay=r.output_delay();let length=data.len()*48000/rate;if output.len()<delay+length{return Err("resampler output too short".into());}Ok(output[delay..delay+length].to_vec())
}
fn repeat_pad(data:&[f32])->Vec<f32>{let mut out=vec![0.;480000];if data.is_empty(){return out;}for n in 0..(480000/data.len()).max(1){out[n*data.len()..(n+1)*data.len()].copy_from_slice(data);}out}
fn mel_filters()->Vec<Vec<f32>>{
    fn mel(f:f32)->f32{if f<1000.{f/(200./3.)}else{15.+(f/1000.).ln()/(6.4f32.ln()/27.)}}
    fn hz(m:f32)->f32{if m<15.{m*(200./3.)}else{1000.*((m-15.)*(6.4f32.ln()/27.)).exp()}}
    let edges:Vec<_>=(0..66).map(|i|hz(mel(50.)+(mel(14000.)-mel(50.))*i as f32/65.)).collect();
    (0..64).map(|m|(0..513).map(|b|{let f=b as f32*48000./1024.;((f-edges[m])/(edges[m+1]-edges[m])).min((edges[m+2]-f)/(edges[m+2]-edges[m+1])).max(0.)*2./(edges[m+2]-edges[m])}).collect()).collect()
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn vector_blob_roundtrip_rejects_invalid(){let mut v=vec![0.;512];v[0]=3.;v[1]=4.;normalize(&mut v);let blob=encode_vector(&v);assert_eq!(blob.len(),2048);let d=decode_vector(&blob).unwrap();assert!((cosine(&d,&v)-1.).abs()<1e-5);assert!(decode_vector(&vec![0;2048]).is_none());assert!(decode_vector(&vec![0;2047]).is_none());}
    #[test]fn empty_id3_preview_and_truncated_tags(){let mut bytes=b"ID3\x04\x00\x00\x00\x00\x00\x00".to_vec();bytes.extend_from_slice(&[0xff,0xfb,0x92]);assert_eq!(strip_id3(&bytes).unwrap(),&[0xff,0xfb,0x92]);assert!(strip_id3(b"ID3").is_err());assert!(strip_id3(b"ID3\x04\x00\x00\x00\x00\x01\x00").is_err());}
    #[test]fn resampling_preserves_duration_and_frequency(){let data:Vec<_>=(0..44100).map(|i|(std::f32::consts::TAU*440.*i as f32/44100.).sin()).collect();let out=resample(&data,44100).unwrap();assert_eq!(out.len(),48000);let crossings=out.windows(2).filter(|w|w[0]<0.&&w[1]>=0.).count();assert!((crossings as i32-440).abs()<=2);}
    #[test]fn mel_filter_and_repeat_padding_match_clap_contract(){let filters=mel_filters();assert_eq!((filters.len(),filters[0].len()),(64,513));assert!(filters.iter().flatten().all(|v|v.is_finite()&&*v>=0.));let padded=repeat_pad(&[1.,2.,3.]);assert_eq!(&padded[..6],&[1.,2.,3.,1.,2.,3.]);assert_eq!(padded.len(),480000);}
}
