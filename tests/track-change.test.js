// Runs the REAL content.js in a sandbox with a scripted player clock, to prove
// the highlight can never land mid-song right after a track change.
const fs = require("fs"), vm = require("vm");

const highlighted = [];          // every index the panel was told to light
const noEvents = () => {}; // fake players need the listener API hookVideo uses
const video = { duration: 476, currentTime: 0, paused: false, addEventListener: noEvents };
const dom = { title: "Woods", byline: "Mac Miller", time: "0:28 / 4:47", videos: [] };
const lyrics = Array.from({ length: 48 }, (_, i) => ({ time: i * 10, text: `line ${i}` }));

const noop = () => {};
const sandbox = {
  console: { log: noop, warn: noop },
  performance: { now: () => Date.now() },
  setInterval: noop,
  requestAnimationFrame: noop,
  document: {
    // fake player-bar DOM: title, byline and the "0:28 / 4:47" time readout
    querySelector: (sel) => {
      if (sel.includes("byline")) return { textContent: dom.byline };
      if (sel.includes("title")) return { textContent: dom.title };
      if (sel.includes("time-info")) return { textContent: dom.time };
      return null;
    },
    querySelectorAll: (sel) => (sel === "video" ? dom.videos : []),
  },
  Panel: {
    setTrack: noop, showLoading: noop, showNotice: noop, showSynced: noop, showPlain: noop,
    setTranslations: noop, setSavedWords: noop, setSyncState: noop, setActiveProgress: noop,
    setScrollPaused: noop, applySettings: noop, onWordClick: noop, onSettingsChange: noop,
    onSyncNudge: noop, onRetry: noop,
    setActiveLine: (idx) => highlighted.push(idx),
  },
  VocabStore: { getAll: async () => [], onChange: noop },
  WordPopup: { hide: noop, onOpenChange: noop },
  OffsetStore: { get: async () => 0, set: noop },
  SettingsStore: { get: async () => ({}), onChange: noop },
  MeaningProvider: { normalize: (w) => w.toLowerCase() },
  LyricsProvider: { cleanTitle: (t) => t, getLyrics: async () => ({ synced: lyrics, matched: "test", matchedDuration: 476, durationMismatch: false }) },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const src = fs.readFileSync(require("path").join(__dirname, "../extension/content.js"), "utf8");
vm.runInContext(src + `
;globalThis.__t = {
  onSongChange, render, detect,
  setVideo: (v) => { videoEl = v; clockTrusted = true; },
  state: () => ({ awaitingStart, lineIndex, clockTrusted }),
};`, sandbox);

const T = sandbox.__t;
T.setVideo(video);
let failures = 0;
const check = (name, pass, detail) => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`);
  if (!pass) failures++;
};
const frames = (n) => { for (let i = 0; i < n; i++) T.render(); };

(async () => {
  // --- the reported bug: next song's lyrics arrive while the previous track
  //     is still playing out its final seconds (clock at 7:40 of 7:56) ---
  video.currentTime = 460;
  await T.onSongChange("Perfect Circle / God Speed", "Mac Miller", 476, true);
  frames(5);
  check("no highlight while the old track is still running", highlighted.length === 0,
    `panel was told to light: [${highlighted}]`);

  // the new track actually begins
  video.currentTime = 0.4;
  frames(2);
  check("starts from the top once the new track begins",
    highlighted.length > 0 && highlighted[0] <= 0, `first highlight: ${highlighted[0]}`);

  // and then follows along normally
  video.currentTime = 100.5;
  frames(2);
  check("follows the song after that", highlighted[highlighted.length - 1] === 10,
    `line ${highlighted[highlighted.length - 1]} at 100.5s (want 10)`);

  // --- page load mid-song must NOT wait: that clock is mid-song by nature ---
  highlighted.length = 0;
  video.currentTime = 150;
  await T.onSongChange("Some Song", "Someone", 476, false);
  frames(2);
  check("page load mid-song highlights immediately", highlighted[0] === 15,
    `line ${highlighted[0]} at 150s (want 15)`);

  // --- seeking deep into a brand-new track before its opening plays ---
  highlighted.length = 0;
  video.currentTime = 470;
  await T.onSongChange("Next Song", "Someone", 476, true);
  frames(2);                       // holding: clock still on the old track
  video.currentTime = 300;         // user seeks; clock jumps backwards
  frames(2);
  check("a backwards jump also proves a new track", highlighted.length > 0,
    `highlights: [${highlighted}]`);

  // --- a stalled <video> must never be mistaken for the player ---
  // (this is the bug where lyrics load, the clock sits at 0:00, and nothing
  //  is ever highlighted while the song plays on)
  highlighted.length = 0;
  const frozen = { duration: 287, currentTime: 0, paused: false, addEventListener: noEvents };
  const live = { duration: 287, currentTime: 28.4, paused: false, addEventListener: noEvents };
  dom.videos = [frozen, live]; // the stalled one comes first in the DOM
  dom.time = "0:28 / 4:47";
  T.detect();
  await T.onSongChange("Woods", "Mac Miller", 287, false);
  frames(2);
  check("ignores a stalled element and follows the playing one",
    highlighted[0] === 2, `line ${highlighted[0]} at 0:28 (want 2)`);

  // --- and when NO element agrees with the player bar, follow the bar ---
  highlighted.length = 0;
  dom.videos = [frozen]; // only the stalled element exists
  T.detect();
  await T.onSongChange("Woods II", "Mac Miller", 287, false);
  frames(2);
  check("falls back to the player bar's own clock",
    T.state().clockTrusted === false && highlighted[0] === 2,
    `trusted=${T.state().clockTrusted}, line ${highlighted[0]} (want 2)`);

  console.log(failures ? `\n${failures} failing` : "\nall green");
  process.exit(failures ? 1 : 0);
})();
