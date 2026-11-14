fn main()->Result<(),Box<dyn std::error::Error>>{
    let path=std::env::args().nth(1).ok_or("Pass an MP3 preview path")?;
    let bytes=std::fs::read(path)?;let at=std::time::Instant::now();
    let vector=yamusic_server::analysis::analyze_mp3(&bytes)?;
    println!("dimensions={} norm={} elapsed_ms={}",vector.len(),vector.iter().map(|v|v*v).sum::<f32>().sqrt(),at.elapsed().as_millis());Ok(())
}
