// syncProvider.js — ALL cloud-sync traffic lives here (shared by both shells).
//
// Talks to Supabase's auto-generated REST API with plain fetch — no SDK, no
// dependencies. Swappable like the other providers: if the backend ever
// changes, only this file knows Supabase exists.
//
// Must be configured before use: SyncProvider.configure({ supabaseUrl,
// supabaseKey }). The extension does it from config.js; the phone app from
// values you paste once (kept in localStorage).

const SyncProvider = (() => {
  let cfg = null;

  function configure(c) {
    cfg = c && c.supabaseUrl && c.supabaseKey ? c : null;
  }

  function isConfigured() {
    return cfg !== null;
  }

  async function req(method, path, body, prefer) {
    const headers = { apikey: cfg.supabaseKey, "Content-Type": "application/json" };
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Sync ${method} failed (HTTP ${res.status})`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // The database uses snake_case columns; the app uses camelCase objects.
  function fromRow(r) {
    return {
      id: r.id,
      word: r.word,
      translation: r.translation,
      meaning: r.meaning,
      songTitle: r.song_title,
      artist: r.artist,
      lyricLine: r.lyric_line,
      dateAdded: r.date_added,
      intervalStep: r.interval_step,
      nextReview: r.next_review,
    };
  }

  function toRow(e) {
    return {
      id: e.id,
      word: e.word,
      translation: e.translation || "",
      meaning: e.meaning || "",
      song_title: e.songTitle || "",
      artist: e.artist || "",
      lyric_line: e.lyricLine || "",
      date_added: e.dateAdded || new Date().toISOString(),
      interval_step: e.intervalStep || 0,
      next_review: e.nextReview || new Date().toISOString(),
    };
  }

  // Insert-or-update by id, so re-pushing the same entry is harmless.
  async function upsert(entries) {
    if (!entries.length) return;
    await req("POST", "vocab?on_conflict=id", entries.map(toRow), "resolution=merge-duplicates");
  }

  async function fetchAll() {
    const rows = await req("GET", "vocab?select=*&order=date_added.desc");
    return rows.map(fromRow);
  }

  function removeRemote(id) {
    return req("DELETE", `vocab?id=eq.${encodeURIComponent(id)}`);
  }

  // Flashcard grading only touches the spaced-repetition fields.
  function updateReview(id, intervalStep, nextReview) {
    return req("PATCH", `vocab?id=eq.${encodeURIComponent(id)}`, {
      interval_step: intervalStep,
      next_review: nextReview,
    });
  }

  return { configure, isConfigured, upsert, fetchAll, removeRemote, updateReview };
})();
