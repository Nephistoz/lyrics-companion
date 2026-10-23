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
  art: ["img.image.ytmusic-player-bar", "ytmusic-player-bar .thumbnail img", "ytmusic-player-bar img"],
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

// Album art from the player bar, upsized from YouTube's 60px thumbnail.
function readArt() {
  for (const sel of SELECTORS.art) {
    const img = document.querySelector(sel);
    if (img && /^https?:/.test(img.src)) return img.src.replace(/=w\d+-h\d+/, "=w120-h120");
  }
  return null;
}

// What the panel header shows: the song as YouTube names it, minus the
// "[Official Video]" noise, with its artist and cover.
function trackInfo(title, artist) {
  return { title: LyricsProvider.cleanTitle(title, artist) || title, artist, art: readArt() };
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
let awaitingStart = false; // new song loaded: has its clock actually started?
let holdSince = 0;
let lastClock = 0; // previous frame's currentTime, so restarts are visible
let barTime = null; // last reading of the player bar's own clock
let clockTrusted = true; // does the <video> we read agree with that bar?

// async/await: getLyrics talks to the network, which takes time. "await"
// pauses THIS function (nothing else) until the answer arrives.
async function onSongChange(title, artist, duration, expectStart = true) {
  lines = null;
  lineIndex = -1;
  fetchedDuration = duration;
  driftHint = "";
  // A track that just changed must prove its clock before the lyrics follow
  // it (see render). Lyrics loaded for whatever is already playing at page
  // load get no such wait — that clock is mid-song by definition.
  awaitingStart = expectStart;
  holdSince = Date.now();
  WordPopup.hide(); // a popup from the previous song makes no sense now
  const id = ++fetchId;
  console.log(`${LOG} Song changed → ${title} — ${artist} (${formatTime(duration)}) — fetching lyrics…`);
  Panel.setTrack(trackInfo(title, artist));
  Panel.showLoading();

  // A song fixed by hand once stays fixed: load its saved nudge first.
  syncOffset = await OffsetStore.get(title, artist);
  if (id !== fetchId) return;

  try {
    const result = await LyricsProvider.getLyrics({ title, artist, duration });
    if (id !== fetchId) return; // user already skipped to another song
    Panel.setTrack(trackInfo(title, artist)); // the cover often lands after the title
    if (!result) {
      Panel.showNotice({
        title: "No lyrics for this song yet",
        detail: "LRCLIB, the free lyrics library this panel reads from, doesn't have it. If this is a music video, the song version is more likely to be listed.",
      });
    } else if (result.instrumental) {
      Panel.showNotice({ title: "Instrumental", detail: "This track has no lyrics to follow." });
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
          ? `This version is ${gap}s longer than the lyrics on file — usually a music video or extended mix with an intro.`
          : `These lyrics come from a version ${gap}s longer than this one, so timing may drift.`;
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
      // Say whose problem it is: a 5xx is LRCLIB having a bad moment (it
      // happens — retrying shortly usually works); anything else is the
      // request not getting through.
      const serverSide = /HTTP 5\d\d/.test(err.message);
      Panel.showNotice({
        title: "Lyrics didn't load",
        detail: serverSide
          ? "LRCLIB, the lyrics library, is having trouble right now. Try again in a moment."
          : "Couldn't reach LRCLIB, the lyrics library. Check your connection, then try again.",
        retry: true,
      });
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
// The player bar shows "0:28 / 4:47" — the clock Robi is actually looking at,
// and the only reading guaranteed to belong to the track he can hear. We use
// it to check that the <video> we picked is that same track, and as a coarse
// fallback clock if no element agrees.
SELECTORS.time = [".time-info.ytmusic-player-bar", "ytmusic-player-bar .time-info"];

function readPlayerBarTime() {
  const el = queryFirst(SELECTORS.time);
  const m = el && el.textContent.match(/(\d+):(\d+)\s*\/\s*(\d+):(\d+)/);
  if (!m) return null;
  return { current: +m[1] * 60 + +m[2], total: +m[3] * 60 + +m[4] };
}

// Pages can hold several <video> elements (home-page previews, the song/video
// toggle, preloading). Picking by selector alone once left us reading a
// stalled element: lyrics loaded, clock frozen, nothing ever highlighted. So
// pick the element whose clock agrees with the player bar — that one is
// provably the track playing.
function pickVideo(bar) {
  const all = [...document.querySelectorAll("video")];
  if (!all.length) return null;
  if (bar) {
    const agrees = all.find(
      (v) => Number.isFinite(v.duration) && Math.abs(v.currentTime - bar.current) <= 2
    );
    if (agrees) return agrees;
  }
  return all.find((v) => !v.paused && Number.isFinite(v.duration)) || all[0];
}

// What the lyrics follow: the video's clock while it matches the player bar,
// otherwise the bar itself (whole seconds — coarse, but never wrong).
function readClock() {
  if (clockTrusted && videoEl) return videoEl.currentTime;
  return barTime ? barTime.current : null;
}

function detect() {
  // YT Music is a single-page app: the <video> element's currentTime and
  // duration are live and cheap to read.
  barTime = readPlayerBarTime();
  const video = pickVideo(barTime);
  const title = readTitle();
  const artist = readArtist();
  if (!video || !title) return;
  videoEl = video;
  hookVideo(video);

  // Only follow this element's clock while it matches what the player bar
  // shows. A frozen or leftover element quietly reading 0:00 is exactly how
  // lyrics end up loaded but never highlighted.
  const wasTrusted = clockTrusted;
  clockTrusted = !barTime || Math.abs(video.currentTime - barTime.current) <= 2;
  if (wasTrusted !== clockTrusted) {
    console.log(`${LOG} clock ${clockTrusted ? "matches" : "disagrees with"} the player bar (video ${video.currentTime.toFixed(1)}s vs bar ${barTime ? barTime.current : "?"}s)${clockTrusted ? "" : " — following the player bar instead"}`);
  }
  const dur = clockTrusted ? video.duration : barTime.total;

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
      Panel.setTrack(trackInfo(title, artist));
      Panel.showLoading();
    }
    const firstEver = lastSongKey === null; // page load: media is already correct
    const metadataFresh = metadataStamp >= pendingSince - 2000;
    const clockNow = readClock() ?? video.currentTime;
    const restarted = clockNow < 5; // the new track is at its beginning
    const gaveUp = Date.now() - pendingSince > 10000;
    if (Number.isFinite(dur) && (firstEver || metadataFresh || restarted || gaveUp)) {
      const via = firstEver ? "first" : metadataFresh ? "metadata" : restarted ? "restart" : "timeout";
      console.log(`${LOG} → "${title}" len=${Math.round(dur)}s at=${clockNow.toFixed(1)}s videos=${document.querySelectorAll("video").length} trusted=${clockTrusted} via=${via}`);
      lastSongKey = songKey;
      lastTitle = title;
      lastArtist = artist;
      pendingSince = 0;
      onSongChange(title, artist, dur, !firstEver);
    }
    return;
  }

  // Second line of defence: if YouTube revises the track length after we
  // fetched, our match was made against the wrong number — fetch again with
  // the real one. Self-limiting, since the refetch stores the new duration.
  if (
    lines && fetchedDuration && Number.isFinite(dur) &&
    Math.abs(dur - fetchedDuration) > 2
  ) {
    console.log(`${LOG} track length corrected ${Math.round(fetchedDuration)}s → ${Math.round(dur)}s, refetching lyrics`);
    onSongChange(lastTitle, lastArtist, dur);
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

  const clock = readClock();
  if (clock === null) return; // no clock we trust yet

  // THE RULE: never follow a clock we haven't seen start.
  //
  // When a track changes, the incoming song's lyrics can be ready while the
  // player is still reporting the outgoing song's position — a clock reading
  // 4:12 against fresh lyrics lights a line from the middle of the song and
  // carries on from there. Predicting when YouTube swaps its internals turned
  // out to be unreliable (durations and titles update at their own pace), so
  // the lyrics simply wait for proof: a clock near the start of a track, or
  // one that jumped backwards. Until then the lyrics are readable, just not
  // highlighted. The 30s escape covers someone seeking deep into a song
  // before its opening ever played.
  if (awaitingStart) {
    // The player bar counts as proof too: if what Robi can see says the track
    // is at its beginning, it is — no need to keep the lyrics waiting.
    const barAtStart = barTime && barTime.current < 5;
    const restarted = clock < 5 || barAtStart || clock < lastClock - 1;
    const waitedTooLong = Date.now() - holdSince > 12000;
    lastClock = clock;
    if (!restarted && !waitedTooLong) {
      if (!holdLogged) {
        holdLogged = true;
        console.log(`${LOG} holding highlight: clock reads ${clock.toFixed(1)}s, waiting for this track to start`);
      }
      return;
    }
    awaitingStart = false;
    holdLogged = false;
    console.log(`${LOG} following the clock from ${clock.toFixed(1)}s (${restarted ? "track started" : "gave up waiting"})`);
  }
  lastClock = clock;

  // Second guard: the loaded media should also be the one these lyrics were
  // fetched for. detect() refetches within 500ms when it isn't.
  const mediaDuration = clockTrusted ? videoEl.duration : barTime && barTime.total;
  if (
    fetchedDuration && Number.isFinite(mediaDuration) &&
    Math.abs(mediaDuration - fetchedDuration) > 2
  ) {
    return;
  }

  const t = clock - syncOffset;
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

// "Try again" after a failed fetch: same song, same length. The clock is
// mid-song by then, so the lyrics follow it straight away.
Panel.onRetry(() => onSongChange(lastTitle, lastArtist, fetchedDuration, false));

// Words already in your list wear a highlighter mark in every song. The list
// changes when you save a word, delete one, or a sync brings in words saved
// on the phone — all three arrive through VocabStore.onChange.
async function refreshSavedWords() {
  const all = await VocabStore.getAll();
  Panel.setSavedWords(new Set(all.map((e) => MeaningProvider.normalize(e.word))));
}
refreshSavedWords();
VocabStore.onChange(refreshSavedWords);

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
