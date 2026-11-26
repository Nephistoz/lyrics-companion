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

// The cleanest metadata YouTube Music has: what it hands the browser's media
// controls (navigator.mediaSession). mediaSessionBridge.js copies it onto
// <html> for us. Returns { title, artist, album } or null.
function readMediaSession() {
  const raw = document.documentElement.getAttribute("data-lc-media-session");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Combine both sources. The player bar decides WHEN the song changed (it's
// what we've always watched); the media session adds the album and is
// preferred for title/artist — but only if it already describes the same
// song. Right after a skip it can lag behind the player bar for a moment,
// and stale metadata would fetch the previous song's lyrics.
function songInfo(domTitle, domArtist) {
  const ms = readMediaSession();
  const same = ms && ms.title && ms.title.trim().toLowerCase() === domTitle.toLowerCase();
  if (!same) return { title: domTitle, artist: domArtist, album: null, source: "player bar" };
  return {
    title: ms.title.trim(),
    artist: ms.artist.trim() || domArtist,
    album: ms.album.trim() || null,
    source: "media session",
  };
}

// The playing video's id, for the YouTube Music lyrics fallback.
// The player's (hidden) title link keeps pointing at the current video even
// when you browse away from the watch page; the URL's ?v= is the backup.
function readVideoId() {
  const link = document.querySelector(".ytp-title-link");
  const fromLink = link && link.href ? new URL(link.href).searchParams.get("v") : null;
  return fromLink || new URLSearchParams(location.search).get("v");
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

// async/await: getLyrics talks to the network, which takes time. "await"
// pauses THIS function (nothing else) until the answer arrives.
async function onSongChange({ title, artist, album, source }, duration) {
  lines = null;
  lineIndex = -1;
  WordPopup.hide(); // a popup from the previous song makes no sense now
  const id = ++fetchId;
  const albumText = album ? ` [${album}]` : "";
  console.log(`${LOG} Song changed → ${title} — ${artist}${albumText} (${formatTime(duration)}, from ${source}) — fetching lyrics…`);
  Panel.showMessage("Searching lyrics…", title);
  try {
    const result = await LyricsProvider.getLyrics({ title, artist, album, duration, getVideoId: readVideoId });
    const cacheNote = result && result.fromCache ? ", from cache" : "";
    if (id !== fetchId) return; // user already skipped to another song
    if (!result) {
      console.log(`${LOG} No lyrics found — added to the missed-songs list (toolbar icon → "Songs without lyrics").`);
      Panel.showMessage("No lyrics found for this song 🙁", title);
    } else if (result.instrumental) {
      Panel.showMessage("Instrumental track — nothing to sing 🎹", title);
    } else if (result.synced) {
      lines = result.synced;
      console.log(`${LOG} Synced lyrics loaded from ${result.source}: ${lines.length} lines (matched "${result.matched}"${cacheNote}).`);
      Panel.showSynced(lines, result.matched, result.source);
    } else {
      console.log(`${LOG} Unsynced lyrics loaded from ${result.source} (matched "${result.matched}"${cacheNote}).`);
      Panel.showPlain(result.plain, result.matched, result.source);
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
    const info = songInfo(title, artist);
    lastTitle = info.title;
    lastArtist = info.artist;
    onSongChange(info, video.duration);
  }

  // Update the highlight even while paused — seeking works either way.
  if (lines) {
    const idx = currentLineIndex(video.currentTime);
    if (idx !== lineIndex) {
      lineIndex = idx;
      Panel.setActiveLine(idx);
    }
  }
}

// Wire the modules together: tap a word in the panel → popup with meaning
// and Save; while the popup is open the panel stops auto-scrolling.
Panel.onWordClick(({ word, line, rect }) => {
  WordPopup.show({ word, line, rect, songTitle: lastTitle, artist: lastArtist });
});
WordPopup.onOpenChange((open) => Panel.setScrollPaused(open));

console.log(`${LOG} content script loaded — play a song and watch this console.`);
setInterval(tick, 500);
