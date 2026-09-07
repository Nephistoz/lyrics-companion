# Tests

Plain Node, no dependencies, no build step. Run them from the repo root:

```
node tests/lyrics-matching.test.js
node tests/track-change.test.js
```

- **lyrics-matching** — hits the real LRCLIB API: honours `[offset:]` tags, picks the
  version whose duration matches the track playing (LRCLIB hosts uploads of the same
  song up to a minute apart), and reports a mismatch instead of drifting silently.
- **track-change** — runs the real `content.js` in a sandbox with a scripted player
  clock. Guards the bug that took four attempts to kill: at a track change the next
  song's lyrics could arrive while the previous song was still playing, and the
  highlight would land in the middle of the song.

Run both before touching sync code.
