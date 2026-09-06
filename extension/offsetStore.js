// offsetStore.js — per-song lyric timing offsets, in chrome.storage.local.
//
// Some songs simply cannot be auto-synced: YouTube Music's video versions
// often open with an intro the album-timed lyrics know nothing about, so the
// whole file sits a second or two off. Nudging the timing is the fix — and
// because the offset is stored per song, each one only ever needs fixing once.
//
// Shape: { "artist|title": secondsToShift }

const OffsetStore = (() => {
  const KEY = "offsets";

  function keyFor(title, artist) {
    return `${(artist || "").toLowerCase().trim()}|${(title || "").toLowerCase().trim()}`;
  }

  async function get(title, artist) {
    const data = await chrome.storage.local.get(KEY);
    return (data[KEY] || {})[keyFor(title, artist)] || 0;
  }

  async function set(title, artist, seconds) {
    const data = await chrome.storage.local.get(KEY);
    const all = data[KEY] || {};
    if (seconds) all[keyFor(title, artist)] = seconds;
    else delete all[keyFor(title, artist)]; // back in sync = forget it
    await chrome.storage.local.set({ [KEY]: all });
  }

  return { get, set };
})();
