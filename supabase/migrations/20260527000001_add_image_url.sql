-- Cover images for items, populated by source providers (Open Library, TMDB,
-- YouTube, OpenGraph). Nullable — falls back to the designed cover when null.
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS image_url text;
