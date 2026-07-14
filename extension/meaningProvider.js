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

  return { lookup };
})();
