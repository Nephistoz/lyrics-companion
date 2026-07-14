// vocabStore.js — the vocabulary list. Local-first: chrome.storage.local is
// the source you read from (works offline, instant), and every change is
// mirrored to Supabase through SyncProvider so the phone app sees it.
//
// Entry shape: { id, word, translation, meaning, songTitle, artist,
//                lyricLine, dateAdded, intervalStep, nextReview, synced }

const VocabStore = (() => {
  const KEY = "vocab";

  // config.js defines SYNC_CONFIG; guard so everything still works locally
  // if the config file is missing or empty.
  if (typeof SYNC_CONFIG !== "undefined") SyncProvider.configure(SYNC_CONFIG);

  async function getAll() {
    const data = await chrome.storage.local.get(KEY);
    return data[KEY] || [];
  }

  function saveAll(all) {
    return chrome.storage.local.set({ [KEY]: all });
  }

  async function add(entry) {
    const all = await getAll();
    entry.id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    entry.intervalStep = 0;
    entry.nextReview = new Date().toISOString(); // new words are due right away
    entry.synced = false;
    all.unshift(entry); // newest first
    await saveAll(all);

    // Mirror to the cloud in the background; if it fails (offline, server
    // down) the entry stays marked unsynced and syncNow() retries later.
    if (SyncProvider.isConfigured()) {
      try {
        await SyncProvider.upsert([entry]);
        entry.synced = true;
        await saveAll(all);
      } catch (err) {
        console.warn("[LyricsCompanion] sync push failed:", err.message);
      }
    }
    return entry;
  }

  async function remove(id) {
    const all = await getAll();
    await saveAll(all.filter((e) => e.id !== id));
    if (SyncProvider.isConfigured()) {
      try {
        await SyncProvider.removeRemote(id);
      } catch (err) {
        console.warn("[LyricsCompanion] sync delete failed:", err.message);
      }
    }
  }

  // Full sync: push anything unsynced, then adopt the server's list (it now
  // includes phone-side changes AND what we just pushed). Local entries whose
  // push failed are kept. Runs when the vocab popup opens.
  async function syncNow() {
    if (!SyncProvider.isConfigured()) return { ok: false, reason: "no config" };
    const all = await getAll();
    await SyncProvider.upsert(all.filter((e) => !e.synced));
    const remote = await SyncProvider.fetchAll();
    const remoteIds = new Set(remote.map((r) => r.id));
    const merged = remote.map((r) => ({ ...r, synced: true }));
    for (const e of all) {
      if (!e.synced && !remoteIds.has(e.id)) merged.push(e);
    }
    merged.sort((a, b) => String(b.dateAdded).localeCompare(String(a.dateAdded)));
    await saveAll(merged);
    return { ok: true };
  }

  return { getAll, add, remove, syncNow };
})();
