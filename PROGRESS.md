# PROGRESS — Lyrics & Vocab Companion

> Read this first at the start of every session. Full spec lives in `CLAUDE.md`.

## Milestones

| # | Milestone | Status |
|---|-----------|--------|
| M1 | Detection (extension skeleton + now-playing logging) | ✅ Done — verified by Robi 2026-07-14 |
| M2 | Lyrics engine (LRCLIB + LRC parsing) | ✅ Done — verified by Robi 2026-07-14, 3 songs synced |
| M3 | Synced lyrics panel | ✅ Done — verified by Robi 2026-07-14 |
| M4 | Word capture + vocabulary list | ✅ Done — verified by Robi 2026-07-14 |
| M5 | Companion app + Supabase sync | 🔨 Built — awaiting verification (save on desktop → review on phone) |
| M6 | Display customization | ⬜ |
| M7 | (stretch) Phone auto-detection, publishing questions | ⬜ |

## Project structure

```
lyrics-companion/     (git repo, main branch — public on GitHub for Pages)
├── index.html        ← redirects to companion/
├── README.md
├── companion/        ← M5: phone app (flashcards + search), reuses ../extension modules
│   ├── index.html / styles.css / app.js
├── CLAUDE.md      ← master prompt / spec (decisions, milestones)
├── PROGRESS.md    ← this file
└── extension/            ← Chrome extension (load this folder unpacked)
    ├── manifest.json
    ├── config.js         ← Supabase URL + publishable key — GITIGNORED, never commit
    ├── config.example.js ← committed template for config.js
    ├── lyricsProvider.js ← M2: LRCLIB fetch + LRC parsing + title cleaning (swappable)
    ├── meaningProvider.js← M4: EN definitions (dictionaryapi.dev) + EN→ES translation (Lingva→MyMemory fallback, swappable)
    ├── syncProvider.js   ← M5: Supabase REST via plain fetch, no SDK (swappable, shared with companion)
    ├── vocabStore.js     ← M4/M5: local-first store (chrome.storage) mirrored to Supabase
    ├── panel.js          ← M3: lyrics panel UI + M4: tappable word spans
    ├── wordPopup.js      ← M4: tap-a-word popup (translation, definition, Save)
    ├── panel.css         ← panel + popup styling (lc- prefix, dark, YT-Music-ish)
    ├── vocab.html/.js    ← M4: saved-words list (toolbar popup) + M5: sync-on-open
    └── content.js        ← orchestrator: detection (M1) → fetch (M2) → panel (M3) → capture (M4)
```

## M5 infrastructure (2026-07-14)

- Supabase project **lyrics-companion** (`eivsguqixqzmasgwazwo`, us-east-1, free tier). One table: `public.vocab` (text id generated client-side; snake_case columns; `interval_step` 0..3 + `next_review` for spaced repetition).
- **Robi's choices:** vanilla JS companion (no deps/build), simple no-login sync (RLS off, publishable key treated as a secret), GitHub Pages hosting.
- No Supabase SDK — `syncProvider.js` calls the REST API with fetch (`apikey` header only). Verified end-to-end from Node: upsert/fetchAll/updateReview/removeRemote all pass against the live table.
- Sync model: extension is local-first (chrome.storage), pushes on save, full push+pull merge when the vocab popup opens. Phone app reads/writes Supabase directly (no local store). No tombstones: a failed remote delete can resurrect an entry on the next pull — acceptable for now.
- Companion gets Supabase credentials pasted once (stored in localStorage) because the repo is public — keys never ship in the repo.
- Spaced repetition: success → 1, 3, 7, 14 days; miss → reset + due again in 10 minutes.

## Key decisions

