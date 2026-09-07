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
| M6 | Display customization + design overhaul | ✅ Done — verified by Robi 2026-07-14 ("works and looks amazing") |
| M6.5 | Product polish: movable/resizable panel, opacity, deeper personalization | ✅ Done — verified by Robi 2026-07-14 |
| M6.6 | Lyric sync drift: root-cause fixes + per-song manual nudge | ✅ Partly — helped, but transitions still broke (see M6.7) |
| M6.7 | Track-change desync: clock/media identity guards | 🔨 Built — awaiting verification |
| M6.8 | Padded versions (video/extended edits): one-click Align | 🔨 Built — awaiting verification |
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

## M6.5 additions (2026-07-14, Robi's "real final product" request)

- Panel is **draggable** (header = drag handle, pointer capture) and **resizable** (native CSS `resize: both`, persisted via ResizeObserver, debounced). Layout stored as `settings.panel {x,y,w,h}`; `null` = default anchored spot; "Reset" button in the Layout section. Clamped back into the viewport on restore; zero-size (hidden panel) never persisted.
- New settings: **opacity** slider 55–100% (live preview on drag, saved on release), **custom accent** via native color picker next to the swatches, **line spacing** (Compact/Cozy/Airy → `--lc-gap`), **text alignment** (left/center — hairline centers itself via `--lc-hairline-margin`).
- Settings drawer reorganized into sections: Look / Type / Karaoke / Layout.

## M6.6 sync-drift investigation (2026-07-14)

Robi reported intermittent lyric/song drift. Evidence gathered from live LRCLIB queries — three independent causes, all fixed:

1. **Multiple versions per song.** LRCLIB hosts uploads of the same track with very different lengths ("Believed — Lauv": 170s / 181s / 229s; "Where You Are": 221s / 236s / 282s; "Wings" is tight at 250–251s, which is why some songs never drifted). Old `pickBest` fell back to *any* synced hit when none was within 10s → a 282s file over a 236s track drifts progressively. Now picks the **closest duration**, always.
2. **Song-change race.** The player-bar title and the `<video>` duration update at different instants, so a fetch in that gap used the PREVIOUS song's length → 404 on `/api/get` → search fallback → wrong version. `detect()` now waits for a `durationchange`/`loadedmetadata` event belonging to the new song (2s cap), clears stale lyrics the moment the title changes, and refetches if YouTube later revises the length by >2s (defense in depth).
3. **Video versions have intros** the album-timed LRC knows nothing about — a constant per-song shift no algorithm can infer. Hence the manual nudge, persisted per song in `offsetStore.js`, so a song only ever needs fixing once.

Also: `[offset:±ms]` LRC tags are now honoured (rare on LRCLIB — 0 of 20 sampled — but valid LRC), a drift warning surfaces in the sync bar when even the closest match is >15s off, and the highlight moved from the 500ms tick to a `requestAnimationFrame` loop (frame-accurate lines; progress hairline throttled to ~10Hz). Regression tests: `scratchpad/test-sync.js` (offset tag, closest-duration pick, mismatch reporting) — all green.

## M6.7 track-change desync (2026-07-14)

M6.6's fixes helped but Robi hit the real one: **at a song transition the new song's lyrics load while the `<video>` is still playing out the previous track**, so `currentTime` (~4:50) lights a line from the middle of the incoming lyrics and scrolls on from there. M6.6 gated the *fetch* on media metadata; it never gated the *clock* the render loop reads.

Fixes:
- **Clock guard (the real fix).** `render()` refuses to highlight while `|video.duration − fetchedDuration| > 2s` — i.e. while the media currently loaded is not the one the lyrics were fetched for. Logs "holding highlight" once per hold. detect()'s existing refetch resolves the hold within 500ms.
- **Stronger fetch gate.** A song change now also waits for `currentTime < 5s` (a clock genuinely back at the start of a track); timeout raised 2s → 10s since the wait is now safe, and first-detection-on-page-load fetches immediately.
- **`pickVideo()`** returns the `<video>` that is actually playing rather than the first in the DOM (YouTube keeps several around for the song/video toggle and preloading).
- **Transition diagnostics:** each song change logs `len= at= videos= via=` (which condition released the fetch: first/metadata/restart/timeout) — paste these if the bug ever reappears.

## M6.8 padded versions (2026-07-14)

Console evidence from Robi: three drift warnings in a row, all in the same direction — the playing track ran **31s / 61s / 71s longer** than the closest lyrics on LRCLIB. Not a timing bug: YouTube Music was serving **video or extended versions** (intros, DJ edits — common in the electronic tracks he plays) for which no LRC of matching length exists anywhere. The album-cut lyrics are correct, they simply start later than the padded audio.

- **One-click Align.** When the track is longer than the best match, the sync bar's middle button becomes `Align +31s`; clicking shifts the whole file by the difference (padding is nearly always an intro). Offered rather than applied automatically, since the extra time could be an outro. Fine-tune afterwards with ± and it persists per song like any other nudge.
- Nudge protocol now carries three shapes: `delta` (± button), `null` (reset), `{set}` (align).
- Drift notices moved from `console.warn` to `console.log` — they were cluttering the error console, and they are information, not faults.
- `pickVideo()` now prefers the `<video>` inside YT Music's own player (`ytmusic-player`, `#movie_player`, `.html5-main-video`) before falling back to "whichever is playing" — home-page preview videos were a real risk of reading the wrong clock.

## Known issues / notes

- Artist parsing is naive: byline "Artist • Album • Year" split on the first "•". Multi-artist strings ("A & B") come through as-is — fine for lyrics search, revisit if LRCLIB matching suffers.
- LRC parser handles one timestamp per line only (rare multi-timestamp LRC lines are skipped per-tag) — fine for LRCLIB content.
- On song change the previous song's `duration` can be read for a moment; the search fallback absorbs the occasional bad exact-match. Watch for wrong-lyrics reports.
- Lingva public mirrors are unreliable as a class (4/5 tested were down on day one). If translations stop, check `LINGVA_INSTANCES` order first; MyMemory catches total failure. DeepL (needs key + service worker) is the quality upgrade path.
- Anonymous MyMemory has a daily character quota — only matters if Lingva is fully down for a heavy day.

## Backlog (Robi's "functionality we could improve" — to collect after M6)

- (pending — ask Robi to list what he noticed while testing M5 on the phone)

## Next up

1. Robi verifies M6: change EVERY setting, reload the page, confirm each one survived. Try both themes, all three highlight styles, translations toggle, self-test blur.
2. `git push` to publish the redesigned companion to GitHub Pages.
3. Then M7 (stretch): phone auto-detection notes + the improvement backlog above.
