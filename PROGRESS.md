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
| M6.9 | Track-change desync: the clock-start invariant + tests | ✅ No longer starts mid-song |
| M6.10 | Clock validated against the player bar (stalled-element bug) | 🔨 Built — awaiting verification |
| M8 | UX redesign v2: design system, signature highlighter marks, live-preview settings | 🔨 Built 2026-10-23 — awaiting Robi's verification |
| M7 | (stretch) Phone auto-detection, publishing questions | ⬜ |

## Project structure

```
lyrics-companion/     (git repo, main branch — public on GitHub for Pages)
├── index.html        ← redirects to companion/
├── README.md
├── companion/        ← M5: phone app (flashcards + search), reuses ../extension modules
│   ├── index.html / styles.css / app.js
├── tests/            ← plain-node regression tests (no deps): lyrics matching + track changes
├── dev/              ← design harnesses: panel-preview.html + vocab-preview.html (real UI code, stub data)
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
    ├── panel.css         ← all injected UI styling (lc- prefix): panel, settings, word card, pill
    ├── offsetStore.js    ← per-song timing nudges
    ├── settingsStore.js  ← display settings
    ├── fonts/            ← Bricolage Grotesque + Literata Italic (OFL, bundled latin woff2)
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

## Merge: local UX v2 + lyrics retrieval PRs (2026-11-26)

- Local work (sync-drift fixes, one-click alignment, UX redesign v2) merged with the three lyrics PRs. Safety copy of the pre-merge local main: branch `backup/local-main-before-merge`.
- `pickBest()` now does both jobs: search results must resemble our title AND artist (PR rule), then synced beats plain and the CLOSEST duration wins within each (local drift fix).
- `durationMismatch` is worked out per play in `getLyrics()`, not stored in the cache: the same song can come back as a longer music video. A cached synced match more than 15s off the playing length is skipped and re-resolved, so the right-length version still gets picked.
- Panel keeps the v2 header (YouTube's title + cover); the lyrics source shows as a "Lyrics via …" line under the lyrics and in the title tooltip. "Songs without lyrics" moved into the v2 vocab popup, styled with its tokens.
- `content.js`: media session metadata (title/artist/album) is applied inside `detect()` once the track change is proven; `onSongChange(title, artist, duration, expectStart, { album, source })`.

## M6 design system (2026-07-14) — superseded by v2 below

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

## M6.9 the clock-start invariant (2026-07-14) — read this before touching sync

Robi's screenshot: player at **0:02 of a 7:56 track**, highlight deep mid-song, sync bar "In sync" (so the lyrics matched the track fine). Words right, position wrong — the render loop was following a clock that still belonged to the song that had just ended.

Three earlier attempts failed because each tried to *predict* when YouTube swaps its internals (title timing in M6.6, duration equality in M6.7, version padding in M6.8). Durations and titles update on their own schedules, so at a transition the duration could already match the new track while `currentTime` still trailed the old one — every heuristic waved it through.

**The fix is an invariant, not a heuristic: never follow a clock we have not seen start.** When a track changes, the lyrics hold (visible, unhighlighted) until the clock proves itself — reading under 5s, or jumping backwards. Landing mid-song right after a change is then structurally impossible, whatever YouTube does internally. Page-load lyrics skip the wait (that clock is mid-song by definition, `expectStart=false`), and a 30s escape covers someone seeking deep into a track before its opening ever played.

Covered by `tests/track-change.test.js`, which runs the real `content.js` in a sandbox against a scripted clock — including the exact 460s-clock-with-fresh-lyrics case. **Run both tests before changing sync code.**

## M6.10 trust the clock the user can see (2026-07-14)

Next report: song playing at 0:28, lyrics loaded, **nothing highlighted at all**. The mid-song jump was gone, but the highlight never started. Cause: everything downstream trusted `<video>.currentTime` without ever checking it was the element actually playing. M6.8's `pickVideo()` took the first selector match, which on some pages is a stalled element sitting at 0:00 — so `currentLineIndex(0)` returned -1 forever while the song played on. (The M6.9 hold could also stretch to its 30s escape in the same situation.)

**The player bar's "0:28 / 4:47" readout is now the reference.** `detect()` re-reads it every 500ms and:
- picks the `<video>` whose clock agrees with it (±2s) — provably the track playing;
- sets `clockTrusted`, and if no element agrees, the lyrics follow **the player bar itself** (whole seconds — coarse, but never wrong) instead of stopping;
- logs each time trust flips, and reports `trusted=` on every song change;
- uses the bar's total as the track length when the element is untrustworthy.

Hold release also accepts "the player bar shows the track at its start" as proof, and the escape hatch dropped 30s → 12s. `tests/track-change.test.js` now covers a stalled element alongside a live one, and the no-element-agrees fallback (7 cases, all green).

## Design system v2 (2026-10-23) — read before touching any UI

Robi asked for a redesign that "prioritizes the user, modern interfaces and aesthetics". The v1 problems it fixes: every non-current line was the same grey (no sense of where you are), the header showed the LRCLIB match (diagnostic) instead of the song, the settings drawer covered the lyrics it was changing (no live preview), the same word could be saved twice, emoji icons (⚙ ✕ 🎵 ★), tracked-out ALL-CAPS section labels, and dead-end error strings.

**Rules**
- The lyrics are the hero; chrome stays quiet.
- **Accent = "yours"**: saved-word marks, primary actions, the Glow line (the user's own choice). Not decoration.
- **Literata italic = Spanish, always** (line translations, word-card translation, vocab list, companion). Never italicize English — part-of-speech labels and the companion's lyric line were moved off italics to keep the rule honest.
- Sentence case, plain verbs, no ALL CAPS, no middle-dot meta strings. Save → "Saved" (same verb through the flow).

**Tokens** (`THEMES` in panel.js, mirrored in vocab.js and companion/styles.css)
- Dark: Night `#1A1722` (panel bg at user opacity), Raised `#231F2D` (popovers), Chip `#3A3447` (segmented on-state), Ink `#F5F2FA`, Haze `#A39DB2`, Rule 9% / 17% ink.
- Light: Paper `#F8F6FB`, Raised `#FFFFFF`, Ink `#1D1926`, Haze `#6B6478`, Rule 8% / 16%.
- Accent variants computed in `applySettings`: `--lc-accent-soft` (Glow halo, 35%), `--lc-mark` (highlighter: 36% dark / 45% light), `--lc-mark-faint` (marks on the active line), `--lc-on-accent` (ink or white, whichever has more WCAG contrast — works for any custom color).
- Type: Bricolage Grotesque (variable; lyrics at 560, UI 550–700) + Literata Italic (Spanish). Family names prefixed `LC …` so a locally installed copy can't interfere. Sizes S/M/L/XL = 16/19/22/26px; spacing Tight/Cozy/Airy = 10/18/28px. Radii by role: panel 18, popovers 14–16, controls 9–10, cover 8, pills 999.

