(() => {
  const hostname = location.hostname;
  const storage = globalThis.chrome?.storage?.local;
  if (!hostname || !storage) return;

  const siteKey = hostname;
  const shortcutsKey = "anime4kShortcuts";
  const defaultShortcuts = { modeA: "1", modeB: "2", modeC: "3", quality: "q", scale: "s", stats: "F2", compare: "c", fluency: "g", fpsHud: "F3", aiImprove: "e", togglePanel: "F1" };
  let siteActivated = false;
  let toggleShortcut = "F1";
  let controllerLoaded = false;
  let controllerLoad = null;

  function normalizeShortcut(key) {
    if (typeof key !== "string") return "F1";
    if (key === " ") return "Space";
    if (/^F\d+$/i.test(key)) return key.toUpperCase();
    return key.length === 1 ? key.toLowerCase() : key;
  }

  function updateShortcut(record) {
    const source = record && typeof record === "object" ? record : {};
    const legacyUsesG = Object.entries(source).some(([action, key]) => action !== "fluency" && normalizeShortcut(key) === "g");
    const legacyUsesF3 = Object.entries(source).some(([action, key]) => action !== "fpsHud" && normalizeShortcut(key) === "F3");
    const fluencyDefault = source.fluency ?? (legacyUsesG ? "h" : defaultShortcuts.fluency);
    const hudDefault = source.fpsHud ?? (legacyUsesF3 ? "F4" : defaultShortcuts.fpsHud);
    const next = Object.fromEntries(Object.keys(defaultShortcuts).map((action) => [action, normalizeShortcut(source[action] ?? (action === "fluency" ? fluencyDefault : action === "fpsHud" ? hudDefault : defaultShortcuts[action]))]));
    const values = Object.values(next);
    const invalid = values.some((key) => !key || ["Escape", "Tab", "Enter", "Control", "Alt", "Shift", "Meta"].includes(key) || key === "a" || key === "v") || new Set(values).size !== values.length;
    toggleShortcut = invalid ? defaultShortcuts.togglePanel : next.togglePanel;
  }

  function loadController() {
    if (controllerLoaded || globalThis.__anime4kControllerLoaded) return Promise.resolve(true);
    if (controllerLoad) return controllerLoad;
    controllerLoad = globalThis.chrome.runtime.sendMessage({ channel: "anime4k-engine", action: "controller" })
      .then((response) => {
        if (!response?.ok) throw new Error(response?.error || "No se pudo iniciar Anime4K en este reproductor");
        controllerLoaded = true;
        return true;
      })
      .catch((error) => {
        console.warn("[Anime4K] No se pudo cargar el controlador del sitio", error);
        return false;
      })
      .finally(() => { controllerLoad = null; });
    return controllerLoad;
  }

  async function activateSite() {
    if (globalThis.__anime4kControllerLoaded) return;
    const current = await storage.get(siteKey);
    if (current?.[siteKey]?.activated) {
      siteActivated = true;
      await loadController();
      return;
    }
    await storage.set({ [siteKey]: { activated: true, enabled: true, panelManuallyHidden: false } });
    siteActivated = true;
    await loadController();
  }

  function onKeydown(event) {
    if (globalThis.__anime4kControllerLoaded || normalizeShortcut(event.key) !== toggleShortcut) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (siteActivated) void loadController();
    else void activateSite().catch((error) => console.warn("[Anime4K] No se pudo activar este sitio", error));
  }

  document.addEventListener("keydown", onKeydown, true);
  storage.get([siteKey, shortcutsKey]).then((stored) => {
    updateShortcut(stored?.[shortcutsKey]);
    siteActivated = stored?.[siteKey]?.activated === true;
    if (siteActivated) void loadController();
  }).catch((error) => console.warn("[Anime4K] No se pudieron leer las preferencias del sitio", error));

  globalThis.chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[shortcutsKey]) updateShortcut(changes[shortcutsKey].newValue);
    if (changes[siteKey]) {
      siteActivated = changes[siteKey].newValue?.activated === true;
      if (siteActivated) void loadController();
    }
  });
})();

