// content.js — M1: detect what's playing on YouTube Music.
//              M2: fetch lyrics for it.
//              M3: show them in a synced panel on the page.
//
// This is a "content script": Chrome injects it into every page matching the
// pattern in manifest.json. It can read the page's DOM, but it runs in its
// own sandbox ("isolated world"), so it can't see the page's JS variables.
// The other modules load before this file (manifest order), so their globals
// (LyricsProvider, Panel, SettingsStore, OffsetStore...) are available here.
//
// Two loops run side by side:
//   detect()  every 500ms — which song is playing, and fetching its lyrics
//   render()  every frame — which line is lit, and how far into it we are

const LOG = "🎵 [LyricsCompanion]";

// YouTube Music changes its markup over time, so each piece of data has a
// list of selectors to try — first match wins. When detection breaks,
// these lists are the first suspect: add the new selector to the front.
const SELECTORS = {
  title: [".title.ytmusic-player-bar"],
  byline: [".byline.ytmusic-player-bar"],
};

function queryFirst(selectorList) {
  for (const sel of selectorList) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim()) return el;
  }
  return null;
}

function readTitle() {
  const el = queryFirst(SELECTORS.title);
  return el ? el.textContent.trim() : null;
}

// The byline text looks like "Artist • Album • 2024" (sometimes fewer
// parts). The artist is everything before the first "•".
function readArtist() {
  const el = queryFirst(SELECTORS.byline);
  if (!el) return null;
  return el.textContent.split("•")[0].trim() || null;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "?:??";
  const m = Math.floor(seconds / 60);
  const s = String(Math.floor(seconds % 60)).padStart(2, "0");
  return `${m}:${s}`;
}

let lastSongKey = null;
let lastTitle = null; // current song, kept for saving words with context
let lastArtist = null;
let fetchId = 0; // increments per song; stale fetch responses get ignored
let lines = null; // current song's synced lyrics: [{time, text}]
let lineIndex = -1; // index of the line currently lit
let settings = null; // current display settings (SettingsStore)
let translationsFor = null; // songKey the cached line translations belong to
let translationsCache = null;
let translating = false;

let videoEl = null; // the page's playing <video>, cached for the render loop
let hookedVideo = null; // the element we attached metadata listeners to
let metadataStamp = 0; // when the <video> last reported a fresh duration
let pendingSince = 0; // when the current song's title first appeared
let fetchedDuration = 0; // the duration the current lyrics were matched against
let syncOffset = 0; // this song's manual timing nudge, in seconds
let driftHint = ""; // why the timing may be off (shown in the sync bar)
let fitSuggestion = 0; // seconds of padding the sync bar offers to correct
let lastProgressAt = 0;
let holdLogged = false; // keeps the "holding highlight" note to once per hold

// async/await: getLyrics talks to the network, which takes time. "await"
// pauses THIS function (nothing else) until the answer arrives.
async function onSongChange(title, artist, duration) {
  lines = null;
  lineIndex = -1;
  fetchedDuration = duration;
  driftHint = "";
  WordPopup.hide(); // a popup from the previous song makes no sense now
  const id = ++fetchId;
  console.log(`${LOG} Song changed → ${title} — ${artist} (${formatTime(duration)}) — fetching lyrics…`);
  Panel.showMessage("Searching lyrics…", title);

  // A song fixed by hand once stays fixed: load its saved nudge first.
  syncOffset = await OffsetStore.get(title, artist);
  if (id !== fetchId) return;

  try {
    const result = await LyricsProvider.getLyrics({ title, artist, duration });
    if (id !== fetchId) return; // user already skipped to another song
    if (!result) {
      Panel.showMessage("No lyrics found for this song 🙁", title);
    } else if (result.instrumental) {
      Panel.showMessage("Instrumental track — nothing to sing 🎹", title);
    } else if (result.synced) {
      lines = result.synced;
      console.log(`${LOG} Synced lyrics loaded: ${lines.length} lines (matched "${result.matched}").`);
      // LRCLIB carries several versions of many songs. When even the closest
      // one isn't the length of what's playing, timings will drift — say so
      // rather than leaving Robi to wonder why the lyrics wander off.
      fitSuggestion = 0;
      if (result.durationMismatch) {
        const diff = duration - result.matchedDuration;
        const gap = Math.round(Math.abs(diff));
        driftHint = diff > 0
          ? `This version runs ${gap}s longer than any lyrics on file — usually a music video or extended mix with an intro.`
          : `Closest lyrics run ${gap}s longer than this track, so timing may drift.`;
        // Longer track = padding, and padding is nearly always at the start,
        // so shifting the whole file by the difference usually lands it.
        // Offered as one click rather than applied: the extra could be an outro.
        if (diff > 0) fitSuggestion = Math.round(diff);
        console.log(`${LOG} ${driftHint}`);
      }
      Panel.showSynced(lines, result.matched);
      Panel.setSyncState(syncOffset, driftHint, fitSuggestion);
      maybeLoadTranslations();
    } else {
      Panel.showPlain(result.plain, result.matched);
    }
  } catch (err) {
    if (id === fetchId) {
      console.log(`${LOG} Lyrics fetch failed: ${err.message}`);
      Panel.showMessage(`Lyrics fetch failed: ${err.message}`, title);
    }
  }
}