**Signature: saved words wear a highlighter stroke in every song.** `Panel.setSavedWords(set)` marks spans by `MeaningProvider.normalize` (now exported — the one word key). content.js feeds it from `VocabStore.onChange` (new: chrome.storage.onChanged on "vocab"), so a save in the card, a delete in the list, and a phone sync all flow through one path. Marks added while lyrics are on screen sweep in (`lc-sweep`, 0.6s — the one orchestrated motion); the session's first list applies quietly.

**Layout & states**
- Header: cover art (player-bar thumbnail upsized to 120px via `readArt()`), cleaned title, artist; LRCLIB match only as the title's tooltip.
- Line tiers in pure CSS (`.lc-playing` + `:not(.active ~ .lc-line)`): sung 0.32, current 1, next 0.8, upcoming 0.55. Opacity only → no reflow. Edges of the lyric area fade via mask-image.
- Settings and the word card open **beside** the panel (`Panel.placeBeside`: left, else right, else over), so changes preview live. Settings close on Escape / outside click; clicks on the lyrics keep them open.
- States: skeleton while loading; `showNotice({title, detail, retry})` for no lyrics / instrumental / errors — errors distinguish LRCLIB 5xx ("having trouble, try again in a moment") from network failures, and offer **Try again** (`Panel.onRetry` → refetch with `expectStart=false`). Plain lyrics carry a note that they won't follow the song.
- Timing footer: "Timing ‹ 0.0s ›" stepper; offset value resets on click; drift notice + accent "Shift lyrics +31s" button appear only while unresolved.
- Word card: dictionary-entry layout; shows "In your words, saved from …" instead of a second Save.
- "Your words" (toolbar popup): grouped by song, lyric line with the word marked, scrolls inside `<main>` (page scrolling pushed out a horizontal scrollbar).
- Quality floor: focus-visible rings, aria-labels on icon buttons, role=switch toggles, `prefers-reduced-motion` honoured.

