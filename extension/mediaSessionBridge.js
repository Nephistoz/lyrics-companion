// mediaSessionBridge.js — runs in the PAGE's own JavaScript world ("MAIN"
// world in manifest.json), not in our extension sandbox.
//
// Why: YouTube Music tells the browser what's playing through
// navigator.mediaSession.metadata (that's what feeds your keyboard's media
// keys and the OS "now playing" widget). It holds the clean song title,
// artist and album, which is better input for LRCLIB than the player-bar
// text. But that object belongs to the page's JS world, which our content
// script (isolated world) can't reliably see.
//
// So this tiny script copies the metadata into an attribute on <html>, which
// both worlds share (the DOM is common ground). content.js reads it from
// there. No messaging, no chrome.* APIs (not available in the MAIN world).

(() => {
  const ATTR = "data-lc-media-session";
  let last = "";

  setInterval(() => {
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const json = md
      ? JSON.stringify({ title: md.title || "", artist: md.artist || "", album: md.album || "" })
      : "";
    if (json !== last) {
      last = json;
      if (json) document.documentElement.setAttribute(ATTR, json);
      else document.documentElement.removeAttribute(ATTR);
    }
  }, 500);
})();
