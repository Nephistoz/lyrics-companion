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

  async function apiCall(path, params) {
    const res = await fetch(`${API}/${path}?` + new URLSearchParams(params));
    if (res.status === 404) return null; // LRCLIB's "not found" — not an error
    if (!res.ok) throw new Error(`LRCLIB ${path} failed (HTTP ${res.status})`);
    return res.json();
  }

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

  // ---------- Source 1: LRCLIB ----------
  // Returns { synced, plain, matched } | { instrumental: true } | null.
  async function fromLrclib({ title, artist, duration }) {
    const track = cleanTitle(title, artist);

    // 1) Exact lookup — duration matching makes this very accurate.
    const params = { track_name: track };
    if (artist) params.artist_name = artist;
    if (Number.isFinite(duration)) params.duration = Math.round(duration);
    let hit = artist ? await apiCall("get", params) : null;

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

  // ---------- The one public entry point ----------
  // Returns { synced, plain, matched, source } | { instrumental: true } | null.
  //
  // getVideoId (optional) is a function, not a value: it's called only if
  // LRCLIB comes up short, a few seconds later, so it reads the video that's
  // actually playing by then (right after a skip the old id can linger).
  async function getLyrics({ title, artist, duration, getVideoId }) {
    let lrclib = null;
    let lrclibError = null;
    try {
      lrclib = await fromLrclib({ title, artist, duration });
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

  return { getLyrics, cleanTitle, parseLrc };
})();
