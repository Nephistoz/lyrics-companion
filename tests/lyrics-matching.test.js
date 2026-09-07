// Regression tests for the lyric-sync drift bug.
const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "../extension/lyricsProvider.js"), "utf8");
const LP = eval(src + ";LyricsProvider");

let failures = 0;
function check(name, pass, detail) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`);
  if (!pass) failures++;
}

(async () => {
  // 1. [offset:] tag must shift every timestamp (rare on LRCLIB, but valid LRC)
  const lrc = "[ar:Test]\n[offset:+500]\n[00:10.00]one\n[00:20.00]two";
  const parsed = LP.parseLrc(lrc);
  check("offset tag shifts timestamps", parsed[0] && parsed[0].time === 9.5,
    `first line at ${parsed[0] && parsed[0].time}s (want 9.5)`);

  // 2. Must pick the version whose duration matches the song being played.
  //    "Believed" exists on LRCLIB at ~170s AND ~229s.
  const believed = await LP.getLyrics({ title: "Believed", artist: "Lauv", duration: 170 });
  check("picks the duration-matched version", believed && Math.abs(believed.matchedDuration - 170) <= 5,
    `matched a ${believed && believed.matchedDuration}s version for a 170s song`);

  // 3. When nothing is close, report the mismatch instead of silently
  //    serving lyrics that will drift.
  const wrong = await LP.getLyrics({ title: "Believed", artist: "Lauv", duration: 400 });
  check("reports duration mismatch", wrong && Math.abs(wrong.matchedDuration - 400) > 15 && wrong.durationMismatch === true,
    `matchedDuration=${wrong && wrong.matchedDuration}, durationMismatch=${wrong && wrong.durationMismatch}`);

  console.log(failures ? `\n${failures} failing` : "\nall green");
})();
