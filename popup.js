(() => {
  const domainLabel = document.querySelector("#domain");
  const popupIcon = document.querySelector("header img");
  const statusLabel = document.querySelector("#status");
  const statusDot = document.querySelector("#status-dot");
  const siteSwitch = document.querySelector("#site-switch");
  const detailSwitch = document.querySelector("#detail-switch");
  const qualitySwitcher = document.querySelector("#quality-switcher");
  const errorLabel = document.querySelector("#error");
  const shortcutList = document.querySelector("#shortcut-list");
  const resetShortcutsButton = document.querySelector("#reset-shortcuts");
  const shortcutMessage = document.querySelector("#shortcut-message");
  const shortcutsStorageKey = "anime4kShortcuts";
  const defaultShortcuts = { modeA: "1", modeB: "2", modeC: "3", quality: "q", scale: "s", stats: "F2", compare: "c", fluency: "g", fpsHud: "F3", aiImprove: "e", togglePanel: "F1" };
  const shortcutActions = [
    ["modeA", "Modo A"], ["modeB", "Modo B"], ["modeC", "Modo C"],
    ["quality", "Calidad"], ["scale", "Escala"], ["stats", "Estadísticas"], ["compare", "Comparar"], ["fluency", "Generación de fotogramas"], ["fpsHud", "Contador de FPS"], ["aiImprove", "Foto con IA"],
    ["togglePanel", "Mostrar/ocultar panel"]
  ];
  let hostname = "";
  let activated = false;
  let detailEnabled = false;
  let quality = "Fast";
  let globalQuality = "Fast";
  let busy = false;
  let shortcuts = { ...defaultShortcuts };
  let pendingShortcut = null;
  let shortcutMessageTimer = null;

  popupIcon.addEventListener("error", () => { popupIcon.hidden = true; }, { once: true });

  function showError(error) {
    errorLabel.textContent = error?.message || String(error);
    errorLabel.hidden = false;
  }

  function paint() {
    statusLabel.textContent = activated ? "Activado" : "Desactivado";
    statusDot.classList.toggle("is-on", activated);
    siteSwitch.checked = activated;
    siteSwitch.setAttribute("aria-checked", String(activated));
    siteSwitch.disabled = !hostname || busy;
    detailSwitch.checked = detailEnabled;
    detailSwitch.setAttribute("aria-checked", String(detailEnabled));
    detailSwitch.disabled = !hostname || !activated || busy;
    for (const button of qualitySwitcher.querySelectorAll("button[data-quality]")) {
      button.setAttribute("aria-pressed", String(button.dataset.quality === quality));
      button.disabled = !hostname || !activated || busy;
    }
  }

  function normalizeKey(key) {
    if (typeof key !== "string") return "";
    if (key === " ") return "Space";
    if (/^F\d+$/i.test(key)) return key.toUpperCase();
    return key.length === 1 ? key.toLowerCase() : key;
  }

  function displayKey(key) {
    return key === "Space" ? "Espacio" : key.length === 1 ? key.toUpperCase() : key;
  }

  function validShortcuts(candidate) {
    const values = Object.keys(defaultShortcuts).map((action) => normalizeKey(candidate[action]));
    const forbidden = new Set(["Escape", "Tab", "Enter", "Control", "Alt", "Shift", "Meta", "a", "v"]);
    return Object.keys(defaultShortcuts).every((action) => typeof candidate[action] === "string" && candidate[action].length > 0) &&
      values.every((key) => !forbidden.has(key)) && new Set(values).size === values.length;
  }

  function renderShortcuts() {
    shortcutList.replaceChildren();
    for (const [action, label] of shortcutActions) {
      const row = document.createElement("div");
      row.className = "shortcut-row";
      const title = document.createElement("span");
      title.textContent = label;
      const field = document.createElement("button");
      field.type = "button";
      field.className = "shortcut-key";
      field.dataset.action = action;
      field.textContent = pendingShortcut === action ? "Presioná una tecla..." : displayKey(shortcuts[action]);
      field.setAttribute("aria-label", `${label}: ${field.textContent}. Hacé clic para cambiar`);
      field.classList.toggle("is-listening", pendingShortcut === action);
      field.addEventListener("click", () => {
        pendingShortcut = action;
        clearShortcutMessage();
        renderShortcuts();
        shortcutList.querySelector(`[data-action="${action}"]`)?.focus();
      });
      row.append(title, field);
      shortcutList.append(row);
    }
  }

  function showShortcutMessage(message, isError = true) {
    if (shortcutMessageTimer !== null) clearTimeout(shortcutMessageTimer);
    shortcutMessage.textContent = message;
    shortcutMessage.style.color = isError ? "#ffd27c" : "#9ce8bd";
    shortcutMessage.hidden = false;
    shortcutMessageTimer = setTimeout(() => {
      shortcutMessage.hidden = true;
      shortcutMessageTimer = null;
    }, 3000);
  }

  function clearShortcutMessage() {
    if (shortcutMessageTimer !== null) clearTimeout(shortcutMessageTimer);
    shortcutMessageTimer = null;
    shortcutMessage.hidden = true;
  }

  async function saveShortcuts(next) {
    try {
      await chrome.storage.local.set({ [shortcutsStorageKey]: next });
      shortcuts = { ...next };
      renderShortcuts();
      showShortcutMessage("Atajo guardado. Se aplica en las pestañas abiertas.", false);
    } catch (error) {
      showShortcutMessage(`No se pudo guardar: ${error?.message || error}`);
      renderShortcuts();
    }
  }

  async function loadShortcuts() {
    try {
      const saved = await chrome.storage.local.get(shortcutsStorageKey);
      const source = saved?.[shortcutsStorageKey] || {};
      const legacyUsesG = Object.entries(source).some(([action, key]) => action !== "fluency" && normalizeKey(key) === "g");
      const fluencyDefault = source.fluency ?? (legacyUsesG ? "h" : defaultShortcuts.fluency);
      const legacyUsesF3 = Object.entries(source).some(([action, key]) => action !== "fpsHud" && normalizeKey(key) === "F3");
      const hudDefault = source.fpsHud ?? (legacyUsesF3 ? "F4" : defaultShortcuts.fpsHud);
      const candidate = Object.fromEntries(Object.keys(defaultShortcuts).map((action) => [action, source[action] ?? (action === "fluency" ? fluencyDefault : action === "fpsHud" ? hudDefault : defaultShortcuts[action])]));
      shortcuts = validShortcuts(candidate)
        ? Object.fromEntries(Object.entries(candidate).map(([action, key]) => [action, normalizeKey(key)]))
        : { ...defaultShortcuts };
      if (!validShortcuts(candidate)) showShortcutMessage("Había atajos inválidos. Se muestran los valores predeterminados.");
    } catch (error) {
      showShortcutMessage(`No se pudieron leer los atajos: ${error?.message || error}`);
    }
    renderShortcuts();
  }

  window.addEventListener("keydown", (event) => {
    if (!pendingShortcut) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    if (event.key === "Escape") {
      pendingShortcut = null;
      clearShortcutMessage();
      renderShortcuts();
      return;
    }
    if (event.key === "Tab" || event.key === "Enter") {
      showShortcutMessage(`${event.key} no se puede usar como atajo.`);
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) {
      showShortcutMessage("No se permiten combinaciones con Ctrl, Alt o la tecla Windows.");
      return;
    }
    const key = normalizeKey(event.key);
    if (["Escape", "Tab", "Enter", "Control", "Alt", "Shift", "Meta"].includes(key)) {
      showShortcutMessage("Esa tecla no se puede usar como atajo.");
      return;
    }
    if (key === "a") {
      showShortcutMessage("A ya activa o desactiva Anime4K y está reservada.");
      return;
    }
    if (key === "v") {
      showShortcutMessage("V se usa mientras la mantenés presionada para ver el original.");
      return;
    }
    const duplicate = Object.entries(shortcuts).some(([action, existing]) => action !== pendingShortcut && existing === key);
    if (duplicate) {
      showShortcutMessage(`${displayKey(key)} ya está asignada a otra acción.`);
      return;
    }
    const action = pendingShortcut;
    pendingShortcut = null;
    void saveShortcuts({ ...shortcuts, [action]: key });
  }, true);

  resetShortcutsButton.addEventListener("click", () => {
    pendingShortcut = null;
    clearShortcutMessage();
    void saveShortcuts({ ...defaultShortcuts });
  });

  async function readState() {
    const saved = await chrome.storage.local.get([hostname, "anime4kGlobalSettings"]);
    const record = saved?.[hostname];
    activated = Boolean(record?.activated);
    detailEnabled = record?.detailEnabled === true;
    globalQuality = ["Fast", "HQ", "Máxima"].includes(saved?.anime4kGlobalSettings?.quality) ? saved.anime4kGlobalSettings.quality : "Fast";
    quality = ["Fast", "HQ", "Máxima"].includes(record?.quality) ? record.quality : globalQuality;
    paint();
  }

  async function initialize() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) throw new Error("No se pudo leer la dirección de esta pestaña.");
      const url = new URL(tab.url);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
        throw new Error("Esta página no permite activar Anime4K.");
      }
      hostname = url.hostname;
      domainLabel.textContent = hostname;
      await readState();
    } catch (error) {
      domainLabel.textContent = "No disponible";
      statusLabel.textContent = "No se pudo consultar este sitio.";
      siteSwitch.disabled = true;
      showError(error);
    }
  }

  qualitySwitcher.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-quality]");
    if (!button || !hostname || !activated || busy) return;
    const nextQuality = button.dataset.quality;
    if (!["Fast", "HQ", "Máxima"].includes(nextQuality) || nextQuality === quality) return;
    busy = true;
    paint();
    errorLabel.hidden = true;
    try {
      const saved = await chrome.storage.local.get(hostname);
      const record = saved?.[hostname];
      if (!record?.activated) {
        activated = false;
      } else {
        await chrome.storage.local.set({ [hostname]: { ...record, quality: nextQuality } });
        const confirmed = await chrome.storage.local.get(hostname);
        quality = ["Fast", "HQ", "Máxima"].includes(confirmed?.[hostname]?.quality) ? confirmed[hostname].quality : globalQuality;
        activated = Boolean(confirmed?.[hostname]?.activated);
      }
    } catch (error) {
      showError(error);
      try {
        const current = await chrome.storage.local.get(hostname);
        const record = current?.[hostname];
        activated = Boolean(record?.activated);
        quality = ["Fast", "HQ", "Máxima"].includes(record?.quality) ? record.quality : globalQuality;
      } catch { /* Conserva el último valor conocido. */ }
    } finally {
      busy = false;
      paint();
    }
  });

  siteSwitch.addEventListener("change", async () => {
    if (!hostname || busy) return;
    busy = true;
    siteSwitch.disabled = true;
    errorLabel.hidden = true;
    try {
      // Vuelve a leer antes de alternar, por si F1 o el panel cambiaron el estado.
      const saved = await chrome.storage.local.get(hostname);
      const wasActivated = Boolean(saved?.[hostname]?.activated);
      if (wasActivated) {
        await chrome.storage.local.remove(hostname);
        activated = false;
        detailEnabled = false;
      } else {
        // Mismo registro que crea F1 en el content script.
        await chrome.storage.local.set({
          [hostname]: { activated: true, enabled: true, panelManuallyHidden: false, detailEnabled: false }
        });
        activated = true;
      }
      // Confirma el valor almacenado, incluida cualquier actualización concurrente.
      const confirmed = await chrome.storage.local.get(hostname);
      activated = Boolean(confirmed?.[hostname]?.activated);
    } catch (error) {
      showError(error);
      try {
        const current = await chrome.storage.local.get(hostname);
        activated = Boolean(current?.[hostname]?.activated);
      } catch { /* Conserva el último estado conocido. */ }
    } finally {
      busy = false;
      paint();
    }
  });

  detailSwitch.addEventListener("change", async () => {
    if (!hostname || !activated || busy) return;
    busy = true;
    paint();
    errorLabel.hidden = true;
    try {
      const saved = await chrome.storage.local.get(hostname);
      const record = saved?.[hostname];
      if (!record?.activated) {
        activated = false;
        detailEnabled = false;
      } else {
        detailEnabled = detailSwitch.checked;
        await chrome.storage.local.set({ [hostname]: { ...record, detailEnabled } });
        const confirmed = await chrome.storage.local.get(hostname);
        detailEnabled = confirmed?.[hostname]?.detailEnabled === true;
      }
    } catch (error) {
      showError(error);
      try {
        const current = await chrome.storage.local.get(hostname);
        detailEnabled = current?.[hostname]?.detailEnabled === true;
      } catch { /* Conserva el último valor conocido. */ }
    } finally {
      busy = false;
      paint();
    }
  });

  siteSwitch.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || siteSwitch.disabled) return;
    event.preventDefault();
    siteSwitch.click();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.anime4kGlobalSettings) {
      globalQuality = ["Fast", "HQ", "Máxima"].includes(changes.anime4kGlobalSettings.newValue?.quality) ? changes.anime4kGlobalSettings.newValue.quality : "Fast";
      if (hostname) void readState();
    }
    if (changes[shortcutsStorageKey]) {
      const source = changes[shortcutsStorageKey].newValue || {};
      const legacyUsesF3 = Object.entries(source).some(([action, key]) => action !== "fpsHud" && normalizeKey(key) === "F3");
      const candidate = Object.fromEntries(Object.keys(defaultShortcuts).map((action) => [action, source[action] ?? (action === "fpsHud" && legacyUsesF3 ? "F4" : defaultShortcuts[action])]));
      shortcuts = validShortcuts(candidate)
        ? Object.fromEntries(Object.entries(candidate).map(([action, key]) => [action, normalizeKey(key)]))
        : { ...defaultShortcuts };
      renderShortcuts();
    }
    if (hostname && changes[hostname]) {
      activated = Boolean(changes[hostname].newValue?.activated);
      detailEnabled = changes[hostname].newValue?.detailEnabled === true;
      quality = ["Fast", "HQ", "Máxima"].includes(changes[hostname].newValue?.quality) ? changes[hostname].newValue.quality : globalQuality;
      paint();
    }
  });

  void loadShortcuts();
  void initialize();
})();
