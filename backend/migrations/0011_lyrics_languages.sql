ALTER TABLE lyrics_translations RENAME TO lyrics_translations_ru;
CREATE TABLE lyrics_translations (
    track_id TEXT NOT NULL REFERENCES lyrics_cache(track_id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    target_language TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    translated_lrc TEXT NOT NULL,
    PRIMARY KEY (track_id, provider, target_language)
);
INSERT INTO lyrics_translations(track_id,provider,target_language,source_hash,translated_lrc)
    SELECT track_id,provider,'ru',source_hash,translated_lrc FROM lyrics_translations_ru;
DROP TABLE lyrics_translations_ru;
