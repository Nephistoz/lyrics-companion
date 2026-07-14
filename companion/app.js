// app.js — phone companion: flashcard review (spaced repetition) + manual
// song search with the same tappable-words behavior as the desktop panel.
//
// Data lives in Supabase (via SyncProvider); this app has no local vocabulary
// store — the phone is always looking at the synced list.

const $ = (id) => document.getElementById(id);

/* ---------- one-time Supabase setup (kept in localStorage) ---------- */

const CONFIG_KEY = "lc-sync-config";

function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY));
  } catch {
    return null;
  }
}

function boot() {
  const cfg = loadConfig();
  SyncProvider.configure(cfg);
  $("setup").hidden = SyncProvider.isConfigured();
  $("app").hidden = !SyncProvider.isConfigured();
  if (SyncProvider.isConfigured()) startReview();
}

$("setup-save").addEventListener("click", async () => {
  const cfg = {
    supabaseUrl: $("setup-url").value.trim().replace(/\/+$/, ""),
    supabaseKey: $("setup-key").value.trim(),
  };
  SyncProvider.configure(cfg);
  $("setup-status").textContent = "Checking connection…";
  try {
    await SyncProvider.fetchAll(); // fails fast if URL/key are wrong
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    boot();
  } catch (err) {
    $("setup-status").textContent = `Couldn't connect (${err.message}). Check both values.`;
  }
});

/* ---------- tabs ---------- */

$("tab-review").addEventListener("click", () => switchTab("review"));
$("tab-search").addEventListener("click", () => switchTab("search"));

function switchTab(name) {
  $("review").hidden = name !== "review";
  $("search").hidden = name !== "search";
  $("tab-review").classList.toggle("active", name === "review");
  $("tab-search").classList.toggle("active", name === "search");
  if (name === "review") startReview();
}

/* ---------- flashcards with 1-3-7-14 day spaced repetition ---------- */

const INTERVAL_DAYS = [1, 3, 7, 14];
let queue = []; // entries due for review
let current = null;
let revealed = false;

async function startReview() {
  $("card").hidden = true;
  $("grade").hidden = true;
  $("due-info").textContent = "Loading…";
  try {
    const all = await SyncProvider.fetchAll();
    const now = new Date().toISOString();
    queue = all.filter((e) => !e.nextReview || e.nextReview <= now);
    nextCard();
  } catch (err) {
    $("due-info").textContent = `Couldn't load words (${err.message}).`;
  }
}

function nextCard() {
  current = queue.shift() || null;
  revealed = false;
  if (!current) {
    $("card").hidden = true;
    $("grade").hidden = true;
    $("due-info").textContent = "All done — nothing due right now. 🎉 Go listen to some music.";
    return;
  }
  $("due-info").textContent = `${queue.length + 1} to review`;
  $("card").hidden = false;
  $("card-word").textContent = current.word;
  $("card-song").textContent = `${current.songTitle} — ${current.artist}`;
  $("card-back").hidden = true;
  $("card-hint").hidden = false;
  $("grade").hidden = true;
}

$("card").addEventListener("click", () => {
  if (!current || revealed) return;
  revealed = true;
  $("card-trans").textContent = current.translation || "(no translation saved)";
  $("card-meaning").textContent = current.meaning || "";
  $("card-line").textContent = current.lyricLine ? `“${current.lyricLine}”` : "";
  $("card-back").hidden = false;
  $("card-hint").hidden = true;
  $("grade").hidden = false;
});

async function grade(knewIt) {
  if (!current) return;
  const entry = current;
  let nextReview;
  if (knewIt) {
    // interval grows with each success: 1 → 3 → 7 → 14 days (then stays 14)
    const days = INTERVAL_DAYS[Math.min(entry.intervalStep, INTERVAL_DAYS.length - 1)];
    entry.intervalStep = Math.min(entry.intervalStep + 1, INTERVAL_DAYS.length);
    nextReview = new Date(Date.now() + days * 86400000).toISOString();
  } else {
    // missed it: back to the start, and it comes around again in 10 minutes
    entry.intervalStep = 0;
    nextReview = new Date(Date.now() + 10 * 60000).toISOString();
  }
  entry.nextReview = nextReview;
  nextCard(); // don't make the user wait on the network
  try {
    await SyncProvider.updateReview(entry.id, entry.intervalStep, nextReview);
  } catch (err) {
    console.warn("saving review failed:", err.message);
  }
}

