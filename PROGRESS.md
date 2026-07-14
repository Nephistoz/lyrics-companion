# PROGRESS — Lyrics & Vocab Companion

> Read this first at the start of every session. Full spec lives in `CLAUDE.md`.

## Milestones

| # | Milestone | Status |
|---|-----------|--------|
| M1 | Detection (extension skeleton + now-playing logging) | ✅ Done — verified by Robi 2026-07-14 |
| M2 | Lyrics engine (LRCLIB + LRC parsing) | ✅ Done — verified by Robi 2026-07-14, 3 songs synced |
| M3 | Synced lyrics panel | ✅ Done — verified by Robi 2026-07-14 |
| M4 | Word capture + vocabulary list | ✅ Done — verified by Robi 2026-07-14 |
| M5 | Companion app + Supabase sync | ✅ Done — verified by Robi 2026-07-14 (word saved on desktop appeared on phone) |
| M6 | Display customization + design overhaul | 🔨 Built — awaiting verification (every setting survives reload) |
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

## M6 design system (2026-07-14)

- **Tokens:** indigo-tinted charcoal dark theme (`#14141B` base — deliberately not YT's pure black) / warm-paper light theme; user accent (5 swatches, default amber `#FFB454`); Space Grotesk (OFL, 22KB latin woff2 bundled in `extension/fonts/`, loaded via `chrome-extension://__MSG_@@extension_id__/` in panel.css and web_accessible_resources). All colors flow through `--lc-*` CSS variables that `Panel.applySettings()` sets on `<body>`.
- **Settings** (`settingsStore.js`, chrome.storage.local, live-applied): theme, accent, font (grotesk/system/serif/mono stacks), size (S/M/L/XL), highlight (Glow/Spotlight/Classic), Spanish-under-each-line, blur-upcoming self-test. Gear ⚙ in the panel header opens the drawer.
- **Signature element:** accent hairline under the active lyric line that fills in real time as the line is sung (progress computed in content.js tick from current/next line timestamps → `--lc-progress`). Disabled in Classic mode and under `prefers-reduced-motion`.
- **Line translations:** `MeaningProvider.translateLines()` batches 12 lines per Lingva request joined with newlines (Google preserves breaks), falls back per-line on misalignment; cached per song in content.js. Verified live from Node.
- **Blur-upcoming** is pure CSS (`.active ~ .lc-line` sibling selector) — no JS bookkeeping.
- Vocab popup + companion app share the same tokens (popup follows theme/accent settings; companion is static dark with Google-Fonts-served Space Grotesk).

## Known issues / notes

- Artist parsing is naive: byline "Artist • Album • Year" split on the first "•". Multi-artist strings ("A & B") come through as-is — fine for lyrics search, revisit if LRCLIB matching suffers.
- LRC parser handles one timestamp per line only (rare multi-timestamp LRC lines are skipped per-tag) — fine for LRCLIB content.
- On song change the previous song's `duration` can be read for a moment; the search fallback absorbs the occasional bad exact-match. Watch for wrong-lyrics reports.
- Highlight can lag up to ~0.5s (tick interval) — acceptable so far.
- Lingva public mirrors are unreliable as a class (4/5 tested were down on day one). If translations stop, check `LINGVA_INSTANCES` order first; MyMemory catches total failure. DeepL (needs key + service worker) is the quality upgrade path.
- Anonymous MyMemory has a daily character quota — only matters if Lingva is fully down for a heavy day.

## Backlog (Robi's "functionality we could improve" — to collect after M6)

- (pending — ask Robi to list what he noticed while testing M5 on the phone)

## Next up

1. Robi verifies M6: change EVERY setting, reload the page, confirm each one survived. Try both themes, all three highlight styles, translations toggle, self-test blur.
2. `git push` to publish the redesigned companion to GitHub Pages.
3. Then M7 (stretch): phone auto-detection notes + the improvement backlog above.
