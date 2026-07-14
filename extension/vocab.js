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

// Show local data instantly, then sync with the cloud and re-render.
async function init() {
  await render();
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