**Verifying UI without loading the extension:** serve the repo root (`python -m http.server 8766`) and open `/dev/panel-preview.html` (buttons drive every state) or `/dev/vocab-preview.html` (`?theme=light`). They run the real panel.css/panel.js/wordPopup.js and vocab.html with stub data; only the `chrome-extension://` font URLs fail there, by design. Gotcha: the browser pane throttles animations when backgrounded — freeze transitions before trusting a screenshot.

## UI refresh PR 1 — speed (2026-11-26)

Plan agreed with Robi: three PRs in order, speed → responsive → customization (presets incl. album tint, Side/Mini/Stage modes, karaoke wipe, quick chips). Mockups: project files `ui-refresh/`.
- **Theme variables no longer live on `<body>`.** `Panel.applySettings` sets `--lc-*` on our own elements (panel, settings, pill, word card via `Panel.adoptTheme`). A custom property on `<body>` made Chrome re-style all of YouTube's page: `applySettings` went from 10.8ms to 1.1ms median on a 15k-element test page; the opacity slider paid that on every step.
- **Progress hairline** grows with `transform: scaleX(--lc-progress)` (0..1) instead of `width`, so its ~10 Hz updates skip layout and paint.
- **Backdrop blur only when the panel is see-through** (`.lc-glass`, opacity < 100%). First tried a 90% cutoff, but at the default 92% sharp page edges then showed through; Robi chose to keep the glass look. Set opacity to 100% to skip the blur's per-frame GPU cost.
- Spotlight dropped its 0.8px blur on non-current lines (color dimming does the job); `#lc-panel` has `contain: layout paint style`.

## Known issues / notes

- Artist parsing is naive: byline "Artist • Album • Year" split on the first "•". Multi-artist strings ("A & B") come through as-is; `lyricsProvider.js` retries with the main artist.
- LRCLIB rate-limits bursts (HTTP 429 after ~15 quick calls). A miss now costs up to 6 calls instead of 3 — fine for one song at a time. A 429 now drops through to the YT Music fallback; only if that also has nothing does the panel show "Lyrics fetch failed".
- LRC parser handles one timestamp per line only (rare multi-timestamp LRC lines are skipped per-tag) — fine for LRCLIB content.
- On song change the previous song's `duration` can be read for a moment; the search fallback absorbs the occasional bad exact-match. Watch for wrong-lyrics reports.
- Lingva public mirrors are unreliable as a class (4/5 tested were down on day one). If translations stop, check `LINGVA_INSTANCES` order first; MyMemory catches total failure. DeepL (needs key + service worker) is the quality upgrade path.
- Anonymous MyMemory has a daily character quota — only matters if Lingva is fully down for a heavy day.

## Backlog (Robi's "functionality we could improve" — to collect after M6)

- (pending — ask Robi to list what he noticed while testing M5 on the phone)

## Next up

1. Robi verifies M8 on the live site: reload the extension, check every state (song change, saving a word → mark sweeps in, settings beside the panel, "Your words" grouping, light theme).
2. `git push` to publish the restyled companion to GitHub Pages.
3. Candidates raised during M8 (not built): pronunciation audio in the word card (dictionaryapi.dev already returns audio URLs), a filter box in "Your words" once the list grows, `/api/get` 5xx falling through to `/api/search` instead of erroring.
4. Then M7 (stretch): phone auto-detection notes + the improvement backlog above.
