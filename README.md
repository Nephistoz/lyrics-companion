# 🎵 Lyrics & Vocab Companion

Turn music listening into language learning. A personal tool built around YouTube Music:

- **Chrome extension** — shows time-synced lyrics next to the player (karaoke-style highlight). Tap any word for its Spanish translation + English definition and save it with the exact song and lyric line it came from.
- **Phone companion app** — review saved words as flashcards with spaced repetition (1-3-7-14 days), or search any song and tap words from your phone. Synced through Supabase.

Lyrics from [LRCLIB](https://lrclib.net), definitions from [Free Dictionary API](https://dictionaryapi.dev), translations via [Lingva](https://github.com/thedaviddelta/lingva-translate) with MyMemory fallback. Vanilla JS, no build step.

## Setup

1. Copy `extension/config.example.js` to `extension/config.js` and fill in your Supabase project's URL and publishable key. Create a `vocab` table (see `PROGRESS.md` for the schema).
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select the `extension/` folder.
3. Play something on [music.youtube.com](https://music.youtube.com) 🎧
4. Phone: open the companion app (GitHub Pages serving this repo, `/companion/`), paste the same Supabase values once.

Personal-use project; lyrics providers are swappable behind `lyricsProvider.js` if licensing ever matters.
