// lyricsProvider.js — ALL lyrics fetching + LRC parsing lives here.
//
// Swappable by design: if we ever move to a licensed provider (Musixmatch...),
// only this file changes. Everything else just calls LyricsProvider.getLyrics().
//
// Provider: LRCLIB (https://lrclib.net) — free, open, no API key.
//
// Matching strategy (why there are several attempts):
//   YouTube Music titles and artists are often "dirtier" than LRCLIB's
//   catalog: "Hotel California (2013 Remaster)", "KAROL G & Nicki Minaj",
//   channel names like "LuisFonsiVEVO" or "Adele - Topic". So we build a few
//   cleaned-up variants of the title and artist and try them from most to
//   least specific. Search results are only accepted if their title and
//   artist actually resemble ours — better "No lyrics found" than the wrong
//   song's lyrics.

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

  async function apiCall(path, params) {
    const res = await fetch(`${API}/${path}?` + new URLSearchParams(params));
    if (res.status === 404) return null; // LRCLIB's "not found" — not an error
    if (!res.ok) throw new Error(`LRCLIB ${path} failed (HTTP ${res.status})`);
    return res.json();
  }

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

  // The one public entry point.
  // Returns { synced, plain, matched } | { instrumental: true } | null.
  async function getLyrics({ title, artist, duration }) {
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
      for (const [track_name, artist_name] of pairs) {
        const params = { track_name, artist_name };
        if (dur !== null) params.duration = dur;
        hit = await apiCall("get", params);
        if (hit) break;
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
    };
  }

  return {
    getLyrics,
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
