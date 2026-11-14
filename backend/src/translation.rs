use crate::{ApiError,AppState,llm};
use axum::http::StatusCode;
use serde_json::{Value,json};

fn key(name:&str)->Option<String>{
    std::env::var(name).ok().map(|key|key.trim().to_owned()).filter(|key|!key.is_empty())
}
pub fn google_enabled()->bool{key("GOOGLE_TRANSLATE_API_KEY").is_some()}
pub fn deepl_enabled()->bool{key("DEEPL_API_KEY").is_some()}
fn disabled()->ApiError{
    llm::error(StatusCode::SERVICE_UNAVAILABLE,"translation_disabled","Этот переводчик пока не подключён.")
}
fn failed()->ApiError{
    llm::error(StatusCode::BAD_GATEWAY,"translation_unavailable","Переводчик не смог обработать текст. Проверьте язык или выберите другой сервис.")
}
fn normalized(text:&str)->String{
    text.replace("&quot;","\"").replace("&#39;","'").replace("&amp;","&")
        .replace(['[',']','<','>'],"").split_whitespace().collect::<Vec<_>>().join(" ")
}
fn parse_rows(rows:&Value,count:usize)->Result<Vec<String>,ApiError>{
    let rows=rows.as_array().filter(|rows|rows.len()==count).ok_or_else(failed)?;
    rows.iter().map(|row|row["text"].as_str().or_else(||row["translatedText"].as_str())
        .map(normalized).filter(|text|!text.is_empty()&&text.len()<=1024).ok_or_else(failed)).collect()
}
pub async fn google(state:&AppState,lines:&[&str],language:&str)->Result<Vec<String>,ApiError>{
    let api_key=key("GOOGLE_TRANSLATE_API_KEY").ok_or_else(disabled)?;
    let mut translated=Vec::new();
    for chunk in lines.chunks(40){
        let response:Value=state.client.post("https://translation.googleapis.com/language/translate/v2")
            .header("x-goog-api-key",&api_key).json(&json!({"q":chunk,"target":language,"format":"text"}))
            .send().await.map_err(|_|failed())?.error_for_status().map_err(|_|failed())?
            .json().await.map_err(|_|failed())?;
        translated.extend(parse_rows(&response["data"]["translations"],chunk.len())?);
    }
    Ok(translated)
}
pub async fn deepl(state:&AppState,lines:&[&str],language:&str)->Result<Vec<String>,ApiError>{
    let api_key=key("DEEPL_API_KEY").ok_or_else(disabled)?;
    let endpoint=if api_key.ends_with(":fx"){"https://api-free.deepl.com/v2/translate"}else{"https://api.deepl.com/v2/translate"};
    let target=match language{"en"=>"EN-US".into(),"pt"=>"PT-BR".into(),"zh"=>"ZH-HANS".into(),_=>language.to_uppercase()};
    let mut translated=Vec::new();
    for chunk in lines.chunks(50){
        let response:Value=state.client.post(endpoint)
            .header("Authorization",format!("DeepL-Auth-Key {api_key}"))
            .json(&json!({"text":chunk,"target_lang":target,"preserve_formatting":true}))
            .send().await.map_err(|_|failed())?.error_for_status().map_err(|_|failed())?
            .json().await.map_err(|_|failed())?;
        translated.extend(parse_rows(&response["translations"],chunk.len())?);
    }
    Ok(translated)
}
