// wordPopup.js — the card that appears when you tap a lyric word.
//
// Laid out like a dictionary entry: the word and its pronunciation, the
// Spanish (in the italic serif that marks your language everywhere), then
// part of speech and definition. If the word is already in your list it says
// so instead of offering to save it twice.
// UI only: content.js tells it what word was tapped and in which song;
// lookups go through MeaningProvider, saving through VocabStore, and the card
// sits beside the panel via Panel.placeBeside.

const WordPopup = (() => {
  let el = null;
  let lookupId = 0; // ignore stale lookups when tapping words quickly
  let anchorTop = 0; // where the tapped word is, so the card lines up with it
  let openChangeHandler = null; // content.js uses this to pause panel scroll

  function onOpenChange(fn) {
    openChangeHandler = fn;
  }

  function ensureBuilt() {
    if (el) return;
    el = document.createElement("div");
    el.id = "lc-popup";
    el.hidden = true;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Word details");
    document.body.appendChild(el);

    // Any click that isn't inside the card or on another lyric word closes
    // it. Capture phase = we see the click before the rest of the page.
    document.addEventListener(
      "click",
      (e) => {
        if (el.hidden) return;
        if (el.contains(e.target)) return;
        if (e.target.closest && e.target.closest(".lc-word")) return;
        hide();
      },
      true
    );
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hide();
    });
  }

  function hide() {
    if (!el || el.hidden) return;
    el.hidden = true;
    lookupId++; // cancels any in-flight lookup rendering
    if (openChangeHandler) openChangeHandler(false);
  }

  // Small DOM helper — lyrics and definitions are text from the internet,
  // so they only ever go in through textContent.
  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function place() {
    Panel.placeBeside(el, anchorTop - 18);
  }

  function head(word, phonetic) {
    const h = node("div", "lc-pop-head");
    h.appendChild(node("span", "lc-pop-word", word));
    if (phonetic) h.appendChild(node("span", "lc-pop-phon", phonetic));
    return h;
  }

  // "In your words", plus the song it came from when that's a different one
  function savedNote(text) {
    const note = node("div", "lc-pop-saved");
    note.innerHTML = Panel.icon("check");
    note.append(text);
    return note;
  }

  async function show({ word, line, rect, songTitle, artist }) {
    ensureBuilt();
    const id = ++lookupId;
    anchorTop = rect.top;

    const loading = node("div", "lc-pop-loading");
    loading.setAttribute("role", "status");
    loading.setAttribute("aria-label", "Looking up the word");
    loading.append(node("i"), node("i"), node("i"));
    el.replaceChildren(head(word.toLowerCase()), loading);
    el.hidden = false;
    place();
    if (openChangeHandler) openChangeHandler(true);

    const key = MeaningProvider.normalize(word);
    const [result, existing] = await Promise.all([
      MeaningProvider.lookup(word),
      VocabStore.getAll()
        .then((all) => all.find((e) => e.word === key))
        .catch(() => null),
    ]);
    if (id !== lookupId) return; // card was closed or reused meanwhile

    el.replaceChildren(head(result.word, result.phonetic));
    if (result.translation) el.appendChild(node("div", "lc-pop-trans", result.translation));
    for (const d of result.definitions) {
      const sense = node("div", "lc-pop-sense");
      sense.append(node("div", "lc-pop-pos", d.partOfSpeech), node("div", "lc-pop-def", d.definition));
      el.appendChild(sense);
    }
    if (!result.translation && result.definitions.length === 0) {
      el.appendChild(
        node("div", "lc-pop-status", "No translation or definition found — slang and names often aren't listed. You can still save it.")
      );
    }

    const foot = node("div", "lc-pop-foot");
    if (existing) {
      const from = existing.songTitle && existing.songTitle !== songTitle ? `, saved from ${existing.songTitle}` : "";
      foot.appendChild(savedNote(`In your words${from}`));
    } else {
      const save = node("button", "lc-btn lc-primary");
      save.type = "button";
      save.innerHTML = Panel.icon("save");
      save.append("Save word");
      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          await VocabStore.add({
            word: result.word,
            translation: result.translation || "",
            meaning: result.definitions[0] ? result.definitions[0].definition : "",
            songTitle: songTitle || "",
            artist: artist || "",
            lyricLine: line,
            dateAdded: new Date().toISOString(),
          });
          // the panel hears about it through VocabStore.onChange and sweeps
          // the highlighter mark in across this song
          foot.replaceChildren(savedNote("Saved to your words"));
        } catch (err) {
          save.disabled = false;
          save.lastChild.textContent = "Save failed — try again";
          console.warn("[LyricsCompanion] save failed:", err.message);
        }
      });
      foot.appendChild(save);
    }
    el.appendChild(foot);
    place(); // the card grew; keep it on screen
  }

  return { show, hide, onOpenChange };
})();
