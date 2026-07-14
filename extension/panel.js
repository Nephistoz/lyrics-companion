// panel.js — the lyrics panel UI injected into the YT Music page.
//
// Rendering only: no fetching, no storage. content.js decides WHAT to show
// and WHEN, and pipes SettingsStore changes into applySettings().

const Panel = (() => {
  let root = null; // the panel container (built lazily on first use)
  let linesEl = null; // the scrollable lyrics area
  let titleEl = null;
  let settingsEl = null; // the settings drawer (covers the lyrics area)
  let gearBtn = null;
  let toggleBtn = null; // floating 🎵 button shown while the panel is closed
  let lineEls = []; // one .lc-line container per lyric line
  let activeIdx = -1;
  let userScrollUntil = 0; // pause auto-centering while Robi browses lyrics
  let scrollPaused = false; // pause auto-centering while the word popup is open
  let wordClickHandler = null; // content.js wires this to the word popup
  let settingsChangeHandler = null; // content.js wires this to SettingsStore

  /* ---- design tokens the settings map onto ---- */

  const THEMES = {
    dark: {
      bg: "rgba(18, 18, 24, 0.92)",
      surface: "#1C1C26",
      text: "#F2F0EB",
      dim: "#8B8B98",
      line: "rgba(255, 255, 255, 0.09)",
      shadow: "0 18px 50px rgba(0, 0, 0, 0.55)",
    },
    light: {
      bg: "rgba(250, 247, 242, 0.94)",
      surface: "#FFFFFF",
      text: "#17171D",
      dim: "#6E6E78",
      line: "rgba(23, 23, 29, 0.10)",
      shadow: "0 18px 50px rgba(40, 35, 25, 0.20)",
    },
  };

  const FONT_STACKS = {
    grotesk: '"Space Grotesk", "Segoe UI", system-ui, sans-serif',
    system: 'system-ui, "Segoe UI", Roboto, sans-serif',
    serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
    mono: '"Cascadia Code", Consolas, "Courier New", monospace',
  };

  const SIZES = { s: "15px", m: "17px", l: "19px", xl: "22px" };

  const ACCENTS = ["#FFB454", "#FF6EC7", "#4DD8FF", "#A6F750", "#FF5C5C"];

  /* ---- build ---- */

  function ensureBuilt() {
    if (root) return;

    root = document.createElement("div");
    root.id = "lc-panel";
    root.innerHTML = `
      <div id="lc-header">
        <span id="lc-title">Lyrics</span>
        <button id="lc-gear" title="Display settings">⚙</button>
        <button id="lc-close" title="Hide lyrics">✕</button>
      </div>
      <div id="lc-lines"></div>
      <div id="lc-settings" hidden></div>`;
    document.body.appendChild(root);
    linesEl = root.querySelector("#lc-lines");
    titleEl = root.querySelector("#lc-title");
    settingsEl = root.querySelector("#lc-settings");
    gearBtn = root.querySelector("#lc-gear");
    root.querySelector("#lc-close").addEventListener("click", () => setOpen(false));
    gearBtn.addEventListener("click", () => {
      settingsEl.hidden = !settingsEl.hidden;
      gearBtn.classList.toggle("open", !settingsEl.hidden);
    });

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

  /* ---- settings ---- */

  function emit(patch) {
    if (settingsChangeHandler) settingsChangeHandler(patch);
  }

  // Everything visual flows through CSS variables set on <body>; the word
  // popup and the floating button inherit them too. lc- prefixes keep us
  // out of YouTube's way.
  function applySettings(s) {
    ensureBuilt();
    const t = THEMES[s.theme] || THEMES.dark;
    const b = document.body.style;
    b.setProperty("--lc-bg", t.bg);
    b.setProperty("--lc-surface", t.surface);
    b.setProperty("--lc-text", t.text);
    b.setProperty("--lc-dim", t.dim);
    b.setProperty("--lc-line", t.line);
    b.setProperty("--lc-shadow", t.shadow);
    b.setProperty("--lc-accent", s.accent);
    b.setProperty("--lc-accent-glow", s.accent + "59"); // ~35% alpha
    b.setProperty("--lc-font", FONT_STACKS[s.font] || FONT_STACKS.grotesk);
    b.setProperty("--lc-size", SIZES[s.size] || SIZES.m);

    root.classList.remove("hl-glow", "hl-spotlight", "hl-classic");
    root.classList.add(`hl-${s.highlight in { glow: 1, spotlight: 1, classic: 1 } ? s.highlight : "glow"}`);
    root.classList.toggle("lc-selftest", !!s.blurUpcoming);
    root.classList.toggle("lc-subs", !!s.showTranslations);

    renderSettings(s);
  }

  function segRow(label, key, options, current, styler) {
    const row = document.createElement("div");
    row.className = "lc-set-row";
    const lab = document.createElement("span");
    lab.className = "lc-set-label";
    lab.textContent = label;
    row.appendChild(lab);
    const group = document.createElement("div");
    group.className = "lc-seg";
    for (const [value, text] of options) {
      const btn = document.createElement("button");
      btn.textContent = text;
      btn.classList.toggle("on", value === current);
      if (styler) styler(btn, value);
      btn.addEventListener("click", () => emit({ [key]: value }));
      group.appendChild(btn);
    }
    row.appendChild(group);
    return row;
  }

  function toggleRow(label, key, current) {
    const row = document.createElement("label");
    row.className = "lc-set-row lc-set-toggle";
    const lab = document.createElement("span");
    lab.className = "lc-set-label";
    lab.textContent = label;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !!current;
    box.addEventListener("change", () => emit({ [key]: box.checked }));
    row.appendChild(lab);
    row.appendChild(box);
    return row;
  }

  function renderSettings(s) {
    settingsEl.innerHTML = "";
    settingsEl.appendChild(
      segRow("Theme", "theme", [["dark", "Dark"], ["light", "Light"]], s.theme)
    );
    settingsEl.appendChild(
      segRow("Accent", "accent", ACCENTS.map((c) => [c, ""]), s.accent, (btn, val) => {
        btn.className = "lc-swatch";
        btn.style.background = val;
        btn.classList.toggle("on", val === s.accent);
      })
    );
    settingsEl.appendChild(
      segRow(
        "Lyrics font", "font",
        [["grotesk", "Aa"], ["system", "Aa"], ["serif", "Aa"], ["mono", "Aa"]],
        s.font,
        (btn, val) => { btn.style.fontFamily = FONT_STACKS[val]; btn.title = val; }
      )
    );
    settingsEl.appendChild(
      segRow("Size", "size", [["s", "S"], ["m", "M"], ["l", "L"], ["xl", "XL"]], s.size)
    );
    settingsEl.appendChild(
      segRow(
        "Highlight", "highlight",
        [["glow", "Glow"], ["spotlight", "Spotlight"], ["classic", "Classic"]],
        s.highlight
      )
    );
    settingsEl.appendChild(toggleRow("Spanish under each line", "showTranslations", s.showTranslations));
    settingsEl.appendChild(toggleRow("Blur upcoming lines (self-test)", "blurUpcoming", s.blurUpcoming));
  }

  /* ---- lyrics rendering ---- */

  // Split a lyric line into tappable word spans; spaces and punctuation stay
  // as plain text. Includes apostrophes so "don't" and "gettin'" are one word.
  const WORD_RE = /([A-Za-zÀ-ÖØ-öø-ÿ'’]+)/;
  function renderWords(p, text) {
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

  // Each line is a container: main text (tappable) + an optional Spanish
  // sub-line filled in later by setTranslations().
  function buildLine(text, isStatic) {
    const container = document.createElement("div");
    container.className = "lc-line" + (isStatic ? " lc-static" : "");
    const main = document.createElement("p");
    main.className = "lc-main";
    if (text) renderWords(main, text);
    else main.textContent = "♪"; // empty LRC lines = instrumental gaps
    container.appendChild(main);
    const sub = document.createElement("div");
    sub.className = "lc-sub";
    container.appendChild(sub);
    return container;
  }

  function setOpen(open) {
    ensureBuilt();
    root.style.display = open ? "" : "none";
    toggleBtn.style.display = open ? "none" : "";
  }

  function reset(header) {
    ensureBuilt();
    titleEl.textContent = header;
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

  function showSynced(lines, header) {
    reset(header);
    for (const line of lines) {
      const el = buildLine(line.text, false);
      linesEl.appendChild(el);
      lineEls.push(el);
    }
  }

  function showPlain(text, header) {
    reset(`${header} (not synced)`);
    for (const row of text.split("\n")) {
      linesEl.appendChild(buildLine(row, true));
    }
  }

  // Spanish sub-lines, same order and length as the synced lines array.
  function setTranslations(texts) {
    lineEls.forEach((el, i) => {
      el.querySelector(".lc-sub").textContent = texts[i] || "";
    });
  }

  /* ---- playback-driven state ---- */

  function setActiveLine(idx) {
    if (idx === activeIdx || lineEls.length === 0) return;
    const prev = lineEls[activeIdx];
    if (prev) {
      prev.classList.remove("active");
      prev.style.removeProperty("--lc-progress");
    }
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

  // How far into the ACTIVE line playback is (0..1). Drives the hairline
  // that fills under the current line — our signature detail.
  function setActiveProgress(fraction) {
    const el = lineEls[activeIdx];
    if (el) el.style.setProperty("--lc-progress", `${(fraction * 100).toFixed(1)}%`);
  }

  /* ---- wiring ---- */

  function setScrollPaused(paused) {
    scrollPaused = paused;
  }

  function onWordClick(fn) {
    wordClickHandler = fn;
  }

  function onSettingsChange(fn) {
    settingsChangeHandler = fn;
  }

  return {
    showMessage, showSynced, showPlain, setTranslations,
    setActiveLine, setActiveProgress, setOpen, setScrollPaused,
    applySettings, onWordClick, onSettingsChange,
  };
})();