// Metadata events tell us exactly when the <video> knows the CURRENT track's
// length — the signal that makes a song change safe to act on.
function hookVideo(video) {
  if (hookedVideo === video) return;
  hookedVideo = video;
  const stamp = () => (metadataStamp = Date.now());
  video.addEventListener("durationchange", stamp);
  video.addEventListener("loadedmetadata", stamp);
}

// YouTube sometimes keeps more than one <video> around (the video/song
// toggle, preloading). The element that is actually playing owns the clock
// our lyrics follow — taking the first one in the DOM can pick a stale player.
const VIDEO_SELECTORS = ["ytmusic-player video", "#movie_player video", "video.html5-main-video"];

function pickVideo() {
  // Prefer the element inside YT Music's own player: home-page previews and
  // the song/video toggle can leave other <video> tags on the page, and their
  // clocks have nothing to do with the track in the player bar.
  for (const sel of VIDEO_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  const all = document.querySelectorAll("video");
  if (all.length < 2) return all[0] || null;
  return [...all].find((v) => !v.paused && Number.isFinite(v.duration)) || all[0];
}

function detect() {
  // YT Music is a single-page app: the <video> element's currentTime and
  // duration are live and cheap to read.
  const video = pickVideo();
  const title = readTitle();
  const artist = readArtist();
  if (!video || !title) return;
  videoEl = video;
  hookVideo(video);

  const songKey = `${title}|${artist}`;
  if (songKey !== lastSongKey) {
    // The player-bar title and the <video> itself do NOT switch tracks at the
    // same instant. Fetching inside that gap sends the PREVIOUS song's length
    // to LRCLIB, which then matches a different version — lyrics that look
    // fine at first and drift later. So on a new title: drop the old lyrics
    // immediately (they belong to another timeline), then wait for proof that
    // the player has moved on too — a metadata event, or a clock back at the
    // start of a track — before fetching.
    if (!pendingSince) {
      pendingSince = Date.now();
      lines = null;
      lineIndex = -1;
      Panel.showMessage("Searching lyrics…", title);
    }
    const firstEver = lastSongKey === null; // page load: media is already correct
    const metadataFresh = metadataStamp >= pendingSince - 2000;
    const restarted = video.currentTime < 5; // the new track is at its beginning
    const gaveUp = Date.now() - pendingSince > 10000;
    if (Number.isFinite(video.duration) && (firstEver || metadataFresh || restarted || gaveUp)) {
      const via = firstEver ? "first" : metadataFresh ? "metadata" : restarted ? "restart" : "timeout";
      console.log(`${LOG} → "${title}" len=${Math.round(video.duration)}s at=${video.currentTime.toFixed(1)}s videos=${document.querySelectorAll("video").length} via=${via}`);
      lastSongKey = songKey;
      lastTitle = title;
      lastArtist = artist;
      pendingSince = 0;
      onSongChange(title, artist, video.duration);
    }
    return;
  }

  // Second line of defence: if YouTube revises the track length after we
  // fetched, our match was made against the wrong number — fetch again with
  // the real one. Self-limiting, since the refetch stores the new duration.
  if (
    lines && fetchedDuration && Number.isFinite(video.duration) &&
    Math.abs(video.duration - fetchedDuration) > 2
  ) {
    console.log(`${LOG} track length corrected ${Math.round(fetchedDuration)}s → ${Math.round(video.duration)}s, refetching lyrics`);
    onSongChange(lastTitle, lastArtist, video.duration);
  }
}

// The line currently being sung = the last one whose timestamp has passed.
// Recomputing from currentTime every frame means seeking around "just works".
function currentLineIndex(t) {
  let idx = -1;
  for (let i = 0; i < lines.length && lines[i].time <= t; i++) idx = i;
  return idx;
}

// Runs once per frame, so a line lights up the moment it is sung instead of
// up to half a second late. Cheap: it only touches the DOM when something
// actually changes (and the progress hairline ~10 times a second).
function render() {
  requestAnimationFrame(render);
  if (!lines || !videoEl) return;

  // The clock only means something when the media loaded RIGHT NOW is the one
  // these lyrics were fetched for. At a track change the previous song can
  // still be playing out its last seconds while the next song's lyrics arrive
  // — following that clock lights a line from the middle of the song and then
  // scrolls on from there. Hold the highlight until the timelines agree;
  // detect() refetches within 500ms if the track really did change.
  if (
    fetchedDuration && Number.isFinite(videoEl.duration) &&
    Math.abs(videoEl.duration - fetchedDuration) > 2
  ) {
    if (!holdLogged) {
      holdLogged = true;
      console.log(`${LOG} holding highlight: player is on a ${Math.round(videoEl.duration)}s track, lyrics are for a ${Math.round(fetchedDuration)}s one`);
    }
    return;
  }
  holdLogged = false;

  const t = videoEl.currentTime - syncOffset;
  const idx = currentLineIndex(t);
  if (idx !== lineIndex) {
    lineIndex = idx;
    Panel.setActiveLine(idx);
  }

  const now = performance.now();
  if (now - lastProgressAt > 100 && idx >= 0 && lines[idx + 1]) {
    lastProgressAt = now;
    const frac = (t - lines[idx].time) / (lines[idx + 1].time - lines[idx].time);
    Panel.setActiveProgress(Math.min(1, Math.max(0, frac)));
  }
}

// "Spanish under each line": translate the whole song once per song, cache
// it, and hand it to the panel. Only runs while the toggle is on.
async function maybeLoadTranslations() {
  if (!settings || !settings.showTranslations || !lines || translating) return;
  const key = lastSongKey;
  if (translationsFor === key && translationsCache) {
    Panel.setTranslations(translationsCache);
    return;
  }
  translating = true;
  try {
    const texts = await MeaningProvider.translateLines(lines.map((l) => l.text));
    if (key === lastSongKey && lines) {
      translationsFor = key;
      translationsCache = texts;
      Panel.setTranslations(texts);
    }
  } catch (err) {
    console.warn(`${LOG} line translations failed:`, err.message);
  } finally {
    translating = false;
  }
}

// Wire the modules together: tap a word in the panel → popup with meaning
// and Save; while the popup is open the panel stops auto-scrolling.
Panel.onWordClick(({ word, line, rect }) => {
  WordPopup.show({ word, line, rect, songTitle: lastTitle, artist: lastArtist });
});
WordPopup.onOpenChange((open) => Panel.setScrollPaused(open));

// Sync bar: shift this song's lyrics earlier or later, remembered per song so
// each awkward track only needs fixing once. null = back to zero.
Panel.onSyncNudge((change) => {
  if (change === null) syncOffset = 0; // reset
  else if (typeof change === "object") syncOffset = change.set; // one-click align
  else syncOffset = Math.round((syncOffset + change) * 100) / 100; // ± nudge
  Panel.setSyncState(syncOffset, driftHint, fitSuggestion);
  lineIndex = -1; // force the highlight to recompute on the next frame
  OffsetStore.set(lastTitle, lastArtist, syncOffset);
});

// Settings drive the panel's whole look. Load once at startup, then keep
// panel and storage in sync both ways.
SettingsStore.get().then((s) => {
  settings = s;
  Panel.applySettings(s);
});
SettingsStore.onChange((s) => {
  const translationsJustEnabled = !settings?.showTranslations && s.showTranslations;
  settings = s;
  Panel.applySettings(s);
  if (translationsJustEnabled) maybeLoadTranslations();
});
Panel.onSettingsChange((patch) => SettingsStore.set(patch));

console.log(`${LOG} content script loaded — play a song and watch this console.`);
setInterval(detect, 500);
requestAnimationFrame(render);
