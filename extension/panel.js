// panel.js — the lyrics panel UI injected into the YT Music page.
//
// Rendering only: no fetching, no timing. content.js decides WHAT to show
// and WHEN. Exposes a single global (Panel), like LyricsProvider.

const Panel = (() => {
  let root = null; // the panel container (built lazily on first use)
  let linesEl = null; // the scrollable lyrics area
  let titleEl = null;
  let toggleBtn = null; // floating 🎵 button shown while the panel is closed
  let lineEls = []; // one <p> per synced lyric line
  let activeIdx = -1;
  let userScrollUntil = 0; // pause auto-centering while Robi browses lyrics
  let scrollPaused = false; // pause auto-centering while the word popup is open
  let wordClickHandler = null; // content.js wires this to the word popup

  function ensureBuilt() {
    if (root) return;

    root = document.createElement("div");
    root.id = "lc-panel";
    root.innerHTML = `
      <div id="lc-header">
        <span id="lc-title">Lyrics</span>
        <button id="lc-close" title="Hide lyrics">✕</button>
      </div>
      <div id="lc-lines"></div>`;
    document.body.appendChild(root);
    linesEl = root.querySelector("#lc-lines");
    titleEl = root.querySelector("#lc-title");
    root.querySelector("#lc-close").addEventListener("click", () => setOpen(false));

    toggleBtn = document.createElement("button");
    toggleBtn.id = "lc-toggle";
    toggleBtn.textContent = "🎵";
    toggleBtn.title = "Show lyrics";
    toggleBtn.style.display = "none"; // panel starts open
    toggleBtn.addEventListener("click", () => setOpen(true));
    document.body.appendChild(toggleBtn);

    // Wheel/touch inside the panel = the user is reading somewhere else in
    // the song; stop yanking the scroll position for a few seconds.
    for (const ev of ["wheel", "touchmove"]) {
      linesEl.addEventListener(ev, () => (userScrollUntil = Date.now() + 4000), {
        passive: true,
      });
    }

    // One listener for every word (event delegation) instead of one per span.
    linesEl.addEventListener("click", (e) => {
      const span = e.target.closest ? e.target.closest(".lc-word") : null;
      if (span && wordClickHandler) {
        wordClickHandler({
          word: span.textContent,
          line: span.closest("p").textContent,
          rect: span.getBoundingClientRect(),
        });
      }
    });
  }

  // Split a lyric line into tappable word spans; spaces and punctuation stay
  // as plain text. Includes apostrophes so "don't" and "gettin'" are one word.
  const WORD_RE = /([A-Za-zÀ-ÖØ-öø-ÿ'’]+)/;
  function renderLine(p, text) {
    for (const token of text.split(WORD_RE)) {
      if (!token) continue;
      if (/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(token)) {
        const span = document.createElement("span");
        span.className = "lc-word";
        span.textContent = token;
        p.appendChild(span);
      } else {
        p.appendChild(document.createTextNode(token));
      }
    }
  }

  function setOpen(open) {
    ensureBuilt();
    root.style.display = open ? "" : "none";
    toggleBtn.style.display = open ? "none" : "";
  }

  function reset(header) {
    ensureBuilt();
    titleEl.textContent = header;
    titleEl.title = header; // long names get cut with "…" — hover shows all
    lineEls = [];
    activeIdx = -1;
    linesEl.innerHTML = "";
    linesEl.scrollTop = 0;
  }

  // Status text: "Searching…", "No lyrics found", "Instrumental"...
  function showMessage(msg, header = "Lyrics") {
    reset(header);
    const p = document.createElement("p");
    p.className = "lc-message";
    p.textContent = msg;
    linesEl.appendChild(p);
  }

  // Small credit line under the lyrics: where they came from. Handy when
  // lyrics look wrong, and fair to the people who license them.
  function appendSource(source) {
    if (!source) return;
    const p = document.createElement("p");
    p.className = "lc-source";
    p.textContent = `Lyrics via ${source}`;
    linesEl.appendChild(p);
  }

  function showSynced(lines, header, source) {
    reset(header);
    for (const line of lines) {
      const p = document.createElement("p");
      p.className = "lc-line";
      if (line.text) renderLine(p, line.text);
      else p.textContent = "♪"; // empty LRC lines = instrumental gaps
      linesEl.appendChild(p);
      lineEls.push(p);
    }
    appendSource(source);
  }

  // Unsynced lyrics (LRCLIB plain text, or YouTube Music's Lyrics tab):
  // no highlight or auto-scroll, but every word is still tappable — same
  // renderLine() as synced lines, so word capture works identically.
  function showPlain(text, header, source) {
    reset(`${header} (not synced)`);
    for (const row of text.split("\n")) {
      const p = document.createElement("p");
      p.className = "lc-line lc-static";
      if (row) renderLine(p, row);
      else p.textContent = " "; // keep blank lines as visual gaps
      linesEl.appendChild(p);
    }
  }

  function setActiveLine(idx) {
    if (idx === activeIdx || lineEls.length === 0) return;
    if (lineEls[activeIdx]) lineEls[activeIdx].classList.remove("active");
    activeIdx = idx;
    const el = lineEls[idx];
    if (!el) return; // idx -1: before the first line

    el.classList.add("active");
    if (scrollPaused || Date.now() < userScrollUntil) return;
    // Center manually instead of scrollIntoView — that one can also scroll
    // the page behind the panel. offsetTop is relative to #lc-lines because
    // the CSS gives it position: relative.
    linesEl.scrollTo({
      top: el.offsetTop - linesEl.clientHeight / 2 + el.clientHeight / 2,
      behavior: "smooth",
    });
  }

  // While the word popup is open, the highlight keeps moving but the panel
  // stops auto-scrolling (the tapped word must stay under the popup).
  function setScrollPaused(paused) {
    scrollPaused = paused;
  }

  function onWordClick(fn) {
    wordClickHandler = fn;
  }

  return { showMessage, showSynced, showPlain, setActiveLine, setOpen, setScrollPaused, onWordClick };
})();
