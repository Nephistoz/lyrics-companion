// lyricsProvider.js — ALL lyrics fetching + LRC parsing lives here.
//
// Swappable by design: if we ever move to a licensed provider (Musixmatch...),
// only this file changes. Everything else just calls LyricsProvider.getLyrics().
//
// Provider: LRCLIB (https://lrclib.net) — free, open, no API key.

const LyricsProvider = (() => {
  const API = "https://lrclib.net/api";

  // Video titles carry junk like "[Official Lyric Visualizer]" or
  // "(Official Video)" that ruins search matching. Strip any (...) or [...]
  // chunk containing one of these keywords — but keep useful ones
  // like "(GRiZ Remix)".
  const JUNK =
    /[(\[][^)\]]*(official|lyrics?|video|audio|visuali[sz]er|\bmv\b|\bhd\b|4k)[^)\]]*[)\]]/gi;

  function cleanTitle(rawTitle, artist) {
    let t = rawTitle.replace(JUNK, "").trim();
    // Video titles often look like "Artist & Friend - Song Title".
    // If the part before " - " mentions the detected artist, drop it.
    const dash = t.indexOf(" - ");
    if (dash !== -1 && artist) {
      const before = t.slice(0, dash).toLowerCase();
      const firstArtist = artist.split(/[,&]/)[0].trim().toLowerCase();
      if (firstArtist && before.includes(firstArtist)) t = t.slice(dash + 3);
    }
    return t.replace(/\s{2,}/g, " ").trim();
  }

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

  // From a list of search results, prefer: synced lyrics with a duration
  // close to ours > any synced > plain lyrics close in duration > anything.
  function pickBest(results, duration) {
    if (!results || results.length === 0) return null;
    const near = (r) =>
      !Number.isFinite(duration) || !r.duration || Math.abs(r.duration - duration) <= 10;
    return (
      results.find((r) => r.syncedLyrics && near(r)) ||
      results.find((r) => r.syncedLyrics) ||
      results.find((r) => r.plainLyrics && near(r)) ||
      results[0]
    );
  }

  // Asks LRCLIB, no cache involved.
  // Returns { synced, plain, matched } | { instrumental: true } | null.
  async function fetchFromLrclib({ title, artist, album, duration }) {
    const track = cleanTitle(title, artist);

    // 1) Exact lookup — duration matching makes this very accurate.
    //    With the album first (when we know it), then without: if YouTube's
    //    album name differs from LRCLIB's, the album-less try still matches.
    let hit = null;
    if (artist) {
      const params = { track_name: track, artist_name: artist };
      if (Number.isFinite(duration)) params.duration = Math.round(duration);
      if (album) hit = await apiCall("get", { ...params, album_name: album });
      if (!hit) hit = await apiCall("get", params);
    }

    // 2) Fuzzy search fallback (handles messy video titles, remixes...).
    if (!hit) {
      const q = { track_name: track };
      if (artist) q.artist_name = artist;
      hit = pickBest(await apiCall("search", q), duration);
    }
    if (!hit) {
      hit = pickBest(await apiCall("search", { q: `${artist || ""} ${track}`.trim() }), duration);
    }

    if (!hit) return null;
    if (hit.instrumental) return { instrumental: true };
    if (!hit.syncedLyrics && !hit.plainLyrics) return null;

    return {
      synced: hit.syncedLyrics ? parseLrc(hit.syncedLyrics) : null,
      plain: hit.plainLyrics || null,
      matched: `${hit.trackName} — ${hit.artistName}`,
    };
  }

  // The one public entry point: cache first, then LRCLIB.
  // song = { title, artist, album?, duration } (album and duration optional).
  // Returns { synced, plain, matched, fromCache? } | { instrumental: true } | null.
  // Throws only when LRCLIB is unreachable (after the retry).
  async function getLyrics(song) {
    const key = songKey(song.title, song.artist);

    const cached = await cacheGet(key);
    if (cached !== undefined) {
      return cached ? { ...cached, fromCache: true } : null;
    }

    let result;
    try {
      result = await fetchFromLrclib(song);
    } catch (err) {
      // Network trouble isn't cached (next play tries again), but it is
      // logged so a song that keeps erroring shows up in the list.
      await logMiss(song, "error", err.message);
      throw err;
    }

    await cachePut(key, result); // a miss is cached too, for MISS_TTL_MS
    if (result) await clearMiss(song);
    else await logMiss(song, "not_found");
    return result;
  }

  return {
    getLyrics,
    getMissedSongs,
    clearMissedSongs,
    clearCache,
    cleanTitle,
    parseLrc,
  };
})();
