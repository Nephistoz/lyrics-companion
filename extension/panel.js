// panel.js — the lyrics panel UI injected into the YT Music page.
//
// Rendering only: no fetching, no storage. content.js decides WHAT to show
// and WHEN, and pipes SettingsStore changes into applySettings().
// The panel is draggable (header) and resizable (bottom-right corner, native
// CSS resize); its position/size round-trips through settings.panel.
// Display settings and the word card open BESIDE the panel (placeBeside), so
// every change previews live on lyrics that stay in view.

const Panel = (() => {
  let root = null; // the panel container (built lazily on first use)
  let linesEl = null; // the scrollable lyrics area
  let titleEl = null;
  let artistEl = null;
  let artEl = null;
  let settingsEl = null; // the display settings popover (lives in <body>)
  let gearBtn = null;
  let toggleBtn = null; // pill shown while the panel is hidden
  let lineEls = []; // one .lc-line container per lyric line
  let activeIdx = -1;
  let userScrollUntil = 0; // pause auto-centering while Robi browses lyrics
  let scrollPaused = false; // pause auto-centering while the word card is open
  let savedWords = new Set(); // normalized words in the vocabulary list
  let savedLoaded = false; // the first list arrives quietly; later saves sweep in
  let wordClickHandler = null; // content.js wires this to the word card
  let settingsChangeHandler = null; // content.js wires this to SettingsStore
  let syncNudgeHandler = null; // content.js wires this to the per-song offset
  let retryHandler = null; // content.js wires this to a fresh lyrics fetch
  let fitSuggestion = 0; // seconds this version looks padded by (0 = none)
  let currentOffset = 0; // what the timing control is showing right now
  let lastSettings = null;
  let dragging = null; // {dx, dy} while the header is being dragged
  let suppressResize = false; // ignore ResizeObserver events we caused
  let resizeTimer = 0;

  /* ---- design tokens the settings map onto ---- */

  const THEMES = {
    dark: {
      rgb: "26, 23, 34", // Night #1A1722, at the user's opacity
      raised: "#231F2D",
      chip: "#3A3447",
      ink: "#F5F2FA",
      haze: "#A39DB2",
      rule: "rgba(245, 242, 250, 0.09)",
      ruleStrong: "rgba(245, 242, 250, 0.17)",
      shadow: "0 24px 60px -12px rgba(0, 0, 0, 0.65), 0 2px 10px rgba(0, 0, 0, 0.3)",
    },
    light: {
      rgb: "248, 246, 251",
      raised: "#FFFFFF",
      chip: "#FFFFFF",
      ink: "#1D1926",
      haze: "#6B6478",
      rule: "rgba(29, 25, 38, 0.08)",
      ruleStrong: "rgba(29, 25, 38, 0.16)",
      shadow: "0 24px 60px -16px rgba(40, 30, 60, 0.3), 0 2px 8px rgba(40, 30, 60, 0.08)",
    },
  };

  const UI_FONT = '"LC Bricolage", "Segoe UI", system-ui, sans-serif';
  const ES_FONT = '"LC Literata", Georgia, "Times New Roman", serif';
  const FONT_STACKS = {
    grotesk: UI_FONT, // key kept from v1 so saved settings still resolve
    system: 'system-ui, "Segoe UI", Roboto, sans-serif',
    serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
    mono: '"Cascadia Code", Consolas, "Courier New", monospace',
  };
  const FONT_NAMES = { grotesk: "Bricolage", system: "System", serif: "Serif", mono: "Mono" };
  const SIZES = { s: "16px", m: "19px", l: "22px", xl: "26px" };
  const GAPS = { compact: "10px", cozy: "18px", airy: "28px" };
  const ACCENTS = [
    ["#FFB454", "Amber"],
    ["#FF6EC7", "Pink"],
    ["#4DD8FF", "Sky"],
    ["#A6F750", "Lime"],
    ["#FF5C5C", "Coral"],
  ];

  // Icons are fixed strings we wrote, never data, so innerHTML is safe here.
  const ICONS = {
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    earlier: '<path d="M14.5 6l-6 6 6 6"/>',
    later: '<path d="M9.5 6l6 6-6 6"/>',
    note: '<path d="M9 18V6.5l10-2.5v11.5"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>',
    save: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-4-6 4V5.5a1 1 0 0 1 1-1z"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    retry: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4 4.5v4h4"/>',
  };

  function icon(name) {
    return `<svg class="lc-svg" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  }

  function bgFor(theme, opacity) {
    const rgb = (THEMES[theme] || THEMES.dark).rgb;
    return `rgba(${rgb}, ${opacity})`;
  }

  // Text on an accent-filled button: whichever of ink or white reads better
  // against it (WCAG contrast), so any custom accent stays legible.
  function onAccent(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lin = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    const vsWhite = 1.05 / (L + 0.05);
    const vsInk = (L + 0.05) / 0.0595; // luminance of Night #1A1722 + 0.05
    return vsInk >= vsWhite ? "#1A1722" : "#FFFFFF";
  }

  // Small DOM helper — all data goes in through textContent, never innerHTML.
  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function button(className, label) {
    const b = node("button", `lc-btn ${className}`);
    b.type = "button";
    if (label) {
      b.setAttribute("aria-label", label);
      b.title = label;
    }
    return b;
  }

  /* ---- build ---- */

  function ensureBuilt() {
    if (root) return;

    root = document.createElement("div");
    root.id = "lc-panel";
    root.innerHTML = `
      <div id="lc-header">
        <img id="lc-art" alt="" draggable="false" hidden>
        <div id="lc-track"><div id="lc-title">Lyrics</div><div id="lc-artist"></div></div>
        <button type="button" class="lc-btn lc-icon" id="lc-gear" aria-label="Display settings" title="Display settings" aria-expanded="false">${icon("sliders")}</button>
        <button type="button" class="lc-btn lc-icon" id="lc-close" aria-label="Hide lyrics" title="Hide lyrics">${icon("close")}</button>
      </div>
      <div id="lc-lines"></div>
      <div id="lc-foot" hidden>
        <div id="lc-drift" hidden>
          <p id="lc-drift-text"></p>
          <button type="button" class="lc-btn lc-primary" id="lc-align" hidden></button>
        </div>
        <div id="lc-timing">
          <span id="lc-timing-label">Timing</span>
          <div class="lc-stepper">
            <button type="button" class="lc-btn lc-step" id="lc-earlier" aria-label="Show lyrics 0.25 seconds earlier" title="Earlier">${icon("earlier")}</button>
            <button type="button" class="lc-btn" id="lc-offset" disabled>0.0s</button>
            <button type="button" class="lc-btn lc-step" id="lc-later" aria-label="Show lyrics 0.25 seconds later" title="Later">${icon("later")}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);
    linesEl = root.querySelector("#lc-lines");
    titleEl = root.querySelector("#lc-title");
    artistEl = root.querySelector("#lc-artist");
    artEl = root.querySelector("#lc-art");
    gearBtn = root.querySelector("#lc-gear");
    artEl.addEventListener("error", () => (artEl.hidden = true));
    root.querySelector("#lc-close").addEventListener("click", () => setOpen(false));
    gearBtn.addEventListener("click", () => setSettingsOpen(settingsEl.hidden));

    settingsEl = document.createElement("div");
    settingsEl.id = "lc-settings";
    settingsEl.hidden = true;
    settingsEl.setAttribute("role", "dialog");
    settingsEl.setAttribute("aria-label", "Display settings");
    document.body.appendChild(settingsEl);

    toggleBtn = button("", "Show lyrics");
    toggleBtn.id = "lc-toggle";
    toggleBtn.innerHTML = `${icon("note")}<span>Lyrics</span>`;
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
          line: span.closest(".lc-main").textContent,
          rect: span.getBoundingClientRect(),
        });
      }
    });

    root.querySelector("#lc-earlier").addEventListener("click", () => nudge(-0.25));
    root.querySelector("#lc-later").addEventListener("click", () => nudge(0.25));
    root.querySelector("#lc-offset").addEventListener("click", () => {
      if (currentOffset) nudge(null); // back to the song's own timing
    });
    root.querySelector("#lc-align").addEventListener("click", () => nudge({ set: fitSuggestion }));

    // Settings close on Escape, or on a click outside both it and the panel
    // (clicks on the lyrics keep it open: that's where you watch changes land).
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !settingsEl.hidden) setSettingsOpen(false);
    });
    document.addEventListener(
      "click",
      (e) => {
        if (settingsEl.hidden) return;
        if (settingsEl.contains(e.target) || root.contains(e.target)) return;
        setSettingsOpen(false);
      },
      true
    );
    window.addEventListener("resize", () => {
      if (!settingsEl.hidden) placeBeside(settingsEl, root.getBoundingClientRect().top);
    });

    buildDragAndResize();
  }

  // Put a popover next to the panel: left of it if there's room (the panel
  // usually hugs the right edge), else right of it, else over it. Vertically
  // it starts at anchorTop and is kept on screen.
  function placeBeside(el, anchorTop) {
    const pr = root.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 12;
    const margin = 8;
    let left;
    if (pr.left - gap - w >= margin) left = pr.left - gap - w;
    else if (pr.right + gap + w <= window.innerWidth - margin) left = pr.right + gap;
    else left = Math.min(Math.max(margin, pr.left + (pr.width - w) / 2), window.innerWidth - w - margin);
    const top = Math.min(Math.max(margin, anchorTop), window.innerHeight - h - margin);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  /* ---- timing: nudge this song's lyrics earlier or later ---- */

  function nudge(change) {
    if (syncNudgeHandler) syncNudgeHandler(change); // number, null (reset) or {set}
  }

  function showFoot(show) {
    root.querySelector("#lc-foot").hidden = !show;
  }

  // offset: seconds the lyrics are shifted by. hint: why the timing may be
  // off (empty when the match looks trustworthy). fit: seconds this version
  // appears to be padded by, offered as a one-click shift.
  function setSyncState(offset, hint, fit = 0) {
    ensureBuilt();
    currentOffset = offset;
    fitSuggestion = fit;
    const value = root.querySelector("#lc-offset");
    value.textContent = offset ? `${offset > 0 ? "+" : "−"}${Math.abs(offset).toFixed(2)}s` : "0.0s";
    value.disabled = !offset;
    value.classList.toggle("lc-shifted", !!offset);
    value.title = offset ? "Reset timing" : "Lyrics follow the song as timed";

    // The mismatch notice stays until you act on it with the timing control.
    root.querySelector("#lc-drift").hidden = !hint || !!offset;
    root.querySelector("#lc-drift-text").textContent = hint || "";
    const align = root.querySelector("#lc-align");
    align.hidden = !fit;
    align.textContent = fit ? `Shift lyrics +${Math.round(fit)}s` : "";
  }

  /* ---- move & resize, persisted through settings.panel ---- */

  function currentLayout() {
    const r = root.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  }

  function buildDragAndResize() {
    const header = root.querySelector("#lc-header");

    header.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return; // header buttons stay clickable
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
      if (!settingsEl.hidden) placeBeside(settingsEl, root.getBoundingClientRect().top);
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
      const w = Math.max(280, Math.min(p.w, window.innerWidth));
      const h = Math.max(240, Math.min(p.h, window.innerHeight - 40));
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
  // card, the settings and the collapsed pill inherit them too.
  function applySettings(s) {
    ensureBuilt();
    lastSettings = s;
    const t = THEMES[s.theme] || THEMES.dark;
    const accent = /^#[0-9a-f]{6}$/i.test(s.accent) ? s.accent : ACCENTS[0][0];
    const vars = {
      "--lc-bg": bgFor(s.theme, s.opacity ?? 0.92),
      "--lc-raised": t.raised,
      "--lc-chip": t.chip,
      "--lc-ink": t.ink,
      "--lc-haze": t.haze,
      "--lc-rule": t.rule,
      "--lc-rule-strong": t.ruleStrong,
      "--lc-shadow": t.shadow,
      "--lc-accent": accent,
      "--lc-accent-soft": accent + "59", // ~35% alpha: the Glow halo
      "--lc-mark": accent + (s.theme === "light" ? "73" : "5C"), // highlighter ink
      "--lc-mark-faint": accent + "2E",
      "--lc-on-accent": onAccent(accent),
      "--lc-ui": UI_FONT,
      "--lc-es": ES_FONT,
      "--lc-font": FONT_STACKS[s.font] || FONT_STACKS.grotesk,
      "--lc-size": SIZES[s.size] || SIZES.m,
      "--lc-gap": GAPS[s.spacing] || GAPS.cozy,
      "--lc-align": s.align === "center" ? "center" : "left",
      "--lc-origin": s.align === "center" ? "center center" : "left center",
      "--lc-hairline-margin": s.align === "center" ? "auto" : "0",
    };
    for (const [k, v] of Object.entries(vars)) document.body.style.setProperty(k, v);

    root.classList.remove("hl-glow", "hl-spotlight", "hl-classic");
    root.classList.add(`hl-${s.highlight in { glow: 1, spotlight: 1, classic: 1 } ? s.highlight : "glow"}`);
    root.classList.toggle("lc-selftest", !!s.blurUpcoming);
    root.classList.toggle("lc-subs", !!s.showTranslations);

    applyLayout(s.panel);
    if (!settingsEl.hidden) renderSettings(s);
  }

  function setSettingsOpen(open) {
    ensureBuilt();
    settingsEl.hidden = !open;
    gearBtn.setAttribute("aria-expanded", String(open));
    if (!open) return;
    renderSettings(lastSettings || {});
    placeBeside(settingsEl, root.getBoundingClientRect().top);
  }

  /* ---- settings widgets ---- */

  function sectionHeading(text) {
    return node("h3", "lc-set-h", text);
  }

  function labelled(label, control, desc) {
    const row = node("div", "lc-set-row");
    const lab = node("span", "lc-set-label", label);
    if (desc) lab.appendChild(node("span", "lc-set-desc", desc));
    row.append(lab, control);
    return row;
  }

  function segmented(key, options, current, styler) {
    const group = node("div", "lc-seg");
    group.setAttribute("role", "group");
    for (const [value, text] of options) {
      const b = button("lc-seg-btn");
      b.textContent = text;
      b.classList.toggle("on", value === current);
      b.setAttribute("aria-pressed", String(value === current));
      if (styler) styler(b, value);
      b.addEventListener("click", () => emit({ [key]: value }));
      group.appendChild(b);
    }
    return group;
  }

  function switchRow(label, key, current, desc) {
    // a <label> wrapper makes the whole row toggle the switch
    const row = node("label", "lc-set-row");
    const lab = node("span", "lc-set-label", label);
    if (desc) lab.appendChild(node("span", "lc-set-desc", desc));
    const box = node("input", "lc-switch");
    box.type = "checkbox";
    box.setAttribute("role", "switch");
    box.checked = !!current;
    box.addEventListener("change", () => emit({ [key]: box.checked }));
    row.append(lab, box);
    return row;
  }

  function accentPicker(s) {
    const wrap = node("div", "lc-swatches");
    const current = (s.accent || "").toUpperCase();
    let isPreset = false;
    for (const [hex, name] of ACCENTS) {
      const b = button("lc-swatch", `${name} accent`);
      b.style.background = hex;
      const on = hex === current;
      isPreset = isPreset || on;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      b.addEventListener("click", () => emit({ accent: hex }));
      wrap.appendChild(b);
    }
    // any color at all, behind a rainbow ring
    const custom = node("label", "lc-custom");
    custom.title = "Pick any color";
    custom.classList.toggle("on", !isPreset);
    const input = node("input");
    input.type = "color";
    input.setAttribute("aria-label", "Custom accent color");
    input.value = /^#[0-9a-f]{6}$/i.test(s.accent || "") ? s.accent : ACCENTS[0][0];
    input.addEventListener("change", () => emit({ accent: input.value.toUpperCase() }));
    custom.appendChild(input);
    wrap.appendChild(custom);
    return wrap;
  }

  function opacityControl(s) {
    const wrap = node("div", "lc-swatches");
    const value = Math.round((s.opacity ?? 0.92) * 100);
    const slider = node("input", "lc-range");
    slider.type = "range";
    slider.min = "55";
    slider.max = "100";
    slider.step = "5";
    slider.value = String(value);
    slider.setAttribute("aria-label", "Panel opacity");
    const readout = node("span", "lc-set-value", `${value}%`);
    // live preview while sliding; persist on release
    slider.addEventListener("input", () => {
      readout.textContent = `${slider.value}%`;
      document.body.style.setProperty("--lc-bg", bgFor(lastSettings.theme, Number(slider.value) / 100));
    });
    slider.addEventListener("change", () => emit({ opacity: Number(slider.value) / 100 }));
    wrap.append(slider, readout);
    return wrap;
  }

  function renderSettings(s) {
    const scroll = settingsEl.scrollTop;
    settingsEl.replaceChildren();

    const top = node("div", "lc-set-top");
    const close = button("lc-icon", "Close display settings");
    close.innerHTML = icon("close");
    close.addEventListener("click", () => setSettingsOpen(false));
    top.append(node("h2", "lc-set-title", "Display"), close);
    settingsEl.appendChild(top);

    settingsEl.appendChild(sectionHeading("Appearance"));
    settingsEl.appendChild(labelled("Theme", segmented("theme", [["dark", "Dark"], ["light", "Light"]], s.theme)));
    settingsEl.appendChild(labelled("Accent", accentPicker(s)));
    settingsEl.appendChild(labelled("Panel opacity", opacityControl(s)));

    settingsEl.appendChild(sectionHeading("Lyrics"));
    settingsEl.appendChild(
      labelled("Font", segmented(
        "font",
        Object.keys(FONT_STACKS).map((k) => [k, "Aa"]),
        s.font,
        (b, k) => {
          b.style.fontFamily = FONT_STACKS[k];
          b.title = FONT_NAMES[k];
          b.setAttribute("aria-label", FONT_NAMES[k]);
        }
      ))
    );
    settingsEl.appendChild(labelled("Text size", segmented("size", [["s", "S"], ["m", "M"], ["l", "L"], ["xl", "XL"]], s.size)));
    settingsEl.appendChild(labelled("Line spacing", segmented("spacing", [["compact", "Tight"], ["cozy", "Cozy"], ["airy", "Airy"]], s.spacing)));
    settingsEl.appendChild(labelled("Alignment", segmented("align", [["left", "Left"], ["center", "Center"]], s.align)));
    settingsEl.appendChild(labelled("Current line", segmented("highlight", [["glow", "Glow"], ["spotlight", "Spotlight"], ["classic", "Simple"]], s.highlight)));

    settingsEl.appendChild(sectionHeading("Learning"));
    settingsEl.appendChild(switchRow("Spanish under each line", "showTranslations", s.showTranslations));
    settingsEl.appendChild(switchRow("Quiz mode", "blurUpcoming", s.blurUpcoming, "Blur lines until they're sung"));

    settingsEl.appendChild(sectionHeading("Panel"));
    const reset = button("lc-quiet");
    reset.textContent = "Reset";
    reset.addEventListener("click", () => emit({ panel: null }));
    settingsEl.appendChild(labelled("Position and size", reset));
    settingsEl.appendChild(
      node("p", "lc-set-hint", "Drag the header to move the panel. Drag its bottom-right corner to resize it.")
    );

    settingsEl.scrollTop = scroll;
  }

  /* ---- lyrics rendering ---- */

  function keyOf(word) {
    return MeaningProvider.normalize(word);
  }

  // Split a lyric line into tappable word spans; spaces and punctuation stay
  // as plain text. Includes apostrophes so "don't" and "gettin'" are one word.
  // Words already in the vocabulary list get their highlighter mark here.
  const WORD_RE = /([A-Za-zÀ-ÖØ-öø-ÿ'’]+)/;
  function renderWords(p, text) {
    for (const token of text.split(WORD_RE)) {
      if (!token) continue;
      if (/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(token)) {
        const span = node("span", "lc-word", token);
        if (savedWords.has(keyOf(token))) span.classList.add("lc-saved");
        p.appendChild(span);
      } else {
        p.appendChild(document.createTextNode(token));
      }
    }
  }

  // Each line is a container: main text (tappable) + an optional Spanish
  // sub-line filled in later by setTranslations().
  function buildLine(text, isStatic) {
    const container = node("div", "lc-line" + (isStatic ? " lc-static" : ""));
    const main = node("p", "lc-main");
    if (text) renderWords(main, text);
    else main.appendChild(node("span", "lc-breath", "♪")); // instrumental gap
    container.append(main, node("div", "lc-sub"));
    return container;
  }

  function setOpen(open) {
    ensureBuilt();
    root.style.display = open ? "" : "none";
    toggleBtn.style.display = open ? "none" : "";
    if (!open) setSettingsOpen(false);
  }

  function reset() {
    ensureBuilt();
    lineEls = [];
    activeIdx = -1;
    linesEl.replaceChildren();
    linesEl.classList.remove("lc-playing");
    linesEl.scrollTop = 0;
  }

  // The song in the header: what YouTube says is playing. The LRCLIB match
  // behind the lyrics rides along as a tooltip, for when they look wrong.
  function setTrack({ title, artist, art }) {
    ensureBuilt();
    titleEl.textContent = title || "Lyrics";
    artistEl.textContent = artist || "";
    if (art) {
      if (artEl.getAttribute("src") !== art) artEl.src = art;
      artEl.hidden = false;
    } else {
      artEl.hidden = true;
    }
  }

  function setMatched(matched, source) {
    titleEl.title = matched ? `Lyrics matched${source ? ` on ${source}` : ""}: ${matched}` : "";
  }

  function showLoading() {
    reset();
    showFoot(false);
    setMatched("");
    const skel = node("div", "lc-skeleton");
    skel.setAttribute("role", "status");
    skel.setAttribute("aria-label", "Finding lyrics");
    for (let i = 0; i < 5; i++) skel.appendChild(node("i"));
    linesEl.appendChild(skel);
  }

  // Empty and error states: say what happened and what to do about it.
  function showNotice({ title, detail, retry }) {
    reset();
    showFoot(false);
    const box = node("div", "lc-notice");
    box.appendChild(node("p", "lc-notice-title", title));
    if (detail) box.appendChild(node("p", "lc-notice-detail", detail));
    if (retry) {
      const b = button("lc-quiet");
      b.innerHTML = icon("retry");
      b.append("Try again");
      b.addEventListener("click", () => retryHandler && retryHandler());
      box.appendChild(b);
    }
    linesEl.appendChild(box);
  }

  // Small credit line under the lyrics: where they came from. Handy when
  // lyrics look wrong, and fair to the people who license them.
  function appendSource(source) {
    if (!source) return;
    linesEl.appendChild(node("p", "lc-source", `Lyrics via ${source}`));
  }

  function showSynced(lines, matched, source) {
    reset();
    showFoot(true);
    setMatched(matched, source);
    for (const line of lines) {
      const el = buildLine(line.text, false);
      linesEl.appendChild(el);
      lineEls.push(el);
    }
    appendSource(source);
  }

  // Unsynced lyrics (LRCLIB plain text, or YouTube Music's Lyrics tab):
  // no highlight or auto-scroll, but every word is still tappable.
  function showPlain(text, matched, source) {
    reset();
    showFoot(false);
    setMatched(matched, source);
    linesEl.appendChild(
      node("p", "lc-plain-note", "These lyrics aren't timed, so they won't follow the song.")
    );
    for (const row of text.split("\n")) {
      linesEl.appendChild(buildLine(row, true));
    }
    appendSource(source);
  }

  // Spanish sub-lines, same order and length as the synced lines array.
  function setTranslations(texts) {
    lineEls.forEach((el, i) => {
      el.querySelector(".lc-sub").textContent = texts[i] || "";
    });
  }

  // The vocabulary list changed (or arrived): mark and unmark lyric words.
  // Words saved while the song is on screen sweep their mark in; the first
  // list of the session applies quietly, so nothing flickers on page load.
  function setSavedWords(set) {
    ensureBuilt();
    const animate = savedLoaded;
    savedLoaded = true;
    savedWords = set;
    for (const span of linesEl.querySelectorAll(".lc-word")) {
      const has = set.has(keyOf(span.textContent));
      const had = span.classList.contains("lc-saved");
      if (has && !had) {
        span.classList.add("lc-saved");
        if (animate) span.classList.add("lc-sweep");
      } else if (!has && had) {
        span.classList.remove("lc-saved", "lc-sweep");
      }
    }
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
    // "playing" lets CSS tell sung lines from upcoming ones
    linesEl.classList.toggle("lc-playing", !!el);
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
  // that fills under the current line.
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

  function onRetry(fn) {
    retryHandler = fn;
  }

  return {
    setTrack, showLoading, showNotice, showSynced, showPlain, setTranslations,
    setSavedWords, setActiveLine, setActiveProgress, setSyncState,
    setOpen, setScrollPaused, applySettings, placeBeside, icon,
    onWordClick, onSettingsChange, onSyncNudge, onRetry,
  };
})();
