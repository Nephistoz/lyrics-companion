// wordPopup.js — the little card that appears when you tap a lyric word.
//
// Shows the Spanish translation + English definition and a Save button.
// UI only: content.js tells it what word was tapped and in which song;
// lookups go through MeaningProvider, saving through VocabStore.

const WordPopup = (() => {
  let el = null;
  let lookupId = 0; // ignore stale lookups when tapping words quickly
  let openChangeHandler = null; // content.js uses this to pause panel scroll

  function onOpenChange(fn) {
    openChangeHandler = fn;
  }

  function ensureBuilt() {
    if (el) return;
    el = document.createElement("div");
    el.id = "lc-popup";
    el.style.display = "none";
    document.body.appendChild(el);

    // Any click that isn't inside the popup or on another lyric word closes
    // it. Capture phase = we see the click before the rest of the page.
    document.addEventListener(
      "click",
      (e) => {
        if (el.style.display === "none") return;
        if (el.contains(e.target)) return;
        if (e.target.closest && e.target.closest(".lc-word")) return;
        hide();
      },
      true
    );
  }

  function hide() {
    if (!el || el.style.display === "none") return;
    el.style.display = "none";
    lookupId++; // cancels any in-flight lookup rendering
    if (openChangeHandler) openChangeHandler(false);
  }

  // Small helpers to build DOM safely (lyrics are untrusted text — always
  // textContent, never innerHTML with data in it).
  function row(className, text) {
    const div = document.createElement("div");
    div.className = className;
    div.textContent = text;
    return div;
  }

  function position(rect) {
    // The panel hugs the right edge, so try to put the popup to the LEFT of
    // the tapped word; clamp so it never leaves the screen.
    const W = 300;
    const left = Math.max(8, Math.min(rect.left - W - 12, window.innerWidth - W - 8));
    const top = Math.max(8, Math.min(rect.top - 8, window.innerHeight - 280));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  async function show({ word, line, rect, songTitle, artist }) {
    ensureBuilt();
    const id = ++lookupId;
    position(rect);
    el.style.display = "";
    if (openChangeHandler) openChangeHandler(true);

    el.innerHTML = "";
    el.appendChild(row("lc-pop-word", word));
    el.appendChild(row("lc-pop-status", "Looking it up…"));

    const result = await MeaningProvider.lookup(word);
    if (id !== lookupId) return; // popup was closed or reused meanwhile

    el.innerHTML = "";
    const header = row("lc-pop-word", result.word);
    if (result.phonetic) header.appendChild(row("lc-pop-phon", result.phonetic));
    el.appendChild(header);

    if (result.translation) {
      el.appendChild(row("lc-pop-trans", result.translation));
    }
    for (const d of result.definitions) {
      const def = row("lc-pop-def", d.definition);
      def.prepend(row("lc-pop-pos", d.partOfSpeech));
      el.appendChild(def);
    }
    if (!result.translation && result.definitions.length === 0) {
      el.appendChild(row("lc-pop-status", "Nothing found for this one 🤷 — you can still save it."));
    }

    const save = document.createElement("button");
    save.id = "lc-pop-save";
    save.textContent = "★ Save word";
    save.addEventListener("click", async () => {
      save.disabled = true;
      save.textContent = "Saving…";
      await VocabStore.add({
        word: result.word,
        translation: result.translation || "",
        meaning: result.definitions[0] ? result.definitions[0].definition : "",
        songTitle: songTitle || "",
        artist: artist || "",
        lyricLine: line,
        dateAdded: new Date().toISOString(),
      });
      save.textContent = "✓ Saved";
    });
    el.appendChild(save);
  }

  return { show, hide, onOpenChange };
})();
