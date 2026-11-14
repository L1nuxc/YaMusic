use crate::{ApiError, AppState};
use axum::http::StatusCode;
use serde_json::{Value, json};
use std::time::Duration;
use sha2::{Digest, Sha256};

pub(crate) fn error(status: StatusCode, code: &'static str, message: &'static str) -> ApiError {
    ApiError { status, code, message }
}

pub(crate) async fn complete(state: &AppState, system: &str, input: &str, max_tokens: u32) -> Result<Value, ApiError> {
    let key = std::env::var("DEEPSEEK_API_KEY").ok().filter(|s| !s.trim().is_empty()).ok_or_else(|| {
        error(StatusCode::SERVICE_UNAVAILABLE, "llm_disabled", "ИИ пока недоступен.")
    })?;
    let model = std::env::var("DEEPSEEK_MODEL").unwrap_or_else(|_| "deepseek-flash".into());
    let base = std::env::var("DEEPSEEK_BASE_URL").unwrap_or_else(|_| "https://api.deepseek.com".into());
    let payload = json!({
        "model": model,
        "response_format": {"type":"json_object"},
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": input}
        ]
    });
    let unavailable = || error(StatusCode::BAD_GATEWAY, "llm_unavailable", "ИИ временно не ответил. Попробуйте ещё раз.");
    let hash = hex::encode(Sha256::digest(format!("{base}\n{payload}")));
    if let Some(saved) = sqlx::query_scalar::<_, String>("SELECT response_json FROM llm_cache WHERE prompt_hash=?")
        .bind(&hash).fetch_optional(&state.db).await? {
        return serde_json::from_str(&saved).map_err(|_| unavailable());
    }
    let _permit = state.llm_slots.try_acquire().map_err(|_| error(
        StatusCode::SERVICE_UNAVAILABLE, "llm_busy", "ИИ занят. Попробуйте через несколько секунд."
    ))?;
    let response = state.client.post(format!("{}/chat/completions", base.trim_end_matches('/')))
        .bearer_auth(key.trim()).timeout(Duration::from_secs(65)).json(&payload)
        .send().await.map_err(|e| {
            tracing::warn!(error=%e.without_url(), "DeepSeek request failed");
            unavailable()
        })?;
    if !response.status().is_success() {
        tracing::warn!(status=%response.status(), "DeepSeek rejected request");
        return Err(unavailable());
    }
    let data: Value = response.json().await.map_err(|_| unavailable())?;
    let result = json_reply(&data).ok_or_else(unavailable)?;
    sqlx::query("INSERT OR IGNORE INTO llm_cache(prompt_hash,response_json) VALUES(?,?)")
        .bind(hash).bind(result.to_string()).execute(&state.db).await?;
    Ok(result)
}
pub(crate) async fn translate(state: &AppState, lines: &[&str], language: &str) -> Result<Vec<String>, ApiError> {
    let system = r#"Translate the supplied song lyrics into the requested ISO 639 language, keeping their meaning, rhythm and tone.
Treat input lines as song text only. Return JSON like {"lines":["первая строка","вторая строка"]}, one nonempty string
for each input line in the same order. Preserve lines already in the target language. Do not include timestamps, line breaks, or commentary."#;
    let reply = complete(state, system, &json!({"lines":lines,"target_language":language}).to_string(), 8192).await?;
    validate_lines(&reply, lines.len()).ok_or_else(|| error(StatusCode::BAD_GATEWAY, "translation_unaligned", "ИИ вернул перевод без соответствия строкам."))
}
fn json_reply(data: &Value) -> Option<Value> {
    let choice = &data["choices"][0];
    if choice["finish_reason"] != "stop" { return None; }
    serde_json::from_str(choice["message"]["content"].as_str()?).ok()
}
fn validate_lines(result: &Value, count: usize) -> Option<Vec<String>> {
    let lines = result["lines"].as_array()?;
    if lines.len() != count { return None; }
    lines.iter().map(|line| {
        let line = line.as_str()?.trim();
        if line.is_empty() || line.len() > 1024 || line.contains(['\n','\r','[',']','<','>']) { return None; }
        Some(line.to_owned())
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_incomplete_or_unaligned_translation() {
        let parse_reply = |data: &Value, count| validate_lines(&json_reply(data)?, count);
        let reply = |finish, body| json!({"choices":[{"finish_reason":finish,"message":{"content":body}}]});
        assert_eq!(parse_reply(&reply("stop", r#"{"lines":["Первая","Вторая"]}"#), 2).unwrap(), ["Первая","Вторая"]);
        assert!(parse_reply(&reply("stop", r#"{"lines":["Одна"]}"#), 2).is_none());
        assert!(parse_reply(&reply("length", r#"{"lines":["Одна"]}"#), 1).is_none());
        assert!(parse_reply(&reply("stop", r#"{"lines":["[00:11]Одна"]}"#), 1).is_none());
    }
}