$("grade-yes").addEventListener("click", () => grade(true));
$("grade-no").addEventListener("click", () => grade(false));

/* ---------- manual song search → tappable lyrics ---------- */

let searchContext = { songTitle: "", artist: "" }; // for saving words

$("search-go").addEventListener("click", async () => {
  const artist = $("search-artist").value.trim();
  const title = $("search-title").value.trim();
  if (!title) {
    $("search-status").textContent = "Type at least a song title.";
    return;
  }
  $("search-status").textContent = "Searching…";
  $("search-lyrics").innerHTML = "";
  try {
    const result = await LyricsProvider.getLyrics({ title, artist, duration: NaN });
    if (!result || result.instrumental) {
      $("search-status").textContent = result ? "Instrumental track 🎹" : "No lyrics found 🙁";
      return;
    }
    searchContext = { songTitle: title, artist };
    $("search-status").textContent = `Matched: ${result.matched}`;
    const lines = result.synced ? result.synced.map((l) => l.text) : result.plain.split("\n");
    for (const text of lines) {
      const p = document.createElement("p");
      p.className = "lyr-line";
      renderTappableLine(p, text || "♪");
      $("search-lyrics").appendChild(p);
    }
  } catch (err) {
    $("search-status").textContent = `Search failed: ${err.message}`;
  }
});

// Same tokenizer idea as the desktop panel: words become tappable spans.
const WORD_RE = /([A-Za-zÀ-ÖØ-öø-ÿ'’]+)/;
function renderTappableLine(p, text) {
  for (const token of text.split(WORD_RE)) {
    if (!token) continue;
    if (/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(token)) {
      const span = document.createElement("span");
      span.className = "lyr-word";
      span.textContent = token;
      p.appendChild(span);
    } else {
      p.appendChild(document.createTextNode(token));
    }
  }
}

$("search-lyrics").addEventListener("click", (e) => {
  const span = e.target.closest(".lyr-word");
  if (span) openSheet(span.textContent, span.closest("p").textContent);
});

/* ---------- tapped-word bottom sheet ---------- */

let sheetLookupId = 0;

async function openSheet(word, line) {
  const id = ++sheetLookupId;
  $("sheet").hidden = false;
  $("sheet-word").textContent = word;
  $("sheet-trans").textContent = "";
  $("sheet-defs").textContent = "Looking it up…";
  const save = $("sheet-save");
  save.disabled = false;
  save.textContent = "★ Save word";

  const result = await MeaningProvider.lookup(word);
  if (id !== sheetLookupId) return;

  $("sheet-word").textContent = result.word;
  $("sheet-trans").textContent = result.translation || "";
  $("sheet-defs").textContent = result.definitions.length
    ? result.definitions.map((d) => `(${d.partOfSpeech}) ${d.definition}`).join("  ·  ")
    : result.translation ? "" : "Nothing found — you can still save it.";

  save.onclick = async () => {
    save.disabled = true;
    save.textContent = "Saving…";
    try {
      await SyncProvider.upsert([{
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        word: result.word,
        translation: result.translation || "",
        meaning: result.definitions[0] ? result.definitions[0].definition : "",
        songTitle: searchContext.songTitle,
        artist: searchContext.artist,
        lyricLine: line,
        dateAdded: new Date().toISOString(),
      }]);
      save.textContent = "✓ Saved";
    } catch (err) {
      save.disabled = false;
      save.textContent = `Failed — retry`;
      console.warn("save failed:", err.message);
    }
  };
}

$("sheet-close").addEventListener("click", () => {
  $("sheet").hidden = true;
  sheetLookupId++;
});

boot();
