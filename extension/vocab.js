// vocab.js — renders "Your words" in vocab.html.
//
// Words are grouped by the song they came from (most recently saved song
// first), because the song IS the memory hook. Each lyric line marks its word
// with the same highlighter stroke the panel uses.
//
// Everything is built with createElement + textContent (never innerHTML with
// data in it): lyrics and definitions are text from the internet, and this
// keeps them from ever being interpreted as HTML.

// mirrors THEMES in panel.js
const LIGHT = {
  "--bg": "#f8f6fb",
  "--ink": "#1d1926",
  "--haze": "#6b6478",
  "--rule": "rgba(29, 25, 38, 0.08)",
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The lyric line, with the saved word wearing its highlighter mark. Same
// tokenizer and word key as the panel, so "Gettin'" finds "gettin".
const WORD_RE = /([A-Za-zÀ-ÖØ-öø-ÿ'’]+)/;
function contextLine(line, word) {
  const p = el("p", "context");
  for (const token of line.split(WORD_RE)) {
    if (!token) continue;
    if (MeaningProvider.normalize(token) === word) p.appendChild(el("mark", "", token));
    else p.appendChild(document.createTextNode(token));
  }
  return p;
}

function deleteButton(entry) {
  const b = el("button", "del");
  b.type = "button";
  b.title = "Remove from your words";
  b.setAttribute("aria-label", `Remove "${entry.word}"`);
  b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';
  b.addEventListener("click", async () => {
    await VocabStore.remove(entry.id);
    render();
  });
  return b;
}

async function render() {
  const list = document.getElementById("list");
  const entries = await VocabStore.getAll();

  document.getElementById("count").textContent = entries.length ? String(entries.length) : "";
  list.replaceChildren();

  if (entries.length === 0) {
    const empty = el("div", "empty");
    empty.appendChild(el("h2", "", "No words yet"));
    const p = el("p", "", "Play a song on YouTube Music and tap any word in the lyrics to save it. Saved words get ");
    p.appendChild(el("mark", "", "marked"));
    p.append(" in every song they show up in.");
    empty.appendChild(p);
    list.appendChild(empty);
    return;
  }

  // entries arrive newest first, so groups come out ordered by latest save
  const groups = new Map();
  for (const e of entries) {
    const key = `${e.songTitle}|${e.artist}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  for (const items of groups.values()) {
    const { songTitle, artist } = items[0];
    const section = el("section", "group");
    const song = el("h2", "song");
    song.appendChild(el("span", "song-title", songTitle || "Unknown song"));
    if (artist) song.appendChild(el("span", "song-artist", artist));
    section.appendChild(song);

    const ul = el("ul");
    for (const e of items) {
      const li = el("li", "entry");
      const top = el("div", "top");
      top.appendChild(el("span", "word", e.word));
      if (e.translation) top.appendChild(el("span", "trans", e.translation));
      li.appendChild(top);
      if (e.lyricLine) li.appendChild(contextLine(e.lyricLine, e.word));
      if (e.meaning) li.appendChild(el("p", "def", e.meaning));
      li.appendChild(deleteButton(e));
      ul.appendChild(li);
    }
    section.appendChild(ul);
    list.appendChild(section);
  }
}

// Follow the theme + accent picked in the lyrics panel.
async function applyTheme() {
  const s = await SettingsStore.get();
  const root = document.documentElement.style;
  if (s.theme === "light") {
    for (const [k, v] of Object.entries(LIGHT)) root.setProperty(k, v);
  }
  root.setProperty("--accent", s.accent);
  root.setProperty("--mark", s.accent + (s.theme === "light" ? "73" : "5C"));
}

// Songs that didn't resolve to lyrics (logged by LyricsProvider). Hidden
// when the list is empty. "Copy list" puts it on the clipboard as text,
// handy for pasting into a bug report or a chat.
async function renderMisses() {
  const box = document.getElementById("misses");
  const list = document.getElementById("miss-list");
  const misses = await LyricsProvider.getMissedSongs();
  box.hidden = misses.length === 0;
  document.getElementById("miss-count").textContent = `(${misses.length})`;
  list.innerHTML = "";
  for (const m of misses) {
    const row = el("div", "miss");
    row.appendChild(el("div", "", `${m.title} — ${m.artist || "?"}`));
    const why = m.reason === "error" ? `error: ${m.detail}` : "not found";
    const album = m.album ? ` · album: ${m.album}` : "";
    const tries = m.count > 1 ? ` · ${m.count} tries` : "";
    row.appendChild(el("div", "miss-sub", `${why}${album}${tries} · searched as "${m.searchedAs}"`));
    list.appendChild(row);
  }
}

document.getElementById("miss-copy").addEventListener("click", async (e) => {
  const misses = await LyricsProvider.getMissedSongs();
  const text = misses
    .map((m) => [m.title, m.artist, m.album, m.duration, m.reason, m.count].map((v) => v ?? "").join("\t"))
    .join("\n");
  await navigator.clipboard.writeText("title\tartist\talbum\tduration\treason\ttries\n" + text);
  e.target.textContent = "Copied ✓";
});

document.getElementById("miss-clear").addEventListener("click", async () => {
  await LyricsProvider.clearMissedSongs();
  renderMisses();
});

// Show local data instantly, then sync with the cloud and re-render.
async function init() {
  await applyTheme();
  await render();
  renderMisses();
  const sync = document.getElementById("sync");
  sync.textContent = "Syncing…";
  try {
    const result = await VocabStore.syncNow();
    sync.textContent = result.ok ? "Synced" : "Saved on this device";
    if (result.ok) await render();
  } catch {
    sync.textContent = "Couldn't sync — saved on this device";
  }
}

init();
