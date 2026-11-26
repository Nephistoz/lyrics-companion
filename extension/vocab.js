// vocab.js — renders the saved-words list in vocab.html.
//
// Everything is built with createElement + textContent (never innerHTML with
// data in it): lyrics and definitions are text from the internet, and this
// keeps them from ever being interpreted as HTML.

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function render() {
  const list = document.getElementById("list");
  const count = document.getElementById("count");
  const entries = await VocabStore.getAll();

  count.textContent = entries.length ? `(${entries.length})` : "";
  list.innerHTML = "";

  if (entries.length === 0) {
    list.appendChild(
      el("div", "empty", "Nothing saved yet. Play a song on YouTube Music and tap any word in the lyrics panel to save it here. 🎵")
    );
    return;
  }

  for (const e of entries) {
    const entry = el("div", "entry");

    const top = el("div", "top");
    top.appendChild(el("span", "word", e.word));
    top.appendChild(el("span", "trans", e.translation || ""));
    const del = el("button", "del", "✕");
    del.title = "Delete word";
    del.addEventListener("click", async () => {
      await VocabStore.remove(e.id);
      render();
    });
    top.appendChild(del);
    entry.appendChild(top);

    if (e.meaning) entry.appendChild(el("div", "def", e.meaning));
    if (e.lyricLine) entry.appendChild(el("div", "context", `“${e.lyricLine}”`));

    const when = e.dateAdded ? new Date(e.dateAdded).toLocaleDateString() : "";
    entry.appendChild(el("div", "song", `${e.songTitle} — ${e.artist} · ${when}`));

    list.appendChild(entry);
  }
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
  await render();
  renderMisses();
  const sync = document.getElementById("sync");
  sync.textContent = "syncing…";
  try {
    const result = await VocabStore.syncNow();
    sync.textContent = result.ok ? "✓ synced" : "local only";
    if (result.ok) await render();
  } catch {
    sync.textContent = "sync failed (offline?)";
  }
}

init();