- Project lives at `C:\Users\Angel\Projects\lyrics-companion` (rename/move freely — nothing depends on the path).
- M1 reads title/artist from the player-bar DOM (`.title.ytmusic-player-bar`, `.byline.ytmusic-player-bar`) with a selector-list pattern so broken selectors are a one-line fix. The `navigator.mediaSession` main-world fallback from the spec is deferred until DOM selectors actually fail. Verified working on the live site (2026-07-14).
- Lyrics are fetched directly from the content script — LRCLIB sends `access-control-allow-origin: *` (verified 2026-07-14), so no background service worker needed yet.
- Video versions have messy titles ("Artist - Song [Official Lyric Visualizer]") — `cleanTitle()` strips junk brackets and artist prefixes, then `/api/get` → `/api/search` fallback chain handles the rest. Verified end-to-end from Node against real LRCLIB: messy video title → correct synced match (36 lines); nonsense input → clean null, no crash.
- Selector-list + fetch-id guard patterns: stale fetch responses are discarded when the user skips songs mid-fetch.
- M3 panel is a `position: fixed` overlay (right side, between top bar and player bar) rather than surgery on YT's own DOM — resilient to YT layout changes. Highlight uses `transform: scale()` (no reflow → no jitter); centering via manual `scrollTo` (not `scrollIntoView`, which can scroll the page). Auto-scroll pauses 4s when the user scrolls the panel manually. Panel header shows the *matched* track name — first thing to check when lyrics look wrong.
- Language pair (2026-07-14): learning **English**, native **Spanish**. Definitions = Free Dictionary API (per spec). Translation = **Lingva** (Robi's choice) with an instance list — dialectapp.org was the only healthy mirror on 2026-07-14 (lingva.ml & friends had broken upstreams) — and **MyMemory as automatic last resort**. All lookups have 4s timeouts; definition and translation fail independently.
- Word capture details: words tokenized with apostrophe-friendly regex ("don't", "gettin'" = one word); slang "…in'" retries the dictionary with "…ing"; Google's echo-back of unknown words is discarded when the dictionary also found nothing (protects real cognates). Vocabulary list lives in the toolbar-icon popup (`action.default_popup`), newest first, with delete buttons (small extra beyond spec — needed to clean up mis-taps while testing).
- Smarter LRCLIB matching (2026-11-26): `lyricsProvider.js` builds title/artist variants (strips Remaster/Live/Radio Edit/From "…"/feat. tags, tries the main artist alone, turns "X - Topic" and "XVEVO" channels into real names, splits "Artist - Song" re-uploads) and tries up to 4 `/api/get` pairs before searching. Search results must now resemble our title AND artist (accent-insensitive) or LRCLIB counts as a miss (so the YT Music fallback gets a turn) instead of returning a wrong song. All of this lives in `fromLrclib()`. Offline checks: `node tests/lyricsProvider.test.js`. Live-tested from the browser against real LRCLIB: "TQG — KAROL G & Nicki Minaj", "Bailando (Spanish Version) — EnriqueIglesiasVEVO", "Queen - Don't Stop Me Now (Official Video)" by a re-upload channel now resolve (all missed before); "Yesterday (Live At The BBC)" now gets the right-length version.

## Lyrics fallback: YouTube Music's Lyrics tab (2026-11-26)

- When LRCLIB has no synced lyrics (miss, error, or plain-only), `lyricsProvider.js` asks YT Music itself for the lyrics of the exact playing video: `POST /youtubei/v1/next {videoId}` → Lyrics-tab `browseId` (starts with `MPLY`) → `POST /youtubei/v1/browse` → `musicDescriptionShelfRenderer` text. Same-origin from the content script, no key, no new permissions. Verified on the live site.
- Order: LRCLIB synced → YT Music plain → LRCLIB plain → "No lyrics found". YT plain beats LRCLIB plain because it's tied to the exact video (no fuzzy match).
- From the browser these lyrics are **unsynced** (the timed variant only comes back to the Android app). Shown with `showPlain()`, so words stay tappable; no highlight/auto-scroll.
- Video id comes from the player's hidden `.ytp-title-link` (persists while browsing away from /watch), then `?v=`. Read lazily, only when the fallback runs, to avoid a stale id right after a skip.
- Panel now shows a "Lyrics via …" credit line (LRCLIB or "YouTube Music (Musixmatch)").
- Companion app is unaffected (it passes no `getVideoId`, and YT's API isn't reachable from github.io anyway).
- Undocumented API: if the fallback stops finding anything, check the `MPLY` browseId and `musicDescriptionShelfRenderer` names first. Licensing note for M7: these are licensed lyrics, fine for personal use only.

## Lyrics retrieval hardening (2026-11-26, branch `claude/project-thread-qpwcbz`)

- **Timeout + retry:** every LRCLIB call gives up after 7s and retries once after 1s on timeout, network error, 429 or 5xx (404 = normal "not found", never retried). Worst case on a dead LRCLIB ≈ 15s per call before the YT Music fallback runs.
- **Cache** wraps the whole source chain (LRCLIB + YT Music fallback), so YT Music results are cached too. `lyricsCache` in `chrome.storage.local` (localStorage in the companion), keyed by lowercase title|artist (no duration — it can be stale right after a skip). Hits kept until 300 songs, oldest dropped. Misses cached 24h. Network errors never cached.
- **Missed-songs log:** `lyricsMisses` (max 200): raw title/artist/album/duration, the cleaned search title, reason (`not_found` = no source had it / `error` = LRCLIB unreachable and YT had nothing), try count. Visible in the toolbar popup under "Songs without lyrics" with Copy/Clear. A song that later resolves removes itself.
- **Media session:** `mediaSessionBridge.js` runs in the page's MAIN world (needs Chrome 111+) and copies `navigator.mediaSession.metadata` onto `<html data-lc-media-session>`. content.js uses it for title/artist/album only when its title matches the player bar (avoids stale metadata after a skip). `/api/get` is tried with `album_name` first, then without.
- Not verified live yet: the cloud environment can't reach lrclib.net. Logic tested offline with a mocked fetch/storage.

## Known issues / notes

- Artist parsing is naive: byline "Artist • Album • Year" split on the first "•". Multi-artist strings ("A & B") come through as-is; `lyricsProvider.js` retries with the main artist.
- LRCLIB rate-limits bursts (HTTP 429 after ~15 quick calls). A miss now costs up to 6 calls instead of 3 — fine for one song at a time. A 429 now drops through to the YT Music fallback; only if that also has nothing does the panel show "Lyrics fetch failed".
- LRC parser handles one timestamp per line only (rare multi-timestamp LRC lines are skipped per-tag) — fine for LRCLIB content.
- On song change the previous song's `duration` can be read for a moment; the search fallback absorbs the occasional bad exact-match. Watch for wrong-lyrics reports.
- Highlight can lag up to ~0.5s (tick interval) — acceptable so far.
- Lingva public mirrors are unreliable as a class (4/5 tested were down on day one). If translations stop, check `LINGVA_INSTANCES` order first; MyMemory catches total failure. DeepL (needs key + service worker) is the quality upgrade path.
- Anonymous MyMemory has a daily character quota — only matters if Lingva is fully down for a heavy day.

## Next up

1. Robi pushes the repo to GitHub (public, named `lyrics-companion`), enables Pages (main / root), opens `https://<user>.github.io/lyrics-companion/` on his phone and pastes the Supabase values from `extension/config.js`.
2. M5 "done when": a word saved on desktop appears in the phone flashcards.
3. Then M6: settings panel (font, theme, highlight style, translation-under-line toggle, blur-upcoming self-test), all persisted.
