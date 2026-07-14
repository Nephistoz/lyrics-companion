// content.js — M1: detect what's playing on YouTube Music.
//              M2: fetch lyrics for it.
//              M3: show them in a synced panel on the page.
//
// This is a "content script": Chrome injects it into every page matching the
// pattern in manifest.json. It can read the page's DOM, but it runs in its
// own sandbox ("isolated world"), so it can't see the page's JS variables.
// lyricsProvider.js and panel.js load before this file (manifest order), so
// the LyricsProvider and Panel globals are available here.

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
let lineIndex = -1; // index of the last line we logged
let settings = null; // current display settings (SettingsStore)
let translationsFor = null; // songKey the cached line translations belong to
let translationsCache = null;
let translating = false;

// async/await: getLyrics talks to the network, which takes time. "await"
// pauses THIS function (nothing else) until the answer arrives.
async function onSongChange(title, artist, duration) {
  lines = null;
  lineIndex = -1;
  WordPopup.hide(); // a popup from the previous song makes no sense now
  const id = ++fetchId;
  console.log(`${LOG} Song changed → ${title} — ${artist} (${formatTime(duration)}) — fetching lyrics…`);
  Panel.showMessage("Searching lyrics…", title);
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
      Panel.showSynced(lines, result.matched);
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

// The line currently being sung = the last one whose timestamp has passed.
// Recomputing from currentTime every tick means seeking around "just works".
function currentLineIndex(t) {
  let idx = -1;
  for (let i = 0; i < lines.length && lines[i].time <= t; i++) idx = i;
  return idx;
}

function tick() {
  // YT Music is a single-page app: one persistent <video> element plays
  // everything. Its currentTime/duration properties are live and cheap to read.
  const video = document.querySelector("video");
  const title = readTitle();
  const artist = readArtist();
  if (!video || !title) return;

  // Waiting for a finite duration avoids fetching with stale/unknown length.
  const songKey = `${title}|${artist}`;
  if (songKey !== lastSongKey && Number.isFinite(video.duration)) {
    lastSongKey = songKey;
    lastTitle = title;
    lastArtist = artist;
    onSongChange(title, artist, video.duration);
  }

  // Update the highlight even while paused — seeking works either way.
  if (lines) {
    const t = video.currentTime;
    const idx = currentLineIndex(t);
    if (idx !== lineIndex) {
      lineIndex = idx;
      Panel.setActiveLine(idx);
    }
    // How far into the current line we are → the filling hairline.
    if (idx >= 0 && lines[idx + 1]) {
      const frac = (t - lines[idx].time) / (lines[idx + 1].time - lines[idx].time);
      Panel.setActiveProgress(Math.min(1, Math.max(0, frac)));
    }
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
setInterval(tick, 500);
