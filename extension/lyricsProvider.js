// lyricsProvider.js — ALL lyrics fetching + LRC parsing lives here.
//
// Swappable by design: if we ever move to a licensed provider (Musixmatch...),
// only this file changes. Everything else just calls LyricsProvider.getLyrics().
//
// Sources, tried in order:
//   1. LRCLIB (https://lrclib.net) — free, open, no API key. Often synced.
//   2. YouTube Music's own Lyrics tab — only when running inside the
//      extension on music.youtube.com (the caller passes getVideoId). These
//      are the licensed lyrics YT Music shows itself; from the browser they
//      come back unsynced (plain text), so they're the backup, not the default.
//
// LRCLIB matching strategy (why there are several attempts):
//   YouTube Music titles and artists are often "dirtier" than LRCLIB's
//   catalog: "Hotel California (2013 Remaster)", "KAROL G & Nicki Minaj",
//   channel names like "LuisFonsiVEVO" or "Adele - Topic". So we build a few
//   cleaned-up variants of the title and artist and try them from most to
//   least specific. Search results are only accepted if their title and
//   artist actually resemble ours — better "not found" (and a chance for the
//   YT Music fallback) than the wrong song's lyrics.

const LyricsProvider = (() => {
  const API = "https://lrclib.net/api";

  // ---------- title / artist cleanup ----------

  // Video titles carry junk like "[Official Lyric Visualizer]" or
  // "(Official Video)" that ruins search matching. Strip any (...) or [...]
  // chunk containing one of these keywords — but keep useful ones
  // like "(GRiZ Remix)".
  const JUNK =
    /[(\[][^)\]]*(official|lyrics?|video|audio|visuali[sz]er|\bmv\b|\bhd\b|4k)[^)\]]*[)\]]/gi;

  // Version tags that LRCLIB usually stores WITHOUT: remasters, live takes,
  // edits, soundtrack credits, featured artists. Same lyrics, different label.
  const VERSION_WORDS =
    "remaster(?:ed)?|live|radio edit|edit|single version|album version|" +
    "mono|stereo|bonus track|deluxe|from|feat\\.?|ft\\.?|featuring|with|prod\\.?";
  // Credits only count at the START of a bracket, so "(feat. X)" and
  // '(From "Frozen")' go but "(Stay with Me)" stays.
  const CREDIT_WORDS = "from|feat\\.?|ft\\.?|featuring|with|prod\\.?";
  const TAG_WORDS = "remaster(?:ed)?|live|radio edit|edit|single version|album version|mono|stereo|bonus track|deluxe";
  // In brackets: "(2013 Remaster)", "[Live at Wembley]", "(feat. X)", '(From "Frozen")'.
  const VERSION_BRACKET = new RegExp(
    `\\s*[(\\[](?:(?:${CREDIT_WORDS})\\s|[^)\\]]*\\b(?:${TAG_WORDS})\\b)[^)\\]]*[)\\]]`,
    "gi"
  );
  // After a dash at the end: "- Remastered 2011", "- Radio Edit", "- Live".
  const VERSION_DASH = new RegExp(`\\s+[-–—]\\s+[^-–—]*\\b(?:${VERSION_WORDS})\\b[^-–—]*$`, "i");
  // Bare "feat. X" / "ft. X" with no brackets: "Despacito ft. Daddy Yankee".
  const BARE_FEAT = /\s+(?:feat\.?|ft\.|featuring)\s+.*$/i;

  function cleanTitle(rawTitle, artist) {
    let t = rawTitle.replace(JUNK, "").trim();
    // Video titles often look like "Artist & Friend - Song Title".
    // If the part before " - " mentions the detected artist, drop it.
    const dash = t.indexOf(" - ");
    if (dash !== -1 && artist) {
      const before = norm(t.slice(0, dash));
      const firstArtist = norm(mainArtist(artist));
      if (firstArtist && before.includes(firstArtist)) t = t.slice(dash + 3);
    }
    return t.replace(/\s{2,}/g, " ").trim();
  }

  // Remove version tags (see above). Never returns an empty string.
  function stripVersion(title) {
    const t = title
      .replace(VERSION_BRACKET, "")
      .replace(VERSION_DASH, "")
      .replace(BARE_FEAT, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    return t || title;
  }

  // Channel names used as "artist" on video uploads:
  // "Adele - Topic" → "Adele", "LuisFonsiVEVO" → "Luis Fonsi".
  function cleanArtist(artist) {
    if (!artist) return "";
    let a = artist.replace(/\s*-\s*topic$/i, "").trim();
    if (/vevo$/i.test(a)) {
      a = a.replace(/\s*vevo$/i, "");
      // VEVO channels glue words together in CamelCase: split them back.
      a = a.replace(/([a-z])([A-Z])/g, "$1 $2");
    }
    return a.trim();
  }

  // "KAROL G & Nicki Minaj" → "KAROL G"; "HUNTR/X, EJAE" → "HUNTR/X".
  // (Separators need spaces around them so "AC/DC" or "P!nk" survive.)
  function mainArtist(artist) {
    if (!artist) return "";
    return artist.split(/\s*,\s*|\s+(?:&|x|feat\.?|ft\.?|featuring|with|and)\s+/i)[0].trim();
  }

  // ---------- similarity check for search results ----------

  // Lowercase, drop accents ("Canción" = "cancion"), punctuation → spaces.
  function norm(s) {
    return (s || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }
  const squash = (s) => norm(s).replace(/ /g, ""); // "Luis Fonsi" = "LuisFonsi"

  // Titles match if, after removing version tags, one contains the other
  // ("Despacito" vs "Despacito - Remix") or most of their words overlap.
  function titleMatches(ours, theirs) {
    const a = norm(stripVersion(ours));
    const b = norm(stripVersion(theirs));
    if (!a || !b) return false;
    if (a === b || squash(a) === squash(b)) return true;
    const shorter = a.length <= b.length ? a : b;
    const longer = shorter === a ? b : a;
    // Containment only counts when the shorter title isn't tiny
    // (otherwise "Hello" would match "Hello, Goodbye and Everything").
    if (shorter.length >= 4 && ` ${longer} `.includes(` ${shorter} `)) {
      // ...and covers more than half of the longer one ("Love" ≠ "Love Story").
      return shorter.split(" ").length / longer.split(" ").length > 0.5;
    }
    const wa = new Set(a.split(" "));
    const wb = new Set(b.split(" "));
    const common = [...wa].filter((w) => wb.has(w)).length;
    return common / Math.max(wa.size, wb.size) >= 0.7;
  }

  // Artists match if any of our artist names appears inside theirs or vice
  // versa (spaces ignored), e.g. "Bad Bunny" vs "Bad Bunny, Jhay Cortez".
  function artistMatches(ourArtists, theirs) {
    if (ourArtists.length === 0) return true; // manual search without artist
    const t = squash(theirs);
    if (!t) return false;
    return ourArtists.some((a) => {
      const s = squash(a);
      return s.length >= 2 && (t.includes(s) || s.includes(t));
    });
  }

  // ---------- LRCLIB calls ----------

  // LRC format is plain text, one line per lyric: "[mm:ss.xx] the words".
  // Parse into [{time: seconds, text}] sorted by time.
  // (Rare LRC files put several timestamps on one line — not handled yet.)
  function parseLrc(lrc) {
    const lines = [];
    for (const raw of lrc.split("\n")) {
      const m = raw.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
      if (!m) continue;
      lines.push({ time: Number(m[1]) * 60 + Number(m[2]), text: m[3].trim() });
    }
    return lines.sort((a, b) => a.time - b.time);
  }

  // ---------- network: timeout + one retry ----------

  const TIMEOUT_MS = 7000; // a slow LRCLIB shouldn't leave "Searching…" forever
  const RETRY_DELAY_MS = 1000;

  // One fetch that gives up after TIMEOUT_MS. AbortController is the standard
  // way to cancel a fetch: calling abort() makes the fetch reject.
  async function fetchWithTimeout(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { signal: ctrl.signal });
    } catch (err) {
      if (err.name === "AbortError") throw new Error(`LRCLIB timed out after ${TIMEOUT_MS / 1000}s`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // Tries once, and once more after a short pause if the failure looks
  // temporary (timeout, network blip, 429 rate limit, 5xx server error).
  // A 404 is LRCLIB's normal "not found" answer, so it's never retried.
  async function apiCall(path, params) {
    const url = `${API}/${path}?` + new URLSearchParams(params);
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetchWithTimeout(url);
        if (res.status === 404) return null;
        if (res.ok) return res.json();
        lastError = new Error(`LRCLIB ${path} failed (HTTP ${res.status})`);
        if (res.status !== 429 && res.status < 500) break; // 400 etc: retrying won't help
      } catch (err) {
        lastError = err; // timeout or network error
      }
      if (attempt === 1) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
    throw lastError;
  }

  // ---------- storage: cache + missed-songs log ----------
  //
  // This file runs in two places: the extension (chrome.storage.local) and
  // the phone companion web page (no chrome.* APIs → localStorage). This tiny
  // adapter hides the difference. Any storage failure is swallowed: the cache
  // is a speed-up, it must never stop lyrics from loading.

  const hasChromeStorage =
    typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

  async function storeGet(key, fallback) {
    try {
      if (hasChromeStorage) {
        const data = await chrome.storage.local.get(key);
        return data[key] ?? fallback;
      }
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  async function storeSet(key, value) {
    try {
      if (hasChromeStorage) await chrome.storage.local.set({ [key]: value });
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.warn("[LyricsCompanion] could not save", key, err);
    }
  }

  const CACHE_KEY = "lyricsCache";
  const MISSES_KEY = "lyricsMisses";
  const CACHE_MAX = 300; // ~5 KB per song → ~1.5 MB, well inside storage limits
  const MISSES_MAX = 200;
  const MISS_TTL_MS = 24 * 60 * 60 * 1000; // re-ask LRCLIB about a miss after a day

  // Same song = same title + artist, ignoring case and extra spaces.
  // Duration is left out on purpose: it can be stale for a moment right
  // after a skip, and the same song's video version is a few seconds off.
  function songKey(title, artist) {
    const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
    return `${norm(title)}|${norm(artist)}`;
  }

  // Returns the cached answer, or undefined when we must ask LRCLIB.
  // Cached value is the getLyrics() result itself (null = known miss).
  async function cacheGet(key) {
    const cache = await storeGet(CACHE_KEY, {});
    const entry = cache[key];
    if (!entry) return undefined;
    if (entry.result === null && Date.now() - entry.savedAt > MISS_TTL_MS) return undefined;
    return entry.result;
  }

  async function cachePut(key, result) {
    const cache = await storeGet(CACHE_KEY, {});
    cache[key] = { result, savedAt: Date.now() };
    // Over the limit → drop the oldest entries.
    const keys = Object.keys(cache);
    if (keys.length > CACHE_MAX) {
      keys
        .sort((a, b) => cache[a].savedAt - cache[b].savedAt)
        .slice(0, keys.length - CACHE_MAX)
        .forEach((k) => delete cache[k]);
    }
    await storeSet(CACHE_KEY, cache);
  }

  // The missed-songs log: one row per song that didn't resolve, with the raw
  // title/artist exactly as YouTube Music showed them, so we can see WHY
  // matching failed and build a list of songs to test future fixes against.
  async function logMiss(song, reason, detail) {
    const key = songKey(song.title, song.artist);
    const misses = await storeGet(MISSES_KEY, []);
    const existing = misses.find((m) => m.key === key);
    const now = new Date().toISOString();
    if (existing) {
      existing.count += 1;
      existing.lastTried = now;
      existing.reason = reason;
      existing.detail = detail || null;
    } else {
      misses.unshift({
        key,
        title: song.title,
        artist: song.artist || null,
        album: song.album || null,
        duration: Number.isFinite(song.duration) ? Math.round(song.duration) : null,
        searchedAs: cleanTitle(song.title, song.artist),
        reason, // "not_found" | "error"
        detail: detail || null,
        count: 1,
        firstTried: now,
        lastTried: now,
      });
    }
    await storeSet(MISSES_KEY, misses.slice(0, MISSES_MAX));
  }

  // A song that resolves later (LRCLIB added it, or a matching fix landed)
  // leaves the log by itself.
  async function clearMiss(song) {
    const key = songKey(song.title, song.artist);
    const misses = await storeGet(MISSES_KEY, []);
    const kept = misses.filter((m) => m.key !== key);
    if (kept.length !== misses.length) await storeSet(MISSES_KEY, kept);
  }

  const getMissedSongs = () => storeGet(MISSES_KEY, []);
  const clearMissedSongs = () => storeSet(MISSES_KEY, []);
  const clearCache = () => storeSet(CACHE_KEY, {});

  // From search results, keep only those that really look like our song,
  // then prefer: synced with close duration > any synced > plain with close
  // duration > any plain. Returns null if nothing passes the check.
  function pickBest(results, { titles, artists, duration }) {
    if (!results || results.length === 0) return null;
    const ok = results.filter(
      (r) =>
        (r.syncedLyrics || r.plainLyrics || r.instrumental) &&
        titles.some((t) => titleMatches(t, r.trackName || r.name || "")) &&
        artistMatches(artists, r.artistName || "")
    );
    const near = (r) =>
      !Number.isFinite(duration) || !r.duration || Math.abs(r.duration - duration) <= 10;
    return (
      ok.find((r) => r.syncedLyrics && near(r)) ||
      ok.find((r) => r.syncedLyrics) ||
      ok.find((r) => r.plainLyrics && near(r)) ||
      ok.find((r) => r.plainLyrics) ||
      ok.find((r) => r.instrumental) ||
      null
    );
  }

  const unique = (arr) => [...new Set(arr.filter(Boolean))];

  // Build the title/artist variants we will try, most specific first.
  function buildVariants(title, artist) {
    const artistClean = cleanArtist(artist);
    const artists = unique([artistClean, mainArtist(artistClean)]);

    const base = cleanTitle(title, artistClean);
    const titles = unique([base, stripVersion(base)]);

    // "Someone - Song" left in the title (artist wasn't recognized, e.g. a
    // re-upload channel): also try "Someone" as artist and "Song" as title.
    // (Version tags are stripped first so "Song - Radio Edit" isn't split.)
    const plainBase = stripVersion(base);
    const dash = plainBase.indexOf(" - ");
    if (dash !== -1) {
      const before = plainBase.slice(0, dash).trim();
      const after = plainBase.slice(dash + 3).trim();
      if (before && after) {
        titles.push(after);
        artists.push(cleanArtist(before), mainArtist(before));
      }
    }
    return { titles: unique(titles), artists: unique(artists) };
  }

  // ---------- Source 1: LRCLIB ----------
  // Returns { synced, plain, matched, source } | { instrumental: true } | null.
  async function fromLrclib({ title, artist, album, duration }) {
    const { titles, artists } = buildVariants(title, artist);
    const ctx = { titles, artists, duration };
    const dur = Number.isFinite(duration) ? Math.round(duration) : null;
    const strippedTitle = titles[titles.length > 1 ? 1 : 0];
    const firstArtist = artists[0] || "";
    const lastArtist = artists[artists.length - 1] || "";

    // 1) Exact lookups. /api/get needs artist + title (duration makes it
    //    very accurate: LRCLIB only returns a track within ~2s of it).
    //    Try at most a few pairs so a miss doesn't take forever.
    let hit = null;
    if (artists.length > 0) {
      const pairs = unique(
        [
          [titles[0], firstArtist],
          [strippedTitle, firstArtist],
          [strippedTitle, artists[1] || firstArtist],
          [titles[titles.length - 1], lastArtist],
        ].map((p) => JSON.stringify(p))
      ).map((p) => JSON.parse(p));
      // When the media session gave us the album, try the first pair with
      // album_name too (LRCLIB's most exact lookup); the album-less tries
      // below still catch songs where YT's album name differs.
      if (album) {
        const [track_name, artist_name] = pairs[0];
        const params = { track_name, artist_name, album_name: album };
        if (dur !== null) params.duration = dur;
        hit = await apiCall("get", params);
      }
      for (const [track_name, artist_name] of pairs) {
        if (hit) break;
        const params = { track_name, artist_name };
        if (dur !== null) params.duration = dur;
        hit = await apiCall("get", params);
      }
    }

    // 2) Fuzzy search, with every result checked against our variants.
    if (!hit) {
      const q = { track_name: strippedTitle };
      if (artists.length > 0) q.artist_name = artists[1] || firstArtist;
      hit = pickBest(await apiCall("search", q), ctx);
    }
    if (!hit) {
      const q = `${artists[1] || firstArtist} ${strippedTitle}`.trim();
      hit = pickBest(await apiCall("search", { q }), ctx);
    }

    if (!hit) return null;
    if (hit.instrumental) return { instrumental: true };
    if (!hit.syncedLyrics && !hit.plainLyrics) return null;

    return {
      synced: hit.syncedLyrics ? parseLrc(hit.syncedLyrics) : null,
      plain: hit.plainLyrics || null,
      matched: `${hit.trackName} — ${hit.artistName}`,
      source: "LRCLIB",
    };
  }

  // ---------- Source 2: YouTube Music's Lyrics tab ----------
  // YT Music has no public API, but its own web app talks to an internal
  // one ("InnerTube", under /youtubei/v1/). Our content script runs on
  // music.youtube.com, so these are ordinary same-origin requests — no key,
  // no extra permissions. Two steps, the same ones the Lyrics tab makes:
  //   POST /next   {videoId}  → the watch page; its Lyrics tab carries a
  //                             browseId starting with "MPLY" (missing when
  //                             YT has no lyrics for the song)
  //   POST /browse {browseId} → the lyrics text + "Source: Musixmatch"-style
  //                             credit line
  // Verified on the live site 2026-11-26. Like the player-bar selectors,
  // this is undocumented and may change: it's the first suspect if the
  // fallback stops finding anything.
  const YT_FALLBACK_CLIENT_VERSION = "1.20241106.01.00";
  const YT_TIMEOUT_MS = 6000;

  // The page embeds its current client version in an inline script. Our
  // isolated world can't read the page's JS variables, but it can read the
  // script text. If that ever fails, an older version still works.
  let ytClientVersion = null;
  function getYtClientVersion() {
    if (ytClientVersion) return ytClientVersion;
    for (const s of document.scripts) {
      const m = /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(s.textContent);
      if (m) return (ytClientVersion = m[1]);
    }
    return YT_FALLBACK_CLIENT_VERSION;
  }

  async function ytCall(endpoint, body) {
    const res = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: { client: { clientName: "WEB_REMIX", clientVersion: getYtClientVersion(), hl: "en" } },
        ...body,
      }),
      signal: AbortSignal.timeout(YT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`YouTube Music ${endpoint} failed (HTTP ${res.status})`);
    return res.json();
  }

  // Walk any JSON tree and return the first object that has `key`.
  // YT's response nesting changes often; searching by name is sturdier
  // than hard-coding a 12-step path.
  function findKey(node, key) {
    if (!node || typeof node !== "object") return null;
    if (key in node) return node[key];
    for (const child of Object.values(node)) {
      const found = findKey(child, key);
      if (found) return found;
    }
    return null;
  }

  const runsText = (t) => (t && t.runs ? t.runs.map((r) => r.text).join("") : (t && t.simpleText) || "");

  // Returns { synced: null, plain, matched, source } | null.
  async function fromYouTubeMusic({ videoId, title, artist }) {
    if (!videoId || location.hostname !== "music.youtube.com") return null;

    const watch = await ytCall("next", { videoId });
    const browseId = (JSON.stringify(watch).match(/"browseId":"(MPLY[^"]+)"/) || [])[1];
    if (!browseId) return null; // YT Music has no lyrics for this one either

    const page = await ytCall("browse", { browseId });
    const shelf = findKey(page, "musicDescriptionShelfRenderer");
    const plain = shelf ? runsText(shelf.description).trim() : "";
    if (!plain) return null;

    // Footer reads e.g. "Source: Musixmatch" — keep just the licensor's name.
    const credit = shelf ? runsText(shelf.footer).replace(/^\s*source:\s*/i, "").trim() : "";
    return {
      synced: null,
      plain,
      matched: `${title}${artist ? ` — ${artist}` : ""}`,
      source: credit ? `YouTube Music (${credit})` : "YouTube Music",
    };
  }

  // ---------- All sources, in order (no cache) ----------
  // Returns { synced, plain, matched, source } | { instrumental: true } | null.
  //
  // getVideoId (optional) is a function, not a value: it's called only if
  // LRCLIB comes up short, a few seconds later, so it reads the video that's
  // actually playing by then (right after a skip the old id can linger).
  async function resolveLyrics({ title, artist, album, duration, getVideoId }) {
    let lrclib = null;
    let lrclibError = null;
    try {
      lrclib = await fromLrclib({ title, artist, album, duration });
    } catch (err) {
      lrclibError = err; // LRCLIB down? YT Music may still have it.
    }

    // Synced LRCLIB lyrics are the best we can get — done.
    if (lrclib && (lrclib.instrumental || lrclib.synced)) return lrclib;

    // LRCLIB missed, failed, or only had plain text: try YT Music.
    // YT's plain text is matched to the exact video (no fuzzy guessing), so
    // when LRCLIB only offers plain lyrics too, YT's are the safer pick.
    if (typeof getVideoId === "function") {
      try {
        const yt = await fromYouTubeMusic({ videoId: getVideoId(), title, artist });
        if (yt) return yt;
      } catch (err) {
        console.log(`🎵 [LyricsCompanion] YouTube Music lyrics fallback failed: ${err.message}`);
      }
    }

    if (lrclib) return lrclib;
    if (lrclibError) throw lrclibError; // nothing anywhere, and LRCLIB errored
    return null;
  }

  // ---------- The one public entry point: cache first, then all sources ----------
  // song = { title, artist, album?, duration?, getVideoId? }.
  // Returns { synced, plain, matched, source, fromCache? } | { instrumental: true } | null.
  // Throws only when every source came up empty AND LRCLIB was unreachable.
  async function getLyrics(song) {
    const key = songKey(song.title, song.artist);

    const cached = await cacheGet(key);
    if (cached !== undefined) {
      return cached ? { ...cached, fromCache: true } : null;
    }

    let result;
    try {
      result = await resolveLyrics(song);
    } catch (err) {
      // Network trouble isn't cached (next play tries again), but it is
      // logged so a song that keeps erroring shows up in the list.
      await logMiss(song, "error", err.message);
      throw err;
    }

    // Found lyrics (from any source) and misses are both cached; a miss
    // only for MISS_TTL_MS. A miss here means LRCLIB AND YouTube Music
    // (when available) both had nothing.
    await cachePut(key, result);
    if (result) await clearMiss(song);
    else await logMiss(song, "not_found");
    return result;
  }

  return {
    getLyrics,
    getMissedSongs,
    clearMissedSongs,
    clearCache,
    parseLrc,
    // Exposed for testing in the console / Node:
    cleanTitle,
    stripVersion,
    cleanArtist,
    mainArtist,
    buildVariants,
    titleMatches,
    artistMatches,
  };
})();

// Let Node tests `require()` this file; harmless in the browser.
if (typeof module !== "undefined") module.exports = LyricsProvider;
