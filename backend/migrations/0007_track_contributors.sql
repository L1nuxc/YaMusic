-- Empty means that the catalog's compact response did not include credits.
-- Keep the provider's artist IDs and spelling; never infer credits from names.
ALTER TABLE tracks ADD COLUMN contributors_json TEXT NOT NULL DEFAULT '[]';
