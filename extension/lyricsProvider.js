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

  // The one public entry point.
  // Returns { synced, plain, matched } | { instrumental: true } | null.
  async function getLyrics({ title, artist, duration }) {
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
    };
  }

  return { getLyrics, cleanTitle, parseLrc };
})();
