// panel.js — the lyrics panel UI injected into the YT Music page.
//
// Rendering only: no fetching, no storage. content.js decides WHAT to show
// and WHEN, and pipes SettingsStore changes into applySettings().
// The panel is draggable (header) and resizable (bottom-right corner, native
// CSS resize); its position/size round-trips through settings.panel.

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
  let syncNudgeHandler = null; // content.js wires this to the per-song offset
  let fitSuggestion = 0; // seconds this version looks padded by (0 = none)
  let currentOffset = 0; // what the sync bar is showing right now
  let lastSettings = null;
  let dragging = null; // {dx, dy} while the header is being dragged
  let suppressResize = false; // ignore ResizeObserver events we caused
  let resizeTimer = 0;

  /* ---- design tokens the settings map onto ---- */

  const THEMES = {
    dark: {
      rgb: "18, 18, 24",
      surface: "#1C1C26",
      text: "#F2F0EB",
      dim: "#8B8B98",
      line: "rgba(255, 255, 255, 0.09)",
      shadow: "0 18px 50px rgba(0, 0, 0, 0.55)",
    },
    light: {
      rgb: "250, 247, 242",
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
  const GAPS = { compact: "9px", cozy: "15px", airy: "22px" };
  const ACCENTS = ["#FFB454", "#FF6EC7", "#4DD8FF", "#A6F750", "#FF5C5C"];

  function bgFor(theme, opacity) {
    const rgb = (THEMES[theme] || THEMES.dark).rgb;
    return `rgba(${rgb}, ${opacity})`;
  }

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
      <div id="lc-sync" hidden>
        <button id="lc-sync-earlier" title="Shift lyrics 0.25s earlier">− earlier</button>
        <button id="lc-sync-value" title="Timing looks right">In sync</button>
        <button id="lc-sync-later" title="Shift lyrics 0.25s later">later +</button>
      </div>
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

    root.querySelector("#lc-sync-earlier").addEventListener("click", () => nudge(-0.25));
    root.querySelector("#lc-sync-later").addEventListener("click", () => nudge(0.25));
    root.querySelector("#lc-sync-value").addEventListener("click", () => {
      // Untouched song with a padded version → offer the alignment.
      // Otherwise the middle button is the "back to zero" control.
      if (fitSuggestion && !currentOffset) nudge({ set: fitSuggestion });
      else nudge(null);
    });

    buildDragAndResize();
  }

  /* ---- sync bar: nudge this song's lyrics earlier or later ---- */

  function nudge(delta) {
    if (syncNudgeHandler) syncNudgeHandler(delta); // null = back to zero
  }

  function showSyncBar(show) {
    ensureBuilt();
    root.querySelector("#lc-sync").hidden = !show;
  }

  // offset: seconds the lyrics are shifted by. hint: why the timing may be
  // off (empty when the match looks trustworthy). fit: seconds this version
  // appears to be padded by, offered as a one-click alignment.
  function setSyncState(offset, hint, fit = 0) {
    ensureBuilt();
    currentOffset = offset;
    fitSuggestion = fit;
    const bar = root.querySelector("#lc-sync");
    const value = root.querySelector("#lc-sync-value");
    if (offset) {
      value.textContent = `${offset > 0 ? "+" : "−"}${Math.abs(offset).toFixed(2)}s`;
      value.title = [hint, "Click to reset the timing"].filter(Boolean).join(" ");
    } else if (fit) {
      value.textContent = `Align +${Math.round(fit)}s`;
      value.title = `${hint} Click to shift the lyrics ${Math.round(fit)}s later, which lines them up when the extra time is an intro.`;
    } else {
      value.textContent = hint ? "check timing" : "In sync";
      value.title = hint || "Timing looks right";
    }
    bar.classList.toggle("warn", !!hint || !!offset);
  }

  /* ---- move & resize, persisted through settings.panel ---- */

  function currentLayout() {
    const r = root.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  }

  function buildDragAndResize() {
    const header = root.querySelector("#lc-header");

    header.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return; // gear/close still clickable
      const r = root.getBoundingClientRect();
      // leave the anchored default: pin to explicit coordinates once
      Object.assign(root.style, {
        left: `${r.left}px`, top: `${r.top}px`,
        width: `${r.width}px`, height: `${r.height}px`,
        right: "auto", bottom: "auto",
      });
      dragging = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      header.setPointerCapture(e.pointerId);
    });

    header.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const x = Math.min(Math.max(0, e.clientX - dragging.dx), window.innerWidth - root.offsetWidth);
      const y = Math.min(Math.max(0, e.clientY - dragging.dy), window.innerHeight - 60);
      root.style.left = `${x}px`;
      root.style.top = `${y}px`;
    });

    header.addEventListener("pointerup", () => {
      if (!dragging) return;
      dragging = null;
      emit({ panel: currentLayout() });
    });

    // The bottom-right corner is a native CSS resize handle; persist the
    // result (debounced) once the user actually has an explicit size.
    // offsetWidth of 0 = the panel was hidden, not resized — never save that.
    new ResizeObserver(() => {
      if (dragging || suppressResize || !root.style.width || !root.offsetWidth) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (root.offsetWidth) emit({ panel: currentLayout() });
      }, 400);
    }).observe(root);
  }

  function applyLayout(p) {
    if (dragging) return;
    suppressResize = true;
    if (p) {
      // clamp back into view in case the screen changed since last time
      const w = Math.max(260, Math.min(p.w, window.innerWidth));
      const h = Math.max(220, Math.min(p.h, window.innerHeight - 40));
      const x = Math.min(Math.max(0, p.x), window.innerWidth - 80);
      const y = Math.min(Math.max(0, p.y), window.innerHeight - 80);
      Object.assign(root.style, {
        left: `${x}px`, top: `${y}px`,
        width: `${w}px`, height: `${h}px`,
        right: "auto", bottom: "auto",
      });
    } else {
      for (const prop of ["left", "top", "width", "height", "right", "bottom"]) {
        root.style.removeProperty(prop);
      }
    }
    setTimeout(() => (suppressResize = false), 150);
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
    lastSettings = s;
    const t = THEMES[s.theme] || THEMES.dark;
    const b = document.body.style;
    b.setProperty("--lc-bg", bgFor(s.theme, s.opacity ?? 0.92));
    b.setProperty("--lc-surface", t.surface);
    b.setProperty("--lc-text", t.text);
    b.setProperty("--lc-dim", t.dim);
    b.setProperty("--lc-line", t.line);
    b.setProperty("--lc-shadow", t.shadow);
    b.setProperty("--lc-accent", s.accent);
    b.setProperty("--lc-accent-glow", s.accent + "59"); // ~35% alpha
    b.setProperty("--lc-font", FONT_STACKS[s.font] || FONT_STACKS.grotesk);
    b.setProperty("--lc-size", SIZES[s.size] || SIZES.m);
    b.setProperty("--lc-gap", GAPS[s.spacing] || GAPS.cozy);
    b.setProperty("--lc-align", s.align === "center" ? "center" : "left");
    b.setProperty("--lc-origin", s.align === "center" ? "center center" : "left center");
    b.setProperty("--lc-hairline-margin", s.align === "center" ? "auto" : "0");

    root.classList.remove("hl-glow", "hl-spotlight", "hl-classic");
    root.classList.add(`hl-${s.highlight in { glow: 1, spotlight: 1, classic: 1 } ? s.highlight : "glow"}`);
    root.classList.toggle("lc-selftest", !!s.blurUpcoming);
    root.classList.toggle("lc-subs", !!s.showTranslations);

    applyLayout(s.panel);
    renderSettings(s);
  }

  /* ---- settings drawer widgets ---- */

  function sectionLabel(text) {
    const el = document.createElement("div");
    el.className = "lc-set-section";
    el.textContent = text;
    return el;
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

  function accentRow(s) {
    const row = segRow("Accent", "accent", ACCENTS.map((c) => [c, ""]), s.accent, (btn, val) => {
      btn.className = "lc-swatch";
      btn.style.background = val;
      btn.classList.toggle("on", val === s.accent);
    });
    // free color picker for accents beyond the presets
    const custom = document.createElement("input");
    custom.type = "color";
    custom.className = "lc-color";
    custom.title = "Custom color";
    custom.value = /^#[0-9a-f]{6}$/i.test(s.accent) ? s.accent : "#FFB454";
    custom.addEventListener("change", () => emit({ accent: custom.value.toUpperCase() }));
    row.querySelector(".lc-seg").appendChild(custom);
    return row;
  }

  function opacityRow(s) {
    const row = document.createElement("div");
    row.className = "lc-set-row";
    const lab = document.createElement("span");
    lab.className = "lc-set-label";
    lab.textContent = "Opacity";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "55";
    slider.max = "100";
    slider.step = "5";
    slider.value = String(Math.round((s.opacity ?? 0.92) * 100));
    // live preview while sliding; persist on release
    slider.addEventListener("input", () => {
      document.body.style.setProperty("--lc-bg", bgFor(lastSettings.theme, Number(slider.value) / 100));
    });
    slider.addEventListener("change", () => emit({ opacity: Number(slider.value) / 100 }));
    row.appendChild(lab);
    row.appendChild(slider);
    return row;
  }

  function layoutRow() {
    const row = document.createElement("div");
    row.className = "lc-set-row";
    const lab = document.createElement("span");
    lab.className = "lc-set-label";
    lab.textContent = "Position & size";
    const btn = document.createElement("button");
    btn.className = "lc-reset";
    btn.textContent = "Reset";
    btn.addEventListener("click", () => emit({ panel: null }));
    row.appendChild(lab);
    row.appendChild(btn);
    return row;
  }

  function renderSettings(s) {
    settingsEl.innerHTML = "";

    settingsEl.appendChild(sectionLabel("Look"));
    settingsEl.appendChild(segRow("Theme", "theme", [["dark", "Dark"], ["light", "Light"]], s.theme));
    settingsEl.appendChild(accentRow(s));
    settingsEl.appendChild(opacityRow(s));

    settingsEl.appendChild(sectionLabel("Type"));
    settingsEl.appendChild(
      segRow(
        "Lyrics font", "font",
        [["grotesk", "Aa"], ["system", "Aa"], ["serif", "Aa"], ["mono", "Aa"]],
        s.font,
        (btn, val) => { btn.style.fontFamily = FONT_STACKS[val]; btn.title = val; }
      )
    );
    settingsEl.appendChild(segRow("Size", "size", [["s", "S"], ["m", "M"], ["l", "L"], ["xl", "XL"]], s.size));
    settingsEl.appendChild(
      segRow("Spacing", "spacing", [["compact", "Compact"], ["cozy", "Cozy"], ["airy", "Airy"]], s.spacing)
    );
    settingsEl.appendChild(segRow("Align", "align", [["left", "Left"], ["center", "Center"]], s.align));

    settingsEl.appendChild(sectionLabel("Karaoke"));
    settingsEl.appendChild(
      segRow("Highlight", "highlight", [["glow", "Glow"], ["spotlight", "Spotlight"], ["classic", "Classic"]], s.highlight)
    );
    settingsEl.appendChild(toggleRow("Spanish under each line", "showTranslations", s.showTranslations));
    settingsEl.appendChild(toggleRow("Blur upcoming lines (self-test)", "blurUpcoming", s.blurUpcoming));

    settingsEl.appendChild(sectionLabel("Layout"));
    settingsEl.appendChild(layoutRow());
    const hint = document.createElement("p");
    hint.className = "lc-set-hint";
    hint.textContent = "Drag the header to move the panel · drag the bottom-right corner to resize.";
    settingsEl.appendChild(hint);
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
    showSyncBar(false);
    const p = document.createElement("p");
    p.className = "lc-message";
    p.textContent = msg;
    linesEl.appendChild(p);
  }

  function showSynced(lines, header) {
    reset(header);
    showSyncBar(true);
    for (const line of lines) {
      const el = buildLine(line.text, false);
      linesEl.appendChild(el);
      lineEls.push(el);
    }
  }

  function showPlain(text, header) {
    reset(`${header} (not synced)`);
    showSyncBar(false);
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

  function onSyncNudge(fn) {
    syncNudgeHandler = fn;
  }

  return {
    showMessage, showSynced, showPlain, setTranslations,
    setActiveLine, setActiveProgress, setOpen, setScrollPaused,
    applySettings, onWordClick, onSettingsChange,
    setSyncState, onSyncNudge,
  };
})();
