use std::{net::SocketAddr, path::PathBuf};
use yamusic_server::{AppState, app, connect_database};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "yamusic_server=info,tower_http=info".into())).init();
    tokio::fs::create_dir_all("data").await?;
    let db_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite://data/yamusic.db".into());
    let db = connect_database(&db_url).await?;
    let state = AppState::new(db, "https://api.deezer.com".into())?;
    state.analysis.start(state.audio.clone()).await?;
    let address: SocketAddr = std::env::var("BIND_ADDRESS").unwrap_or_else(|_| "127.0.0.1:8000".into()).parse()?;
    let dist = PathBuf::from(std::env::var("CLIENT_DIST").unwrap_or_else(|_| "client/dist".into()));
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address, "YaMusic server ready");
    axum::serve(listener, app(state, dist)).with_graceful_shutdown(async { tokio::signal::ctrl_c().await.ok(); }).await?;
    Ok(())
}
