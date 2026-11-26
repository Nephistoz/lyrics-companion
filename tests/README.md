# Tests

Plain Node, no dependencies, no build step. Run them from the repo root:

```
node tests/lyrics-matching.test.js
node tests/track-change.test.js
node tests/lyricsProvider.test.js
```

- **lyrics-matching** — hits the real LRCLIB API: honours `[offset:]` tags, picks the
  version whose duration matches the track playing (LRCLIB hosts uploads of the same
  song up to a minute apart), and reports a mismatch instead of drifting silently.
- **track-change** — runs the real `content.js` in a sandbox with a scripted player
  clock. Guards the bug that took four attempts to kill: at a track change the next
  song's lyrics could arrive while the previous song was still playing, and the
  highlight would land in the middle of the song.

- **lyricsProvider** — offline: title/artist cleanup and the similarity checks that
  reject wrong LRCLIB search results.

Run all three before touching sync or lyrics code. (lyrics-matching prints a storage
warning in Node: the lyrics cache has no `chrome.storage` there. Harmless.)
