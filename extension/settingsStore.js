// settingsStore.js — display settings, persisted in chrome.storage.local.
//
// Shared-core module: panel styling, the vocab popup, and (someday) the
// companion app all read the same settings object. content.js connects
// onChange() to Panel.applySettings().

const SettingsStore = (() => {
  const KEY = "settings";

  const DEFAULTS = {
    theme: "dark", // dark | light
    accent: "#FFB454", // any hex; the panel offers preset swatches
    font: "grotesk", // grotesk | system | serif | mono
    size: "m", // s | m | l | xl
    highlight: "glow", // glow | spotlight | classic
    showTranslations: false, // Spanish line under each English line
    blurUpcoming: false, // self-test mode: blur lines not sung yet
  };

  let cached = null;
  const listeners = [];

  async function get() {
    if (!cached) {
      const data = await chrome.storage.local.get(KEY);
      cached = { ...DEFAULTS, ...(data[KEY] || {}) };
    }
    return { ...cached };
  }

  async function set(patch) {
    const next = { ...(await get()), ...patch };
    cached = next;
    await chrome.storage.local.set({ [KEY]: next });
    for (const fn of listeners) fn({ ...next });
  }

  function onChange(fn) {
    listeners.push(fn);
  }

  return { get, set, onChange, DEFAULTS };
})();
