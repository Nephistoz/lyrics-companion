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
  // Parse into [{time: seconds, text}] sorted by time. An "[offset:±ms]" tag
  // shifts every timestamp (positive = lyrics land earlier), so honour it.
  // (Rare LRC files put several timestamps on one line — not handled yet.)
  function parseLrc(lrc) {
    const lines = [];
    let offset = 0;
    for (const raw of lrc.split("\n")) {
      const off = raw.match(/^\[offset:\s*([+-]?\d+)\s*\]/i);
      if (off) {
        offset = Number(off[1]) / 1000;
        continue;
      }
      const m = raw.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
      if (!m) continue;
      lines.push({ time: Number(m[1]) * 60 + Number(m[2]) - offset, text: m[3].trim() });
    }
    return lines.sort((a, b) => a.time - b.time);
  }

  async function apiCall(path, params) {
    const res = await fetch(`${API}/${path}?` + new URLSearchParams(params));
    if (res.status === 404) return null; // LRCLIB's "not found" — not an error
    if (!res.ok) throw new Error(`LRCLIB ${path} failed (HTTP ${res.status})`);
    return res.json();
  }

  // Same song, several uploads: LRCLIB often carries versions whose lengths
  // differ by a minute (radio edit vs extended vs live). Choosing one that is
  // not the length of the track being played is exactly what makes lyrics
  // drift, so always take the CLOSEST duration — never just the first synced
  // hit. With no duration to compare against, the API's own order is kept.
  function pickBest(results, duration) {
    if (!results || results.length === 0) return null;
    const gap = (r) =>
      Number.isFinite(duration) && r.duration ? Math.abs(r.duration - duration) : Infinity;
    const byGap = (a, b) => gap(a) - gap(b);
    const synced = results.filter((r) => r.syncedLyrics).sort(byGap);
    if (synced.length) return synced[0];
    return results.filter((r) => r.plainLyrics).sort(byGap)[0] || results[0];
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

    const matchedDuration = hit.duration || null;
    return {
      synced: hit.syncedLyrics ? parseLrc(hit.syncedLyrics) : null,
      plain: hit.plainLyrics || null,
      matched: `${hit.trackName} — ${hit.artistName}`,
      matchedDuration,
      // Timings are only trustworthy when the matched upload is about as long
      // as what is playing; past ~15s apart the lyrics drift as the song runs.
      durationMismatch:
        Number.isFinite(duration) && matchedDuration
          ? Math.abs(matchedDuration - duration) > 15
          : false,
    };
  }

  return { getLyrics, cleanTitle, parseLrc };
})();
