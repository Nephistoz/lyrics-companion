// meaningProvider.js — ALL definition + translation fetching lives here.
//
// Swappable like lyricsProvider.js: if we change dictionary or translation
// services, only this file changes. Exposes MeaningProvider.lookup(word).
//
// Definitions: Free Dictionary API (dictionaryapi.dev) — English, free, no key.
// Translation EN→ES: Lingva (free Google Translate mirrors). Public mirrors
// come and go, so we walk a list (same trick as the DOM selector lists) and
// fall back to MyMemory if every mirror is down. Checked 2026-07-14:
// dialectapp was the healthy one, lingva.ml & friends had broken upstreams.

const MeaningProvider = (() => {
  const DICT = "https://api.dictionaryapi.dev/api/v2/entries/en/";
  const LINGVA_INSTANCES = [
    "https://lingva.dialectapp.org",
    "https://lingva.ml",
    "https://translate.plausibility.cloud",
    "https://lingva.thedaviddelta.com",
  ];
  const MYMEMORY = "https://api.mymemory.translated.net/get";

  // "Gettin'" → "gettin" : straighten curly quotes, trim quote marks, lowercase.
  // Exported: it is THE key for a word, so the panel can tell which lyric
  // words are already in the vocabulary list by the same rule they were saved.
  function normalize(raw) {
    return raw.replace(/’/g, "'").replace(/^'+|'+$/g, "").toLowerCase();
  }

  // Every request gets a hard 4s timeout so one hung server can't stall the
  // popup — we'd rather show partial results than spin forever.
  function fetchJson(url) {
    return fetch(url, { signal: AbortSignal.timeout(4000) }).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });
  }

  async function fetchDefinitions(word) {
    let data;
    try {
      data = await fetchJson(DICT + encodeURIComponent(word));
    } catch {
      // Lyrics slang: "gettin" is really "getting" — one retry with +g.
      if (!word.endsWith("in")) return null;
      try {
        data = await fetchJson(DICT + encodeURIComponent(word + "g"));
      } catch {
        return null;
      }
    }
    const entry = data[0];
    if (!entry) return null;
    // Keep it digestible: first definition of up to two parts of speech.
    const definitions = [];
    for (const m of entry.meanings || []) {
      if (m.definitions?.[0]) {
        definitions.push({ partOfSpeech: m.partOfSpeech, definition: m.definitions[0].definition });
      }
      if (definitions.length >= 2) break;
    }
    return { phonetic: entry.phonetic || "", definitions };
  }

  async function fetchTranslation(word) {
    for (const base of LINGVA_INSTANCES) {
      try {
        const data = await fetchJson(`${base}/api/v1/en/es/${encodeURIComponent(word)}`);
        if (data.translation) return data.translation;
      } catch {
        // this mirror is down or broken — try the next one
      }
    }
    try {
      const data = await fetchJson(`${MYMEMORY}?q=${encodeURIComponent(word)}&langpair=en%7Ces`);
      return data.responseData?.translatedText || null;
    } catch {
      return null;
    }
  }

  // Translate a whole song's lines for the "Spanish under each line" mode.
  // Lines are batched a dozen at a time joined with newlines (Google keeps
  // line breaks) — far fewer requests than one per line. Any batch that
  // comes back misaligned falls back to line-by-line for that batch only.
  async function translateLines(lines) {
    const out = new Array(lines.length).fill("");
    const BATCH = 12;
    for (let i = 0; i < lines.length; i += BATCH) {
      const batch = lines.slice(i, i + BATCH);
      const joined = batch.map((l) => l || "…").join("\n");
      const translated = await fetchTranslation(joined);
      const parts = translated ? translated.split("\n") : null;
      if (parts && parts.length === batch.length) {
        parts.forEach((p, j) => {
          if (batch[j]) out[i + j] = p.trim();
        });
      } else {
        for (let j = 0; j < batch.length; j++) {
          if (batch[j]) out[i + j] = (await fetchTranslation(batch[j])) || "";
        }
      }
    }
    return out;
  }

  // The one public entry point. Definition and translation fly in parallel
  // and fail independently — a popup with only one of them is still useful.
  async function lookup(rawWord) {
    const word = normalize(rawWord);
    const [def, translation] = await Promise.all([
      fetchDefinitions(word).catch(() => null),
      fetchTranslation(word).catch(() => null),
    ]);
    // Google echoes unknown words back unchanged. If the dictionary also
    // drew a blank, treat the echo as "no translation". (Real cognates like
    // "hospital" keep their identical translation — they have definitions.)
    const defs = def ? def.definitions : [];
    const isEcho = translation && translation.toLowerCase() === word && defs.length === 0;
    return {
      word,
      phonetic: def ? def.phonetic : "",
      definitions: defs,
      translation: isEcho ? null : translation,
    };
  }

  return { lookup, translateLines, normalize };
})();
