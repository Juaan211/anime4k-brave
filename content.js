(() => {
  const running = new WeakSet();
  const diagnostics = new Set();
  const hostname = location.hostname;
  const globalSettingsKey = "anime4kGlobalSettings";
  const shortcutsStorageKey = "anime4kShortcuts";
  const siteStorageKey = hostname;
  const legacySettingsKey = "anime4kSettings";
  const defaultShortcuts = { modeA: "1", modeB: "2", modeC: "3", quality: "q", scale: "s", stats: "F2", compare: "c", fluency: "g", fpsHud: "F3", aiImprove: "e", togglePanel: "F1" };
  let shortcuts = { ...defaultShortcuts };
  let siteRecord = null;
  let siteActivated = false;
  let overlayEnabled = false;
  let comparisonEnabled = false;
  let originalPreviewHeld = false;
  let comparisonLabelsVisible = true;
  let activeMode = "A";
  let activeQuality = "Fast";
  let outputScale = 1;
  let globalDefaults = { mode: "A", quality: "Fast", scale: 1 };
  const anime4kExportNames = ["CNNx2UL", "CNNUL", "CNNx2VL", "CNNVL", "CNNSoftVL", "DenoiseCNNx2VL", "GANUUL", "Downscale"];
  const anime4kLibrary = globalThis["anime4k-webgpu"];
  console.info("[Anime4K diagnóstico] Exports Anime4K WebGPU", {
    requested: Object.fromEntries(anime4kExportNames.map((name) => [name, typeof anime4kLibrary?.[name] === "function"])),
    available: Object.keys(anime4kLibrary || {})
  });
  let detailEnabled = false;
  let detailIntensity = 0.5;
  let detailSizeMode = "Medio";
  let sharpeningEnabled = false;
  let sharpeningIntensity = 0.5;
  let lineEnhancementIntensity = 0;
  let lineMaskDebugEnabled = false;
  let fluencyEnabled = false;
  let interpolationMode = "mix";
  let fluencyControlMode = "multiplier";
  let fluencyMultiplier = 2;
  let fluencyTarget = 60;
  let panelManuallyHidden = false;
  let panelMinimized = false;
  let panelPosition = null;
  let panelTab = "image";
  let fpsHudPosition = null;
  const extensionStorage = globalThis.chrome?.storage?.local;
  const pendingOwnSiteWrites = new Map();
  let settingsLoaded = false;
  let storageReadyResolve;
  const storageReady = new Promise((resolve) => { storageReadyResolve = resolve; });
  let lastAutomaticScaleAdjustment = 0;

  function broadcast(method, ...args) {
    for (const diagnostic of diagnostics) diagnostic[method]?.(...args);
  }

  function normalizeShortcutKey(key) {
    if (typeof key !== "string") return "";
    if (key === " ") return "Space";
    if (/^F\d+$/i.test(key)) return key.toUpperCase();
    return key.length === 1 ? key.toLowerCase() : key;
  }

  function displayShortcutKey(key) {
    return key === "Space" ? "Espacio" : key.length === 1 ? key.toUpperCase() : key;
  }

  function applyShortcuts(saved = {}) {
    const source = saved && typeof saved === "object" ? saved : {};
    const legacyUsesG = Object.entries(source).some(([action, key]) => action !== "fluency" && normalizeShortcutKey(key) === "g");
    const fluencyDefault = source.fluency ?? (legacyUsesG ? "h" : defaultShortcuts.fluency);
    const legacyUsesF3 = Object.entries(source).some(([action, key]) => action !== "fpsHud" && normalizeShortcutKey(key) === "F3");
    const hudDefault = source.fpsHud ?? (legacyUsesF3 ? "F4" : defaultShortcuts.fpsHud);
    const next = Object.fromEntries(Object.keys(defaultShortcuts).map((action) => [action, normalizeShortcutKey(source[action] ?? (action === "fluency" ? fluencyDefault : action === "fpsHud" ? hudDefault : defaultShortcuts[action]))]));
    const values = Object.values(next);
    const invalid = values.some((key) => !key || ["Escape", "Tab", "Enter", "Control", "Alt", "Shift", "Meta"].includes(key) || key === "a" || key === "v") || new Set(values).size !== values.length;
    shortcuts = invalid ? { ...defaultShortcuts } : next;
    broadcast("refreshShortcutLabels");
    if (invalid) console.warn("[Anime4K] Atajos guardados inválidos o repetidos; se restauraron los valores predeterminados.");
  }

  function resetPerformanceAdjustment() {
    lastAutomaticScaleAdjustment = 0;
    broadcast("resetPerformanceAdjustment");
  }

  function saveGlobalSettings() {
    if (!extensionStorage) return;
    const result = extensionStorage.set({
      [globalSettingsKey]: { mode: activeMode, quality: activeQuality, scale: outputScale }
    });
    result?.catch?.((error) => console.warn("[Anime4K] No se pudieron guardar los ajustes globales", error));
  }

  function saveSiteRecord() {
    if (!extensionStorage) return;
    if (!siteRecord) return;
    const snapshot = JSON.parse(JSON.stringify(siteRecord));
    const signature = stableStringify(snapshot);
    const pending = pendingOwnSiteWrites.get(signature) || { count: 0, timer: null };
    pending.count += 1;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => pendingOwnSiteWrites.delete(signature), 10000);
    pendingOwnSiteWrites.set(signature, pending);
    extensionStorage.set({ [siteStorageKey]: snapshot }).catch((error) => {
      const current = pendingOwnSiteWrites.get(signature);
      if (!current) return;
      current.count -= 1;
      if (current.count <= 0) {
        clearTimeout(current.timer);
        pendingOwnSiteWrites.delete(signature);
      }
      console.warn("[Anime4K] No se pudo guardar este sitio", error);
    });
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function consumeOwnSiteWriteEcho(value) {
    if (!value || typeof value !== "object") return false;
    const signature = stableStringify(value);
    const pending = pendingOwnSiteWrites.get(signature);
    if (!pending) return false;
    pending.count -= 1;
    if (pending.count <= 0) {
      clearTimeout(pending.timer);
      pendingOwnSiteWrites.delete(signature);
    }
    return true;
  }

  function getSwitchState(setting) {
    const properties = {
      enabled: "enabled",
      compare: "comparisonEnabled",
      compareLabels: "comparisonLabelsVisible",
      detail: "detailEnabled",
      sharpening: "sharpeningEnabled",
      lineMaskDebug: "lineMaskDebugEnabled",
      fluency: "fluencyEnabled",
    };
    const property = properties[setting];
    if (!siteActivated || !property) return false;
    if (setting === "enabled") return siteRecord?.enabled !== false;
    if (setting === "compareLabels") return siteRecord?.comparisonLabelsVisible !== false;
    return siteRecord?.[property] === true;
  }

  function applyGlobalSettings(saved = {}) {
    const previous = { mode: activeMode, quality: activeQuality, scale: outputScale };
    globalDefaults = {
      mode: ["A", "B", "C"].includes(saved.mode) ? saved.mode : "A",
      quality: ["Fast", "HQ", "Máxima"].includes(saved.quality) ? saved.quality : "Fast",
      scale: [1, 1.5, 2, "Auto"].includes(saved.scale) ? saved.scale : 1
    };
    if (!siteRecord?.mode || !["A", "B", "C"].includes(siteRecord.mode)) activeMode = globalDefaults.mode;
    if (!siteRecord?.quality || !["Fast", "HQ", "Máxima"].includes(siteRecord.quality)) activeQuality = globalDefaults.quality;
    if (![1, 1.5, 2, "Auto"].includes(siteRecord?.scale)) outputScale = globalDefaults.scale;
    const changes = {
      modeChanged: previous.mode !== activeMode,
      qualityChanged: previous.quality !== activeQuality,
      scaleChanged: previous.scale !== outputScale
    };
    if (Object.values(changes).some(Boolean)) broadcast("applySettings", changes);
  }

  function applySiteRecord(saved = null) {
    const wasActivated = siteActivated;
    const oldRecord = siteRecord || {};
    const previous = { enabled: overlayEnabled, comparisonEnabled, lineMaskDebugEnabled, panelManuallyHidden, panelMinimized, panelPosition, panelTab, fpsHudPosition, comparisonLabelsVisible, mode: activeMode, quality: activeQuality, scale: outputScale, detailEnabled, detailIntensity, detailSizeMode, sharpeningEnabled, sharpeningIntensity, lineEnhancementIntensity, fluencyEnabled, interpolationMode, fluencyControlMode, fluencyMultiplier, fluencyTarget };
    siteRecord = saved && typeof saved === "object" ? saved : null;
    const currentRecord = siteRecord;
    let removedLegacyOptions = false;
    if (currentRecord) {
      for (const key of ["debandingEnabled", "debandingIntensity", "noiseReductionEnabled", "noiseReductionIntensity", "liveHighEndEnabled", "aiAutoOnPause"]) {
        if (Object.prototype.hasOwnProperty.call(currentRecord, key)) { delete currentRecord[key]; removedLegacyOptions = true; }
      }
    }
    siteActivated = Boolean(currentRecord?.activated);
    overlayEnabled = siteActivated && currentRecord?.enabled !== false;
    comparisonEnabled = siteActivated && overlayEnabled && currentRecord?.comparisonEnabled === true;
    lineMaskDebugEnabled = siteActivated && currentRecord?.lineMaskDebugEnabled === true;
    if (!siteActivated) originalPreviewHeld = false;
    panelManuallyHidden = siteActivated && currentRecord?.panelManuallyHidden === true;
    panelPosition = siteActivated && Number.isFinite(currentRecord?.panelPosition?.x) && Number.isFinite(currentRecord?.panelPosition?.y)
      ? { x: currentRecord.panelPosition.x, y: currentRecord.panelPosition.y } : null;
    fpsHudPosition = siteActivated && Number.isFinite(currentRecord?.fpsHudPosition?.x) && Number.isFinite(currentRecord?.fpsHudPosition?.y)
      ? { x: currentRecord.fpsHudPosition.x, y: currentRecord.fpsHudPosition.y } : null;
    comparisonLabelsVisible = currentRecord?.comparisonLabelsVisible !== false;
    panelMinimized = siteActivated && currentRecord?.panelMinimized === true;
    fluencyEnabled = siteActivated && currentRecord?.fluencyEnabled === true;
    interpolationMode = currentRecord?.interpolationMode === "motion" ? "motion" : "mix";
    fluencyControlMode = currentRecord?.fluencyControlMode === "target" ? "target" : "multiplier";
    fluencyMultiplier = [2, 3, 4].includes(currentRecord?.fluencyMultiplier) ? currentRecord.fluencyMultiplier : 2;
    fluencyTarget = currentRecord?.fluencyTarget === "Auto" ? "Auto" : Number.isFinite(currentRecord?.fluencyTarget) ? Math.min(240, Math.max(24, currentRecord.fluencyTarget)) : 60;
    panelTab = ["image", "filters", "frames", "info"].includes(currentRecord?.panelTab) ? currentRecord.panelTab : "image";
    if (siteActivated) {
      if (!wasActivated || oldRecord.mode !== currentRecord?.mode) activeMode = ["A", "B", "C"].includes(currentRecord?.mode) ? currentRecord.mode : globalDefaults.mode;
      if (!wasActivated || oldRecord.quality !== currentRecord?.quality) activeQuality = ["Fast", "HQ", "Máxima"].includes(currentRecord?.quality) ? currentRecord.quality : globalDefaults.quality;
      if (!wasActivated || oldRecord.scale !== currentRecord?.scale) outputScale = [1, 1.5, 2, "Auto"].includes(currentRecord?.scale) ? currentRecord.scale : globalDefaults.scale;
      if (!wasActivated || oldRecord.detailEnabled !== currentRecord?.detailEnabled) detailEnabled = currentRecord?.detailEnabled === true;
      if (!wasActivated || oldRecord.detailIntensity !== currentRecord?.detailIntensity) detailIntensity = Number.isFinite(currentRecord?.detailIntensity) ? Math.min(1, Math.max(0, currentRecord.detailIntensity)) : 0.5;
      if (!wasActivated || oldRecord.detailSizeMode !== currentRecord?.detailSizeMode) detailSizeMode = ["Fino", "Medio", "Amplio"].includes(currentRecord?.detailSizeMode) ? currentRecord.detailSizeMode : "Medio";
      if (!wasActivated || oldRecord.sharpeningEnabled !== currentRecord?.sharpeningEnabled) sharpeningEnabled = currentRecord?.sharpeningEnabled === true;
      lineMaskDebugEnabled = siteActivated && sharpeningEnabled && currentRecord?.lineMaskDebugEnabled === true;
      if (!wasActivated || oldRecord.sharpeningIntensity !== currentRecord?.sharpeningIntensity) sharpeningIntensity = Number.isFinite(currentRecord?.sharpeningIntensity) ? Math.min(2, Math.max(0, currentRecord.sharpeningIntensity)) : 0.5;
      if (!wasActivated || oldRecord.lineEnhancementIntensity !== currentRecord?.lineEnhancementIntensity) lineEnhancementIntensity = Number.isFinite(currentRecord?.lineEnhancementIntensity) ? Math.min(1, Math.max(0, currentRecord.lineEnhancementIntensity)) : 0;
    } else {
      detailEnabled = false;
      detailIntensity = 0.5;
      detailSizeMode = "Medio";
      sharpeningEnabled = false;
      sharpeningIntensity = 0.5;
      lineEnhancementIntensity = 0;
      fluencyEnabled = false;
      interpolationMode = "mix";
      fluencyControlMode = "multiplier";
      fluencyMultiplier = 2;
      fluencyTarget = 60;
      panelTab = "image";
      comparisonEnabled = false;
      lineMaskDebugEnabled = false;
    }
    if (siteActivated && removedLegacyOptions) saveSiteRecord();
    if (wasActivated && !siteActivated) broadcast("deactivate");
    else if (!wasActivated && siteActivated) {
      scan(document);
      broadcast("settingsReady");
    }
    else if (siteActivated) {
      const changes = {
        enabledChanged: previous.enabled !== overlayEnabled,
        comparisonChanged: previous.comparisonEnabled !== comparisonEnabled,
        lineMaskDebugChanged: previous.lineMaskDebugEnabled !== lineMaskDebugEnabled,
        manualPanelChanged: previous.panelManuallyHidden !== panelManuallyHidden,
        panelMinimizedChanged: previous.panelMinimized !== panelMinimized,
        panelPositionChanged: JSON.stringify(previous.panelPosition) !== JSON.stringify(panelPosition),
        panelTabChanged: previous.panelTab !== panelTab,
        fpsHudPositionChanged: JSON.stringify(previous.fpsHudPosition) !== JSON.stringify(fpsHudPosition),
        comparisonLabelsChanged: previous.comparisonLabelsVisible !== comparisonLabelsVisible,
        modeChanged: previous.mode !== activeMode,
        qualityChanged: previous.quality !== activeQuality,
        scaleChanged: previous.scale !== outputScale,
        detailChanged: previous.detailEnabled !== detailEnabled,
        detailIntensityChanged: previous.detailIntensity !== detailIntensity,
        detailSizeChanged: previous.detailSizeMode !== detailSizeMode,
        sharpeningChanged: previous.sharpeningEnabled !== sharpeningEnabled,
        sharpeningIntensityChanged: previous.sharpeningIntensity !== sharpeningIntensity,
        lineEnhancementIntensityChanged: previous.lineEnhancementIntensity !== lineEnhancementIntensity,
        fluencyChanged: previous.fluencyEnabled !== fluencyEnabled,
        interpolationModeChanged: previous.interpolationMode !== interpolationMode,
        fluencyConfigChanged: previous.fluencyControlMode !== fluencyControlMode || previous.fluencyMultiplier !== fluencyMultiplier || previous.fluencyTarget !== fluencyTarget
      };
      if (Object.values(changes).some(Boolean)) broadcast("applySettings", changes);
    }
  }

  async function activateCurrentSite() {
    await storageReady;
    if (siteActivated) return;
    siteRecord = { activated: true, enabled: true, comparisonEnabled: false, comparisonLabelsVisible: true, lineMaskDebugEnabled: false, panelManuallyHidden: false, fluencyEnabled: false, interpolationMode: "mix", fluencyControlMode: "multiplier", fluencyMultiplier: 2, fluencyTarget: 60 };
    siteActivated = true;
    comparisonEnabled = false;
    overlayEnabled = true;
    panelManuallyHidden = false;
    activeMode = globalDefaults.mode;
    activeQuality = globalDefaults.quality;
    outputScale = globalDefaults.scale;
    detailEnabled = false;
    detailIntensity = 0.5;
    detailSizeMode = "Medio";
    sharpeningEnabled = false;
    sharpeningIntensity = 0.5;
    lineEnhancementIntensity = 0;
    fluencyEnabled = false;
    interpolationMode = "mix";
    fluencyControlMode = "multiplier";
    fluencyMultiplier = 2;
    fluencyTarget = 60;
    comparisonLabelsVisible = true;
    panelPosition = null;
    fpsHudPosition = null;
    saveSiteRecord();
    scan(document);
    broadcast("settingsReady");
  }

  function deactivateCurrentSite() {
    if (!siteActivated) return;
    siteActivated = false;
    comparisonEnabled = false;
    originalPreviewHeld = false;
    overlayEnabled = false;
    panelManuallyHidden = false;
    activeMode = globalDefaults.mode;
    activeQuality = globalDefaults.quality;
    outputScale = globalDefaults.scale;
    detailEnabled = false;
    detailIntensity = 0.5;
    detailSizeMode = "Medio";
    sharpeningEnabled = false;
    sharpeningIntensity = 0.5;
    lineEnhancementIntensity = 0;
    fluencyEnabled = false;
    interpolationMode = "mix";
    fluencyControlMode = "multiplier";
    fluencyMultiplier = 2;
    fluencyTarget = 60;
    comparisonLabelsVisible = true;
    panelPosition = null;
    fpsHudPosition = null;
    siteRecord = null;
    if (extensionStorage) extensionStorage.remove(siteStorageKey).catch((error) => console.warn("[Anime4K] No se pudo desactivar este sitio", error));
    broadcast("deactivate");
  }

  function chooseMode(mode, persist = true) {
    activeMode = mode;
    resetPerformanceAdjustment();
    broadcast("setMode", activeMode);
    if (persist) saveSitePreference({ mode: activeMode });
  }

  function chooseQuality(quality, persist = true) {
    activeQuality = quality;
    resetPerformanceAdjustment();
    broadcast("setQuality", activeQuality);
    if (persist) saveSitePreference({ quality: activeQuality });
  }

  function chooseScale(scale, persist = true) {
    outputScale = scale;
    resetPerformanceAdjustment();
    broadcast("setScale", outputScale, false);
    if (persist) saveSitePreference({ scale: outputScale });
  }

  function saveSitePreference(changes) {
    if (!siteActivated) return;
    siteRecord = { ...(siteRecord || {}), activated: true, enabled: overlayEnabled, panelManuallyHidden, ...changes };
    saveSiteRecord();
  }

  function chooseOptionalFilter(name, enabled, persist = true) {
    if (!siteActivated) return;
    sharpeningEnabled = Boolean(enabled);
    const debugDisabled = !enabled && lineMaskDebugEnabled;
    if (debugDisabled) lineMaskDebugEnabled = false;
    if (persist) saveSitePreference({ sharpeningEnabled: enabled, ...(debugDisabled ? { lineMaskDebugEnabled: false } : {}) });
    if (debugDisabled) broadcast("setLineMaskDebug", false);
    broadcast("setSharpening", enabled, sharpeningIntensity);
  }

  function chooseOptionalFilterIntensity(name, intensity, persist = false) {
    if (!siteActivated) return;
    const value = Math.min(2, Math.max(0, Number(intensity)));
    sharpeningIntensity = value;
    broadcast("setSharpeningIntensity", value);
    if (persist) saveSitePreference({ sharpeningIntensity: value });
  }

  function chooseDetail(enabled, persist = true) {
    if (!siteActivated) return;
    detailEnabled = Boolean(enabled);
    if (persist) saveSitePreference({ detailEnabled });
    broadcast("setDetail", detailEnabled);
  }

  function chooseDetailIntensity(intensity, persist = false) {
    if (!siteActivated) return;
    detailIntensity = Math.min(1, Math.max(0, Number(intensity)));
    broadcast("setDetailIntensity", detailIntensity);
    if (persist) saveSitePreference({ detailIntensity });
  }

  function chooseDetailSize(size, persist = true) {
    if (!siteActivated || !["Fino", "Medio", "Amplio"].includes(size)) return;
    detailSizeMode = size;
    if (persist) saveSitePreference({ detailSizeMode });
    broadcast("setDetailSize", detailSizeMode);
  }

  function detailRadiusPixels(size = detailSizeMode) {
    return size === "Fino" ? 3 : size === "Amplio" ? 12 : 6;
  }

  function chooseLineEnhancementIntensity(intensity, persist = false) {
    if (!siteActivated) return;
    lineEnhancementIntensity = Math.min(1, Math.max(0, Number(intensity)));
    broadcast("setLineEnhancementIntensity", lineEnhancementIntensity);
    if (persist) saveSitePreference({ lineEnhancementIntensity });
  }

  function chooseLineMaskDebug(enabled, persist = true) {
    if (!siteActivated || !sharpeningEnabled) return;
    lineMaskDebugEnabled = Boolean(enabled);
    if (persist) saveSitePreference({ lineMaskDebugEnabled });
    broadcast("setLineMaskDebug", lineMaskDebugEnabled);
  }

  function chooseFluency(enabled, persist = true) {
    if (!siteActivated) return;
    fluencyEnabled = Boolean(enabled);
    if (persist) saveSitePreference({ fluencyEnabled });
    broadcast("setFluency", fluencyEnabled, interpolationMode, fluencyControlMode, fluencyMultiplier, fluencyTarget);
  }

  function chooseInterpolationMode(mode, persist = true) {
    if (!siteActivated || !["mix", "motion"].includes(mode)) return;
    interpolationMode = mode;
    broadcast("setFluency", fluencyEnabled, interpolationMode, fluencyControlMode, fluencyMultiplier, fluencyTarget);
    if (persist) saveSitePreference({ interpolationMode });
  }

  function chooseFluencyControlMode(value, persist = true) {
    if (!siteActivated || !["multiplier", "target"].includes(value)) return;
    fluencyControlMode = value;
    broadcast("setFluency", fluencyEnabled, interpolationMode, fluencyControlMode, fluencyMultiplier, fluencyTarget);
    if (persist) saveSitePreference({ fluencyControlMode });
  }

  function chooseFluencyMultiplier(value, persist = true) {
    if (!siteActivated || ![2, 3, 4].includes(value)) return;
    fluencyMultiplier = value;
    broadcast("setFluency", fluencyEnabled, interpolationMode, fluencyControlMode, fluencyMultiplier, fluencyTarget);
    if (persist) saveSitePreference({ fluencyMultiplier });
  }

  function chooseFluencyTarget(value, persist = true) {
    if (!siteActivated || !(value === "Auto" || (Number.isFinite(value) && value >= 24 && value <= 240))) return;
    fluencyTarget = value === "Auto" ? "Auto" : Number(value);
    broadcast("setFluency", fluencyEnabled, interpolationMode, fluencyControlMode, fluencyMultiplier, fluencyTarget);
    if (persist) saveSitePreference({ fluencyTarget });
  }

  function chooseEnabled(enabled, persist = true) {
    if (!siteActivated) return;
    overlayEnabled = Boolean(enabled);
    if (!enabled && comparisonEnabled) chooseComparison(false);
    if (persist) {
      siteRecord = { ...(siteRecord || {}), activated: true, enabled: overlayEnabled, panelManuallyHidden };
      saveSiteRecord();
    }
    broadcast("setEnabled", overlayEnabled);
  }

  function chooseComparison(enabled) {
    if (!siteActivated || (enabled && !overlayEnabled)) return;
    comparisonEnabled = Boolean(enabled);
    saveSitePreference({ comparisonEnabled });
    broadcast("setComparison", comparisonEnabled);
  }

  function chooseComparisonLabels(visible) {
    if (!siteActivated) return;
    comparisonLabelsVisible = Boolean(visible);
    saveSitePreference({ comparisonLabelsVisible });
    broadcast("setComparisonLabels", comparisonLabelsVisible);
  }

  function choosePanelPosition(position) {
    if (!siteActivated) return;
    panelPosition = position && Number.isFinite(position.x) && Number.isFinite(position.y)
      ? { x: Math.max(0, position.x), y: Math.max(0, position.y) } : null;
    broadcast("setPanelPosition", panelPosition);
    saveSitePreference({ panelPosition });
  }

  function resetPanelPosition() {
    if (!siteActivated) return;
    panelPosition = null;
    if (siteRecord) {
      delete siteRecord.panelPosition;
      saveSiteRecord();
    }
    broadcast("setPanelPosition", null);
  }

  function chooseFpsHudPosition(position) {
    if (!siteActivated) return;
    fpsHudPosition = position && Number.isFinite(position.x) && Number.isFinite(position.y)
      ? { x: Math.max(0, position.x), y: Math.max(0, position.y) } : null;
    broadcast("setFpsHudPosition", fpsHudPosition);
    saveSitePreference({ fpsHudPosition });
  }

  function setPanelManuallyHidden(hidden, persist = true) {
    if (!siteActivated) return;
    panelManuallyHidden = hidden;
    broadcast("setPanelManuallyHidden", panelManuallyHidden);
    if (persist) {
      siteRecord = { ...(siteRecord || {}), activated: true, enabled: overlayEnabled, panelManuallyHidden };
      saveSiteRecord();
    }
  }

  function togglePanelWithF1() {
    if (!siteActivated) {
      void activateCurrentSite();
      return;
    }
    const anyPanelVisible = [...diagnostics].some((diagnostic) => diagnostic.isPanelVisible?.());
    // F1 oculta persistentemente un panel visible; si ya está oculto,
    // vuelve al modo automático y lo muestra.
    setPanelManuallyHidden(!panelManuallyHidden && anyPanelVisible);
  }

  if (extensionStorage) {
    extensionStorage.get(null).then((stored) => {
      const obsoleteCleanup = {};
      for (const [key, value] of Object.entries(stored || {})) {
        if (!value || typeof value !== "object" || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, "autoQualityEnabled")) continue;
        const cleaned = { ...value };
        delete cleaned.autoQualityEnabled;
        stored[key] = cleaned;
        obsoleteCleanup[key] = cleaned;
      }
      if (Object.keys(obsoleteCleanup).length) {
        extensionStorage.set(obsoleteCleanup).catch((error) => console.warn("[Anime4K] No se pudo limpiar el ajuste obsoleto de calidad automática", error));
      }
      applyShortcuts(stored?.[shortcutsStorageKey]);
      const migratedGlobalSettings = stored?.[globalSettingsKey] || stored?.[legacySettingsKey] || {};
      applyGlobalSettings(migratedGlobalSettings);
      if (!stored?.[globalSettingsKey] && stored?.[legacySettingsKey]) saveGlobalSettings();
      settingsLoaded = true;
      applySiteRecord(stored?.[siteStorageKey] || null);
      storageReadyResolve();
      if (siteActivated) broadcast("settingsReady");
    }).catch((error) => {
      console.warn("[Anime4K] No se pudieron leer las preferencias guardadas", error);
      settingsLoaded = true;
      storageReadyResolve();
    });
    globalThis.chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[shortcutsStorageKey]) applyShortcuts(changes[shortcutsStorageKey].newValue || {});
      if (changes[globalSettingsKey]?.newValue) applyGlobalSettings(changes[globalSettingsKey].newValue);
      if (changes[siteStorageKey]) {
        const nextRecord = changes[siteStorageKey].newValue || null;
        if (!consumeOwnSiteWriteEcho(nextRecord)) applySiteRecord(nextRecord);
      }
    });
  } else {
    settingsLoaded = true;
    storageReadyResolve();
  }

  function editableTarget(target) {
    return target instanceof Element && (
      target.isContentEditable ||
      target.matches("input, textarea, select, [role='textbox']")
    );
  }

  function handleKeydown(event) {
    const pressedKey = normalizeShortcutKey(event.key);
    if (pressedKey === shortcuts.togglePanel) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) togglePanelWithF1();
      return;
    }
    if (!siteActivated) return;
    if (pressedKey === shortcuts.fpsHud) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat && !editableTarget(event.target)) broadcast("toggleFpsHud");
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || editableTarget(event.target)) return;
    if (pressedKey === "v") {
      originalPreviewHeld = true;
      broadcast("setOriginalPreview", true);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (pressedKey === shortcuts.compare) {
      chooseComparison(!comparisonEnabled);
      event.preventDefault();
      event.stopPropagation();
    } else if (pressedKey === shortcuts.fluency) {
      chooseFluency(!fluencyEnabled);
      event.preventDefault();
      event.stopPropagation();
    } else if (pressedKey === shortcuts.aiImprove) {
      broadcast("improveAiFrame");
      event.preventDefault();
      event.stopPropagation();
    } else if (pressedKey === shortcuts.stats) {
      broadcast("toggleStats");
      console.info(`[Anime4K diagnóstico] Estadísticas alternadas con ${shortcuts.stats}`);
    } else if (pressedKey === "a") {
      chooseEnabled(!overlayEnabled);
      console.info(`[Anime4K diagnóstico] Canvas ${overlayEnabled ? "activado" : "desactivado"} con la tecla A`);
    } else if (pressedKey === shortcuts.modeA) {
      chooseMode("A");
      console.info(`[Anime4K diagnóstico] Modo ${activeMode}`);
    } else if (pressedKey === shortcuts.modeB) {
      chooseMode("B");
      console.info(`[Anime4K diagnóstico] Modo ${activeMode}`);
    } else if (pressedKey === shortcuts.modeC) {
      chooseMode("C");
      console.info(`[Anime4K diagnóstico] Modo ${activeMode}`);
    } else if (pressedKey === shortcuts.quality) {
      chooseQuality(activeQuality === "Fast" ? "HQ" : "Fast");
      console.info(`[Anime4K diagnóstico] Calidad ${activeQuality} (${shortcuts.quality})`);
    } else if (pressedKey === shortcuts.scale) {
      chooseScale(outputScale === 1 ? 1.5 : outputScale === 1.5 ? 2 : outputScale === 2 ? "Auto" : 1);
      console.info(`[Anime4K diagnóstico] Escala de salida ${outputScale === "Auto" ? "Auto" : `${outputScale}×`} (${shortcuts.scale})`);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }
  document.addEventListener("keydown", handleKeydown, true);

  function handleKeyup(event) {
    if (!siteActivated || normalizeShortcutKey(event.key) !== "v" || !originalPreviewHeld) return;
    originalPreviewHeld = false;
    broadcast("setOriginalPreview", false);
    event.preventDefault();
    event.stopPropagation();
  }
  document.addEventListener("keyup", handleKeyup, true);
  window.addEventListener("blur", () => {
    if (!originalPreviewHeld) return;
    originalPreviewHeld = false;
    broadcast("setOriginalPreview", false);
  });

  function addDiagnostic(video) {
    if (running.has(video)) return;
    running.add(video);
    let diagnosticController = null;
    let sizeObserver = null;
    let playerMutationObserver = null;
    let positionTimer = null;

    const canvas = document.createElement("canvas");
    const aiResultCanvas = document.createElement("canvas");
    aiResultCanvas.width = 0;
    aiResultCanvas.height = 0;
    const uiHost = document.createElement("div");
    const compareHost = document.createElement("div");
    const shadow = uiHost.attachShadow({ mode: "open" });
    const compareShadow = compareHost.attachShadow({ mode: "open" });
    const playerContainer = video.parentElement || document.documentElement;
    let uiParent = playerContainer;
    const changedUiParentPositions = new Map();
    makeRelativeIfNeeded(playerContainer);

    Object.assign(canvas.style, {
      position: "absolute", display: "none", pointerEvents: "none",
      zIndex: "1", objectFit: "fill"
    });
    Object.assign(uiHost.style, {
      position: "absolute", display: "none", pointerEvents: "none",
      zIndex: "1", overflow: "visible"
    });
    Object.assign(compareHost.style, {
      position: "absolute", display: "none", pointerEvents: "none",
      zIndex: "1", overflow: "visible"
    });
    compareShadow.innerHTML = `
      <style>

        :host { all: initial; display:block; pointer-events:none; --ak-bg:#120f1d; --ak-surface:#211a30; --ak-surface-raised:#2c2340; --ak-text:#fbf9ff; --ak-muted:#c0b6d2; --ak-accent:#4fd1c5; --ak-gold:#f6c453; --ak-danger:#f28e9d; --ak-line:rgba(218,201,255,.18); --ak-radius:14px; --ak-control-radius:10px; --ak-chip-radius:999px; --ak-shadow:0 18px 52px rgba(4,2,12,.62); --ak-font:Inter,system-ui,"Segoe UI",sans-serif; }
        #compare-visuals { position:absolute; inset:0; overflow:hidden; pointer-events:none; }
        #divider-line { position:absolute; top:0; bottom:0; width:1px; transform:translateX(-50%); background:rgba(255,255,255,.78); box-shadow:0 0 0 1px rgba(79,209,197,.35),0 0 9px rgba(0,0,0,.75); pointer-events:none; }
        #divider-grip { position:absolute; top:50%; width:28px; height:46px; transform:translate(-50%,-50%); border:1px solid rgba(255,255,255,.56); border-radius:12px; color:var(--ak-text); background:rgba(18,15,29,.9); box-shadow:0 5px 18px rgba(0,0,0,.4); cursor:ew-resize; pointer-events:auto; touch-action:none; display:grid; place-items:center; transition:transform .18s ease,opacity .18s ease; }
        #divider-grip::after { content:"↔"; color:var(--ak-accent); font:600 13px/1 var(--ak-font); }
        #divider-grip:hover { transform:translate(-50%,-50%) scale(1.06); }
        .compare-label { position:absolute; box-sizing:border-box; max-width:calc(50% - 24px); overflow:hidden; padding:7px 12px; border:1px solid rgba(228,216,255,.34); border-radius:var(--ak-chip-radius); color:var(--ak-text); background:rgba(18,15,29,.88); box-shadow:0 5px 18px rgba(0,0,0,.42); text-shadow:0 1px 4px #090711; font:600 13px/1.2 var(--ak-font); letter-spacing:.02em; white-space:nowrap; text-overflow:ellipsis; pointer-events:none; }
        .compare-label::before { content:""; display:inline-block; width:7px; height:7px; margin:0 7px 1px 0; border-radius:50%; vertical-align:middle; background:var(--ak-accent); box-shadow:0 0 8px rgba(79,209,197,.45); }
        #original-label::before { background:#e5d8ff; box-shadow:0 0 8px rgba(229,216,255,.45); }
        #anime-label { border-color:rgba(79,209,197,.42); }
        #compare-visuals.labels-hidden .compare-label { display:none; }
        @media (prefers-reduced-motion:reduce) { #divider-grip { transition:none; } }
      </style>
      <div id="compare-visuals" aria-hidden="true"><span id="original-label" class="compare-label">Original</span><span id="anime-label" class="compare-label">Anime4K</span><div id="divider-line"></div><button id="divider-grip" type="button" tabindex="-1" aria-label="Arrastrar divisoria de comparación"></button></div>`;
    shadow.innerHTML = `
      <style>

        :host { all:initial; display:block; pointer-events:none; color-scheme:dark; --ak-bg:#120f1d; --ak-surface:#211a30; --ak-surface-raised:#2c2340; --ak-text:#fbf9ff; --ak-muted:#c0b6d2; --ak-accent:#4fd1c5; --ak-accent-soft:rgba(79,209,197,.14); --ak-gold:#f6c453; --ak-danger:#f28e9d; --ak-line:rgba(218,201,255,.18); --ak-line-bright:rgba(79,209,197,.35); --ak-radius:14px; --ak-control-radius:10px; --ak-chip-radius:999px; --ak-shadow:0 18px 52px rgba(4,2,12,.62); --ak-font:Inter,system-ui,"Segoe UI",sans-serif; }
        #panel,#panel * ,#panel *::before,#panel *::after { box-sizing:border-box; }
        #panel { position:absolute; top:10px; left:10px; width:min(330px,calc(100% - 20px)); max-height:min(510px,calc(100% - 20px)); overflow-x:hidden; overflow-y:hidden; min-width:0; padding:12px 16px; border:1px solid transparent; border-radius:var(--ak-radius); color:var(--ak-text); background:linear-gradient(var(--ak-bg),var(--ak-bg)) padding-box,linear-gradient(135deg,rgba(79,209,197,.46),rgba(152,112,226,.22),rgba(246,196,83,.12)) border-box; box-shadow:var(--ak-shadow); backdrop-filter:blur(18px) saturate(140%); -webkit-backdrop-filter:blur(18px) saturate(140%); font:13px/1.45 var(--ak-font); pointer-events:auto; cursor:grab; user-select:none; opacity:1; visibility:visible; transform:translateY(0) scale(1); transition:opacity .2s ease,transform .2s cubic-bezier(.2,.75,.3,1),visibility .2s; display:flex; flex-direction:column; gap:8px; }
        #panel::before { content:""; position:absolute; z-index:2; top:0; left:14px; right:14px; height:1px; background:linear-gradient(90deg,transparent,rgba(143,255,241,.52),rgba(210,173,255,.24),transparent); opacity:.65; pointer-events:none; }
        #panel[data-corner="top-right"] { left:auto; right:10px; top:10px; } #panel[data-corner="bottom-left"] { left:10px; right:auto; top:auto; bottom:10px; } #panel[data-corner="bottom-right"] { left:auto; right:10px; top:auto; bottom:10px; } #panel[data-positioned="true"] { right:auto; bottom:auto; }
        #panel.is-hidden { opacity:0; visibility:hidden; transform:translateY(-8px) scale(.98); pointer-events:none; backdrop-filter:none; -webkit-backdrop-filter:none; }
        #panel[data-dragging="true"] { cursor:grabbing; }
        header { min-height:42px; display:flex; align-items:center; gap:10px; padding:0 1px 11px; border-bottom:1px solid var(--ak-line); cursor:grab; touch-action:none; user-select:none; }
        header:active,header[data-dragging="true"] { cursor:grabbing; }
        #brand-mark { display:grid; place-items:center; width:34px; height:34px; flex:none; overflow:hidden; border:1px solid rgba(218,201,255,.22); border-radius:11px; background:linear-gradient(145deg,rgba(255,255,255,.12),rgba(255,255,255,.025)); transition:transform .2s ease; }
        #brand-mark img { width:28px; height:28px; object-fit:contain; pointer-events:none; }
        #panel[data-enabled="true"] #brand-mark { border-color:rgba(79,209,197,.68); box-shadow:0 0 0 2px rgba(79,209,197,.11),0 0 16px rgba(79,209,197,.14); }
        header strong { font-size:14px; font-weight:600; letter-spacing:.01em; pointer-events:none; }
        #status-dot { display:none; }
        #status-state { display:inline-flex; align-items:center; gap:6px; margin-left:auto; padding:4px 9px; border:1px solid rgba(192,182,210,.2); border-radius:var(--ak-chip-radius); color:#d1cadb; background:rgba(255,255,255,.045); font-size:11px; font-weight:600; white-space:nowrap; }
        #status-state::before { content:""; width:6px; height:6px; border-radius:50%; background:#898198; }
        #status-state::after { content:"Apagado"; }
        #panel[data-enabled="true"] #status-state { border-color:rgba(79,209,197,.4); color:#a9fff5; background:rgba(79,209,197,.1); }
        #panel[data-enabled="true"] #status-state::before { background:var(--ak-accent); }
        #panel[data-enabled="true"] #status-state::after { content:"Activo"; }
        #panel:not(.is-hidden)[data-enabled="true"] #status-state::before { animation:ak-status-pulse 2.3s ease-in-out infinite; }
        @keyframes ak-status-pulse { 50% { opacity:.42; } }
        #dismiss { width:30px; min-width:30px; height:30px; display:grid; place-items:center; flex:none; padding:0; border:1px solid var(--ak-line); border-radius:9px; color:#eee7f7; background:rgba(255,255,255,.045); cursor:pointer; font:20px/1 var(--ak-font); transition:transform .18s ease,opacity .18s ease; }
        #dismiss:hover { transform:rotate(90deg); }
        #tabs { position:relative; display:grid; flex:none; grid-template-columns:repeat(4,minmax(0,1fr)); gap:6px; width:100%; min-width:0; padding:4px; border:1px solid rgba(218,201,255,.13); border-radius:12px; background:rgba(5,3,12,.4); isolation:isolate; }
        #tabs .tab-indicator { position:absolute; z-index:-1; top:4px; bottom:4px; left:4px; width:calc((100% - 8px - 18px)/4); border:1px solid rgba(79,209,197,.37); border-radius:9px; background:linear-gradient(135deg,rgba(79,209,197,.2),rgba(79,209,197,.1)); box-shadow:0 0 16px rgba(79,209,197,.12),inset 0 1px rgba(255,255,255,.12); transform:translateX(0); transition:transform .22s cubic-bezier(.2,.75,.3,1),opacity .15s ease; pointer-events:none; }
        #tabs:has([data-tab="filters"][aria-selected="true"]) .tab-indicator { transform:translateX(calc(100% + 6px)); }
        #tabs:has([data-tab="frames"][aria-selected="true"]) .tab-indicator { transform:translateX(calc(200% + 12px)); }
        #tabs:has([data-tab="info"][aria-selected="true"]) .tab-indicator { transform:translateX(calc(300% + 18px)); }
        #tabs button { position:relative; z-index:1; display:flex; min-width:0; height:35px; align-items:center; justify-content:center; gap:0; border:0; border-radius:9px; padding:4px 0; color:#c9bfd9; background:transparent; cursor:pointer; font:600 10px/1.1 var(--ak-font); white-space:nowrap; transition:transform .18s ease; }
        #tabs button span { display:inline; }
        #tabs svg { display:none; }
        #tabs button[aria-selected="true"] { color:#eafffd; }
        #tabs button:hover { color:#fff; }
        #tabs svg { width:15px; height:15px; flex:none; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
        #tab-content { position:relative; flex:0 1 auto; width:100%; min-width:0; min-height:0; max-height:min(70vh,520px); overflow-x:hidden; overflow-y:auto; overscroll-behavior:contain; scrollbar-gutter:stable; scrollbar-width:thin; scrollbar-color:rgba(79,209,197,.32) transparent; }
        #tab-content::-webkit-scrollbar { width:6px; }
        #tab-content::-webkit-scrollbar-track { background:transparent; }
        #tab-content::-webkit-scrollbar-thumb { border-radius:999px; background:rgba(79,209,197,.28); }
        #tab-content::-webkit-scrollbar-thumb:hover { background:rgba(79,209,197,.62); }
        #tab-content::after { content:""; position:sticky; z-index:3; bottom:0; display:block; height:14px; margin-top:-14px; background:linear-gradient(to bottom,transparent,rgba(12,24,37,.28)); opacity:1; pointer-events:none; transition:opacity .16s ease; }
        #tab-content[data-scroll-end="true"]::after { opacity:0; }
        #frame-stats { flex:none; }
        .tab-page { position:absolute; inset:0; width:100%; min-width:0; overflow:visible; padding:1px 3px 5px; opacity:0; visibility:hidden; transform:translateY(4px); transition:opacity .15s ease,transform .15s ease,visibility .15s; }
        .tab-page.is-active { position:relative; inset:auto; height:auto; max-height:none; min-height:0; overflow:visible; opacity:1; visibility:visible; transform:translateY(0); animation:ak-page-in .15s ease both; }
        .tab-page[hidden],.intensity-setting[hidden] { display:none!important; }
        @keyframes ak-page-in { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
        .tab-page.is-active .setting { animation:ak-row-in .18s ease both; }
        .tab-page.is-active .setting:nth-child(2) { animation-delay:30ms; }
        .tab-page.is-active .setting:nth-child(3) { animation-delay:60ms; }
        .tab-page.is-active .setting:nth-child(4) { animation-delay:90ms; }
        .tab-page.is-active .setting:nth-child(5) { animation-delay:120ms; }
        @keyframes ak-row-in { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
        .card { margin:0; padding:0; border:0; border-radius:0; background:transparent; }
        .card + .card { margin-top:15px; padding-top:13px; border-top:1px solid var(--ak-line); }
        .card-title { display:flex; align-items:center; gap:7px; margin:1px 0 9px; color:#c8bed8; font-size:11px; font-weight:600; letter-spacing:.025em; }
        .card-title::before { content:"✦"; color:var(--ak-accent); font-size:12px; }
        .setting { display:grid; grid-template-columns:max-content minmax(0,1fr); align-items:center; gap:8px; width:100%; min-width:0; min-height:36px; margin:6px 0; box-sizing:border-box; }
        .setting:has(> .label + .segments[data-setting="quality"]) { grid-template-columns:minmax(0,1fr); align-items:start; gap:4px; }
        .setting:has(> .label + .segments[data-setting="quality"]) > .segments { width:100%; }
        .setting > .label { width:max-content; max-width:100%; min-width:0; }
        .setting > .segments { width:100%; min-width:0; }
        .setting > [role="switch"] { flex:none; width:40px; min-width:40px; max-width:40px; height:22px; margin-left:auto; justify-self:end; }
        .setting:has(> [role="switch"]) { grid-template-columns:max-content minmax(0,1fr); }
        .setting:last-child { margin-bottom:1px; }
        .label { display:flex; align-items:center; gap:6px; min-width:0; color:#f1edf7; font-size:13px; font-weight:500; white-space:nowrap; }
        kbd { display:inline-flex; min-width:20px; height:19px; align-items:center; justify-content:center; padding:1px 6px; border:1px solid rgba(218,201,255,.22); border-bottom-color:rgba(218,201,255,.34); border-radius:6px; color:#d8cde8; background:rgba(255,255,255,.055); box-shadow:0 1px 0 rgba(0,0,0,.25); font:600 10px/1 var(--ak-font); font-variant-numeric:tabular-nums; }
        .segments { position:relative; display:flex; width:100%; min-width:0; height:36px; box-sizing:border-box; gap:3px; padding:3px; border:1px solid rgba(218,201,255,.17); border-radius:11px; background:rgba(6,4,13,.38); isolation:isolate; }
        .segments::before { content:""; position:absolute; z-index:-1; top:3px; bottom:3px; left:3px; width:calc((100% - 6px - 9px)/4); border:1px solid rgba(79,209,197,.22); border-radius:8px; background:rgba(79,209,197,.14); box-shadow:0 0 12px rgba(79,209,197,.08); transform:translateX(0); transition:transform .22s cubic-bezier(.2,.75,.3,1),opacity .16s ease; pointer-events:none; }
        .segments:has(button:first-child[aria-pressed="true"])::before { transform:translateX(0); }
        .segments:has(button:nth-child(2)[aria-pressed="true"])::before { transform:translateX(calc(100% + 3px)); }
        .segments:has(button:nth-child(3)[aria-pressed="true"])::before { transform:translateX(calc(200% + 6px)); }
        .segments:has(button:nth-child(4)[aria-pressed="true"])::before { transform:translateX(calc(300% + 9px)); }
        .segments:has(>button:nth-child(2):last-child)::before { width:calc((100% - 9px)/2); }
        .segments:has(>button:nth-child(3):last-child)::before { width:calc((100% - 12px)/3); }
        .segments button { position:relative; z-index:1; display:flex; flex:1 1 0; width:auto; min-width:0; height:28px; align-items:center; justify-content:center; gap:4px; border:0; border-radius:8px; padding:3px 2px; color:#ded7e8; background:transparent; cursor:pointer; font:600 13px/1.15 var(--ak-font); font-variant-numeric:tabular-nums; white-space:nowrap; transition:transform .18s ease; }
        .segments button[aria-pressed="true"] { color:#f4fffe; }
        .segments button:hover { color:#fff; }
        .segments button kbd { border:0; background:rgba(0,0,0,.2); }
        .segments[data-setting="scale"] { min-width:0; }
        .segments[data-setting="scale"] button { padding-inline:1px; }
        .switch { appearance:none!important; -webkit-appearance:none!important; position:relative; justify-self:end; flex:none; width:40px; min-width:40px; max-width:40px; height:22px; overflow:hidden; padding:0!important; border:1px solid rgba(218,201,255,.21)!important; border-radius:var(--ak-chip-radius)!important; background:#40384d!important; cursor:pointer!important; transition:background-color .2s ease,border-color .2s ease,box-shadow .2s ease!important; }
        .switch::before { content:""; position:absolute; inset:0; border-radius:inherit; background:linear-gradient(110deg,#49bfb9,#4fd1c5); opacity:0; transition:opacity .2s ease; }
        .switch::after { content:""; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:linear-gradient(155deg,#fff,#e5e0eb); box-shadow:0 2px 6px rgba(0,0,0,.42); transform:translateX(0) scaleX(1); transition:transform .2s cubic-bezier(.3,.7,.4,1); }
        .switch[aria-checked="true"] { border-color:rgba(79,209,197,.78)!important; box-shadow:0 0 15px rgba(79,209,197,.13)!important; }
        .switch[aria-checked="true"]::before { opacity:1; }
        .switch[aria-checked="true"]::after { transform:translateX(18px) scaleX(1.04); }
        .switch:active::after { transform:translateX(0) scaleX(1.13); }
        .switch[aria-checked="true"]:active::after { transform:translateX(18px) scaleX(1.13); }
        .intensity-setting { display:grid; grid-template-columns:minmax(72px,96px) minmax(0,1fr) auto; align-items:center; gap:9px; min-height:34px; margin:5px 0 8px; color:#eae4f1; font:12px var(--ak-font); }
        .intensity-setting input[type="range"] { width:100%; min-width:0; height:22px; margin:0; appearance:none; background:transparent; cursor:pointer; }
        .intensity-setting input[type="range"]::-webkit-slider-runnable-track { height:4px; border-radius:99px; background:linear-gradient(90deg,#9071d9,var(--ak-accent)); }
        .intensity-setting input[type="range"]::-moz-range-track { height:4px; border-radius:99px; background:linear-gradient(90deg,#9071d9,var(--ak-accent)); }
        .intensity-setting input[type="range"]::-webkit-slider-thumb { width:14px; height:14px; margin-top:-5px; appearance:none; border:2px solid #f7fffe; border-radius:50%; background:#61dcd0; box-shadow:0 1px 7px rgba(0,0,0,.45),0 0 0 0 rgba(79,209,197,.2); transition:transform .16s ease; }
        .intensity-setting input[type="range"]::-moz-range-thumb { width:11px; height:11px; border:2px solid #f7fffe; border-radius:50%; background:#61dcd0; box-shadow:0 1px 7px rgba(0,0,0,.45); transition:transform .16s ease; }
        .intensity-setting input[type="range"]:active::-webkit-slider-thumb { transform:scale(1.15); box-shadow:0 1px 7px rgba(0,0,0,.45),0 0 0 6px rgba(79,209,197,.14); }
        .intensity-setting input[type="range"]:active::-moz-range-thumb { transform:scale(1.15); box-shadow:0 1px 7px rgba(0,0,0,.45),0 0 0 6px rgba(79,209,197,.14); }
        .intensity-setting output { min-width:37px; padding:4px 7px; border:1px solid rgba(218,201,255,.16); border-radius:var(--ak-chip-radius); color:#d9fff9; background:rgba(79,209,197,.08); text-align:center; font:600 10px/1.1 var(--ak-font); font-variant-numeric:tabular-nums; transition:transform .16s ease,opacity .16s ease; }
        .intensity-setting:has(input[type="range"]:active) output { transform:scale(1.06); }
        .intensity-setting[hidden] { display:none!important; }
        details { margin:10px 0 0; padding-top:10px; border-top:1px solid var(--ak-line); }
        summary { color:#eee7f6; cursor:pointer; font-size:12px; font-weight:600; transition:none; }
        summary:hover { color:var(--ak-accent); }
        #fluency-note,.muted-hint { color:var(--ak-muted); font-size:11px; }
        .setting.is-disabled { opacity:.42; pointer-events:none; }
        button:focus-visible,input:focus-visible,summary:focus-visible { outline:2px solid var(--ak-accent); outline-offset:3px; }
        #stats { max-height:242px; margin:8px 0 0; padding:10px; border:1px solid rgba(218,201,255,.15); border-radius:11px; color:#f7f4fc; background:rgba(8,5,15,.42); white-space:pre-wrap; overflow-wrap:anywhere; overflow:auto; font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; font-variant-numeric:tabular-nums; }
        #stats.warn { color:#ffb4bc; border-color:rgba(242,142,157,.42); }
        #ui-tooltip { position:absolute; z-index:20; max-width:min(270px,calc(100% - 16px)); padding:8px 10px; border:1px solid rgba(218,201,255,.24); border-radius:9px; color:var(--ak-text); background:#211a30; box-shadow:0 8px 24px rgba(0,0,0,.5); font:12px/1.4 var(--ak-font); pointer-events:none; }
        #ui-tooltip::after { content:""; position:absolute; left:14px; bottom:-5px; width:8px; height:8px; border-right:1px solid rgba(218,201,255,.24); border-bottom:1px solid rgba(218,201,255,.24); background:#211a30; transform:rotate(45deg); }
        #ui-tooltip[hidden] { display:none!important; }
        #ui-toast { position:absolute; z-index:21; left:50%; bottom:10px; max-width:calc(100% - 24px); padding:9px 13px; border:1px solid rgba(79,209,197,.42); border-radius:var(--ak-chip-radius); color:var(--ak-text); background:#211a30; box-shadow:0 8px 24px rgba(0,0,0,.42); font:600 12px/1.35 var(--ak-font); text-align:center; pointer-events:none; opacity:0; transform:translate(-50%,7px); }
        #ui-toast.is-visible { opacity:1; transform:translate(-50%,0); transition:opacity .18s ease,transform .18s ease; }
        #ui-toast.is-leaving { opacity:0; transform:translate(-50%,5px); transition:opacity .18s ease,transform .18s ease; }
        #ui-toast[hidden] { display:none!important; }
        .info-actions { display:grid; gap:8px; margin-top:12px; }
        #recommended-preset { position:relative; overflow:hidden; height:36px; padding:5px 10px; border:1px solid rgba(246,196,83,.62); border-radius:10px; color:#ffe7a9; background:rgba(246,196,83,.13); cursor:pointer; font:600 13px var(--ak-font); transition:transform .18s ease,opacity .18s ease; }
        #recommended-preset::after { content:""; position:absolute; top:-30%; bottom:-30%; left:-45%; width:28%; background:linear-gradient(90deg,transparent,rgba(255,239,185,.28),transparent); opacity:0; transform:skewX(-18deg); }
        #recommended-preset:hover { transform:translateY(-1px); }
        #recommended-preset:hover::after { opacity:1; transform:translateX(520%) skewX(-18deg); transition:transform .62s ease,opacity .12s ease; }
        #save-preset,#reset-site { min-height:35px; padding:5px 9px; border:1px solid rgba(218,201,255,.23); border-radius:10px; color:#f0ebf6; background:rgba(255,255,255,.035); cursor:pointer; font:500 12px var(--ak-font); transition:transform .18s ease,opacity .18s ease; }
        #save-preset:hover,#reset-site:hover { border-color:var(--ak-line-bright); transform:translateY(-1px); }
        #deactivate-site { justify-self:start; height:29px; padding:4px 1px; border:0; color:#f09aa7; background:transparent; cursor:pointer; font:500 12px var(--ak-font); }
        #deactivate-site:hover { color:#ffc0c8; }
        #reopen-indicator { position:absolute; width:20px; height:20px; padding:0; border:1px solid rgba(218,201,255,.58); border-radius:50%; color:#f5efff; background:rgba(18,15,29,.38); opacity:.16; cursor:pointer; pointer-events:auto; font:600 9px/18px var(--ak-font); transition:opacity .16s ease,transform .16s ease; }
        #reopen-indicator:hover,#reopen-indicator:focus-visible { opacity:.88; transform:scale(1.08); }
        #reopen-indicator[data-corner="top-left"] { left:4px; top:4px; } #reopen-indicator[data-corner="top-right"] { right:4px; top:4px; } #reopen-indicator[data-corner="bottom-left"] { left:4px; bottom:4px; } #reopen-indicator[data-corner="bottom-right"] { right:4px; bottom:4px; }
        #fps-hud { position:absolute; top:10px; right:10px; display:grid; gap:3px; min-width:168px; padding:11px 14px; border:1px solid rgba(79,209,197,.32); border-radius:14px; color:var(--ak-text); background:rgba(18,15,29,.94); box-shadow:0 12px 32px rgba(4,2,12,.45),0 0 18px rgba(79,209,197,.08); backdrop-filter:blur(18px) saturate(140%); -webkit-backdrop-filter:blur(18px) saturate(140%); font:600 14px/1.35 var(--ak-font); font-variant-numeric:tabular-nums; pointer-events:auto; cursor:grab; touch-action:none; user-select:none; }
        #fps-hud[hidden] { display:none!important; } #fps-hud[data-positioned="true"] { top:auto; right:auto; } #fps-hud[data-dragging="true"] { cursor:grabbing; }
        #fps-hud { max-width:min(300px,calc(100% - 20px)); }
        #fps-hud span { min-width:0; white-space:normal; overflow-wrap:anywhere; color:#e8e0f3; } #fps-hud span:nth-child(2) { color:var(--ak-accent); font-size:16px; } #fps-hud .fps-hud-generated { color:var(--ak-gold); font-size:12px; } #fps-hud .fps-hud-multiplier,#fps-hud .fps-hud-expected,#fps-hud .fps-hud-render-times { color:var(--ak-muted); font-size:11px; }
        /* Crystal-glass refresh: presentation only, inside this Shadow DOM. */
        #panel { width:min(380px,calc(100% - 20px)); border-radius:16px; background:linear-gradient(145deg,rgba(12,24,37,.93),rgba(14,17,31,.94)) padding-box,linear-gradient(135deg,rgba(79,209,197,.58),rgba(112,133,180,.18),rgba(79,209,197,.24)) border-box; box-shadow:0 20px 58px rgba(1,8,16,.56),0 0 0 1px rgba(79,209,197,.035); }
        #panel::before { left:16px; right:16px; background:linear-gradient(90deg,transparent,rgba(79,209,197,.56),transparent); opacity:.72; }
        header { flex:none; gap:10px; min-height:54px; padding:2px 0 11px; }
        #brand-mark { width:38px; height:38px; border-color:rgba(112,226,218,.28); border-radius:12px; background:linear-gradient(145deg,rgba(79,209,197,.14),rgba(255,255,255,.025)); }
        #brand-mark img { width:30px; height:30px; }
        .brand-copy { display:grid; gap:1px; min-width:0; }
        .brand-copy strong { color:#f5fcff; font-size:14px; line-height:1.25; }
        .brand-subtitle { color:#a2b5c6; font-size:12px; line-height:1.2; white-space:nowrap; }
        #status-state { margin-left:auto; border-color:rgba(79,209,197,.25); color:#b0c2d1; background:rgba(8,22,32,.55); font-size:12px; }
        #panel[data-enabled="true"] #status-state { color:#b7fff8; border-color:rgba(79,209,197,.44); background:rgba(79,209,197,.1); }
        #status-state::before { background:#8294a5; }
        #panel[data-enabled="true"] #status-state::before { background:#4fd1c5; }
        #panel:not(.is-hidden)[data-enabled="true"] #status-state::before { animation:none; }
        #minimize,#dismiss { display:grid; place-items:center; flex:none; width:30px; min-width:30px; height:30px; padding:0; border:1px solid rgba(159,188,207,.2); border-radius:10px; color:#d7e8f0; background:rgba(202,232,245,.045); cursor:pointer; transition:transform .2s ease,opacity .2s ease; }
        #minimize svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; }
        #minimize:hover,#dismiss:hover { transform:translateY(-1px); color:#70e2d8; }
        #dismiss { font-size:19px; }
        #tabs { gap:3px; padding:4px 3px; border-color:rgba(160,190,213,.14); border-radius:12px; background:rgba(4,14,25,.55); }
        #tabs .tab-indicator { top:auto; bottom:1px; height:2px; width:calc((100% - 6px - 9px)/4); border:0; border-radius:99px; background:#4fd1c5; box-shadow:0 0 9px rgba(79,209,197,.74); }
        #tabs:has([data-tab="filters"][aria-selected="true"]) .tab-indicator { transform:translateX(calc(100% + 3px)); }
        #tabs:has([data-tab="frames"][aria-selected="true"]) .tab-indicator { transform:translateX(calc(200% + 6px)); }
        #tabs:has([data-tab="info"][aria-selected="true"]) .tab-indicator { transform:translateX(calc(300% + 9px)); }
        #tabs button { gap:6px; height:37px; padding:4px 2px; color:#aebdca; font-size:12px; transition:transform .2s ease,opacity .2s ease; }
        #tabs svg { display:block; width:18px; height:18px; stroke-width:1.65; color:#90a8b7; }
        #tabs button[aria-selected="true"] { color:#e6fffc; }
        #tabs button[aria-selected="true"] svg { color:#4fd1c5; }
        #tab-content { scrollbar-color:rgba(79,209,197,.32) transparent; }
        .card-title { color:#d4e1ea; font-size:12px; letter-spacing:0; }
        .experimental-chip { padding:2px 6px; border:1px solid rgba(246,196,83,.32); border-radius:999px; color:#f3d58a; background:rgba(246,196,83,.08); font-size:10px; font-weight:600; }
        .ai-card > p { margin:0 0 8px; }
        .ai-card > button,#ai-actions button,.ai-actions button { min-height:34px; padding:5px 9px; border:1px solid rgba(79,209,197,.34); border-radius:10px; color:#e9fffd; background:rgba(79,209,197,.09); cursor:pointer; font:600 12px var(--ak-font); }
        .ai-card > button { width:100%; }
        .ai-card button:disabled { opacity:.48; cursor:not-allowed; }
        #ai-progress-wrap { margin-top:8px; }
        .ai-progress-line,.ai-actions { display:flex; align-items:center; justify-content:space-between; gap:8px; }
        .ai-progress-line { color:#cedde6; font-size:11px; }
        #ai-cancel { padding:2px 7px; border:1px solid rgba(242,142,157,.3); border-radius:7px; color:#f2a7b1; background:transparent; font:500 11px var(--ak-font); cursor:pointer; }
        #ai-progress { width:100%; height:8px; margin-top:4px; accent-color:#4fd1c5; }
        .ai-actions { margin-top:8px; }
        .ai-actions button { flex:1; min-width:0; }
        .card-title::before { content:""; width:6px; height:6px; border-radius:50%; background:#4fd1c5; box-shadow:0 0 8px rgba(79,209,197,.35); }
        .label { color:#e7f0f5; }
        .segments { border-color:rgba(156,187,207,.2); border-radius:12px; background:rgba(4,14,24,.56); }
        .segments::before { border-color:rgba(79,209,197,.42); border-radius:9px; background:rgba(79,209,197,.15); box-shadow:0 0 12px rgba(79,209,197,.12); }
        .segments button { transition:transform .2s ease,opacity .2s ease; }
        .segments button[aria-pressed="true"] { color:#8cf1e8; }
        .switch { background:#3a4655!important; border-color:rgba(163,188,204,.2)!important; transition:transform .2s ease,opacity .2s ease!important; }
        .switch[aria-checked="true"] { background:#158c88!important; border-color:rgba(79,209,197,.85)!important; box-shadow:0 0 12px rgba(79,209,197,.18)!important; }
        .switch::before { background:#4fd1c5; }
        #target-control .fluency-target-control { display:grid; grid-template-columns:28px minmax(44px,1fr) 28px 74px; gap:4px; height:38px; padding:4px; }
        #target-control .fluency-target-control::before { display:none; }
        #target-control .fluency-target-control button { display:grid; place-items:center; min-width:0; height:28px; padding:0 4px; border:1px solid rgba(156,187,207,.15); border-radius:8px; color:#dceaf0; background:rgba(255,255,255,.04); cursor:pointer; font:600 13px var(--ak-font); }
        #fluencyTargetInput { width:100%; min-width:0; height:28px; border:1px solid rgba(156,187,207,.15); border-radius:8px; color:#eafffd; background:rgba(1,9,18,.55); text-align:center; font:600 13px var(--ak-font); font-variant-numeric:tabular-nums; }
        #target-control #fluencyTargetAuto { border-color:rgba(79,209,197,.35); color:#75e7dd; }
        .frames-heading { display:flex; align-items:center; gap:11px; min-height:58px; margin:2px 0 12px; padding:9px 10px; border:1px solid rgba(79,209,197,.2); border-radius:13px; background:linear-gradient(110deg,rgba(79,209,197,.085),rgba(16,29,43,.42)); }
        .frames-heading > svg { width:22px; height:22px; flex:none; fill:none; stroke:#5ce0d4; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
        .frames-heading > div { min-width:0; }
        .frames-heading .card-title { margin:0; color:#f1fbff; font-size:13px; }
        .frames-heading .card-title::before { display:none; }
        .frames-heading p { margin:2px 0 0; color:#a9bdca; font-size:12px; line-height:1.3; }
        .frames-heading .switch { margin-left:auto; }
        .icon-setting .label { gap:6px; }
        .segments button svg { width:14px; height:14px; flex:none; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
        .icon-setting .label > svg { width:15px; height:15px; flex:none; fill:none; stroke:#75dcd4; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
        .help { display:inline-grid; place-items:center; width:16px; height:16px; border:1px solid rgba(130,168,190,.48); border-radius:50%; color:#a9c3d1; font:600 11px/1 var(--ak-font); cursor:help; }
        .multiplier-row { grid-template-columns:1fr!important; gap:5px; }
        .multiplier-cards { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; width:100%; min-width:0; }
        .multiplier-cards button { display:grid; align-content:center; justify-items:center; gap:3px; min-width:0; height:64px; border:1px solid rgba(156,187,207,.21); border-radius:12px; color:#e7f0f5; background:linear-gradient(145deg,rgba(25,39,53,.68),rgba(9,19,30,.66)); cursor:pointer; transition:transform .2s ease,opacity .2s ease; }
        .multiplier-cards button strong { font:700 20px/1 var(--ak-font); font-variant-numeric:tabular-nums; }
        .multiplier-cards button small { color:#a7bdca; font:500 11px/1.2 var(--ak-font); font-variant-numeric:tabular-nums; }
        .multiplier-cards button[aria-pressed="true"] { border-color:rgba(79,209,197,.72); color:#a6fff7; background:linear-gradient(145deg,rgba(35,122,123,.26),rgba(12,38,50,.68)); box-shadow:0 0 13px rgba(79,209,197,.11),inset 0 0 0 1px rgba(79,209,197,.1); }
        #multiplier-control.is-disabled,#target-control.is-disabled { opacity:.4; pointer-events:none; }
        .frames-card details { margin-top:13px; padding-top:10px; border-top-color:rgba(156,187,207,.16); }
        .frames-card summary { display:flex; align-items:center; gap:8px; color:#c9d9e3; font-size:12px; }
        .frames-card summary svg { width:16px; height:16px; fill:none; stroke:#77cfc9; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round; }
        #frame-stats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:4px; padding-top:9px; border-top:1px solid rgba(156,187,207,.16); }
        #frame-stats > div { display:grid; justify-items:center; align-content:center; gap:2px; min-width:0; padding:3px 0; }
        #frame-stats svg { width:15px; height:15px; fill:none; stroke:#67d6ce; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round; }
        #frame-stats small { color:#9db0bf; font:500 11px/1.1 var(--ak-font); }
        #frame-stats strong { color:#edf9fc; font:600 12px/1.2 var(--ak-font); font-variant-numeric:tabular-nums; white-space:nowrap; }
        #frame-stats > div:nth-child(2) strong { color:#71e4da; }
        #frame-stats > div:nth-child(4) strong { color:#a8e9d6; }
        #panel[data-minimized="true"] { width:min(290px,calc(100% - 20px)); max-height:76px; gap:0; padding:8px 12px; }
        #panel[data-minimized="true"] header { min-height:42px; padding:0; border:0; }
        #panel[data-minimized="true"] .brand-subtitle,#panel[data-minimized="true"] #tabs,#panel[data-minimized="true"] #tab-content,#panel[data-minimized="true"] #frame-stats { display:none; }
        #fps-hud-max-warning { color:#ffb2ba!important; font-size:11px; line-height:1.35; white-space:normal; }
        /* Poodle crystal skin: local artwork; rendering and stored settings are unchanged. */
        :host { --ak-accent:#8fdaff; --ak-accent-soft:rgba(93,168,255,.18); --ak-gold:#f3d665; --ak-line:rgba(200,220,244,.22); --ak-font:system-ui,"Segoe UI",sans-serif; --ak-poodles:url("${chrome.runtime.getURL("assets/poodle-sprites.png")}"); }
        #panel { top:68px; left:56px; width:min(380px,calc(100% - 112px)); max-height:min(540px,calc(100cqh - 148px)); padding:12px 14px; gap:10px; overflow:visible; border:1px solid rgba(195,228,255,.65); border-radius:20px; background:linear-gradient(135deg,rgba(35,45,63,.28),rgba(14,20,31,.36) 60%,rgba(45,39,51,.28)) padding-box; backdrop-filter:blur(2px) saturate(110%); -webkit-backdrop-filter:blur(2px) saturate(110%); text-shadow:0 1px 3px rgba(0,0,0,.9); box-shadow:0 18px 42px rgba(0,0,0,.48),0 0 18px rgba(96,174,255,.12),inset 0 1px 0 rgba(241,248,255,.18); font:13px/1.4 var(--ak-font); }
        #panel[data-corner="top-right"] { top:68px; right:56px; }
        #panel[data-corner="bottom-left"] { left:56px; bottom:60px; }
        #panel[data-corner="bottom-right"] { right:56px; bottom:60px; }
        #panel::before { left:20px; right:20px; background:linear-gradient(90deg,transparent,#caf1ff,transparent); opacity:.8; }
        #panel > header,#panel > #tabs,#panel > #tab-content,#panel > #frame-stats { position:relative; z-index:1; }
        header { gap:7px; min-height:50px; padding:0 0 9px; border-bottom-color:rgba(220,230,249,.24); }
        #brand-mark { width:48px; height:48px; padding:2px; border:1px solid rgba(79,209,197,.42); border-radius:12px; background:rgba(8,16,26,.18); box-shadow:0 0 0 2px rgba(7,19,31,.62),0 0 14px rgba(79,209,197,.16); }
        #brand-mark img { display:block; width:100%; height:100%; object-fit:contain; }
        #panel[data-enabled="true"] #brand-mark { border-color:#c4ecff; box-shadow:0 0 0 3px rgba(7,19,31,.85),0 0 12px rgba(126,206,255,.23); }
        .brand-copy { flex:1; min-width:0; gap:4px; }
        .brand-copy strong { font-size:17px; font-weight:650; letter-spacing:-.02em; }
        .brand-subtitle { max-width:100%; overflow:hidden; text-overflow:ellipsis; font-size:10.5px; color:#c5cfdf; }
        #status-state { padding:5px 7px; gap:5px; border-color:rgba(155,232,222,.55); font-size:11px; }
        #panel[data-enabled="true"] #status-state { color:#a7f3dd; border-color:#8cd5c5; background:rgba(54,95,88,.12); }
        #panel[data-enabled="true"] #status-state::before { background:#96efcb; }
        #minimize,#dismiss { width:28px; min-width:28px; height:30px; border-color:rgba(205,222,245,.26); border-radius:9px; background:rgba(207,224,255,.09); color:#e8f0fa; }
        #tabs { display:flex; gap:3px; padding:3px; border-color:rgba(199,217,244,.3); border-radius:13px; background:rgba(9,14,25,.14); }
        #tabs .tab-indicator { display:none; }
        #tabs button { flex:1 1 0; min-width:0; gap:4px; height:36px; padding:4px 2px; border:1px solid transparent; font-size:11px; color:#d3deed; }
        #tabs button[data-tab="frames"] { flex-grow:1.35; }
        #tabs svg { width:16px; height:16px; color:#c6d3e9; }
        #tabs button[aria-selected="true"] { border-color:#9adeff; border-radius:10px; color:#eefaff; background:linear-gradient(145deg,rgba(86,161,245,.36),rgba(85,144,213,.12)); box-shadow:inset 0 0 12px rgba(158,221,255,.12),0 0 10px rgba(106,193,255,.23); }
        #tabs button[aria-selected="true"]::after { content:""; position:absolute; bottom:-3px; left:8px; right:8px; height:2px; border-radius:3px; background:#a8efff; box-shadow:0 0 7px #72c9ff; pointer-events:none; }
        #tabs button[aria-selected="true"] svg { color:#aeeeff; }
        #tab-content { scrollbar-color:rgba(167,211,255,.48) transparent; }
        .card { padding:10px; border:1px solid rgba(186,206,232,.27); border-radius:16px; background:linear-gradient(125deg,rgba(111,126,151,.03),rgba(3,9,17,.06)); }
        .card + .card { margin-top:10px; padding-top:10px; border-top:1px solid rgba(186,206,232,.27); }
        .card-title { gap:8px; margin:0 0 8px; color:#f3f6ff; font-size:13px; font-weight:550; }
        .card-title::before { content:""; flex:none; width:8px; height:8px; border:1px solid #b3eaff; border-radius:50%; background:#69b1ff; box-shadow:0 0 9px rgba(86,167,255,.68); }
        .setting { min-height:34px; margin:4px 0; grid-template-columns:76px minmax(0,1fr); }
        .setting:has(> .label + .segments[data-setting="quality"]) { grid-template-columns:76px minmax(0,1fr); align-items:center; }
        .setting:has(> [role="switch"]) { grid-template-columns:minmax(0,1fr) auto; }
        .setting > .label { width:auto; white-space:normal; }
        .label { color:#f1f3fa; font-size:13px; }
        kbd { min-width:24px; height:24px; padding:2px 5px; border-color:rgba(182,197,224,.55); border-radius:7px; color:#eff4ff; background:rgba(83,89,116,.2); box-shadow:inset 0 0 8px rgba(139,154,184,.09); font-size:11px; }
        .segments { height:34px; gap:3px; border-color:rgba(204,218,236,.46); border-radius:11px; background:rgba(4,10,16,.16); }
        .segments button { height:26px; color:#f0f4ff; font-size:13px; font-weight:500; }
        .segments::before { border-color:#a3dfff; background:linear-gradient(135deg,rgba(76,170,255,.54),rgba(48,114,181,.34)); box-shadow:0 0 10px rgba(93,178,255,.3),inset 0 0 10px rgba(191,233,255,.15); }
        .segments button[aria-pressed="true"] { color:#f6fdff; text-shadow:0 0 6px rgba(161,224,255,.45); }
        .switch { background:#4b4e64!important; border-color:rgba(197,216,241,.35)!important; }
        .switch::before { background:linear-gradient(110deg,#4b9dff,#7fc9ff); }
        .switch[aria-checked="true"] { background:#56a8fa!important; border-color:#b9edff!important; box-shadow:0 0 10px rgba(101,183,255,.4)!important; }
        .switch::after { background:#fff; box-shadow:0 1px 5px rgba(5,15,35,.28); }
        .intensity-setting output { color:#c7f0ff; border-color:rgba(133,201,251,.32); background:rgba(81,137,192,.14); }
        .intensity-setting input[type="range"]::-webkit-slider-runnable-track { background:linear-gradient(90deg,#a99bde,#83d8ff); }
        .intensity-setting input[type="range"]::-webkit-slider-thumb { background:#91d9ff; }
        .photo-guide { margin:0; padding:0; border:0; }
        .photo-guide > summary { display:grid; grid-template-columns:minmax(0,1fr) 16px; gap:5px; margin:0; padding:0; list-style:none; cursor:pointer; }
        .photo-guide > summary::-webkit-details-marker { display:none; }
        .photo-guide > summary .card-title { flex-wrap:wrap; grid-column:1; margin:0; gap:6px; font-size:12px; }
        .photo-guide > summary small { grid-column:1; margin-left:16px; color:#ccd6e7; font-size:11px; line-height:1.4; }
        .photo-guide > summary::after { content:""; grid-column:2; grid-row:1 / 3; align-self:center; width:8px; height:8px; border-right:2px solid #a2dfff; border-bottom:2px solid #a2dfff; transform:rotate(45deg); transition:transform .2s; }
        .photo-guide[open] > summary::after { transform:rotate(225deg); }
        .photo-body { padding-top:10px; }
        .photo-body > p { margin:0 0 10px; color:#ccd6e7; font-size:12px; line-height:1.5; }
        .photo-body > button { width:100%; min-height:34px; border:1px solid #95d3f5; border-radius:10px; color:#effaff; background:rgba(75,145,207,.24); font:600 12px var(--ak-font); cursor:pointer; }
        .experimental-chip { border-color:#ead47c; color:#f9df70; background:rgba(221,180,40,.08); font-size:10px; }
        #frame-stats { padding:9px 4px; gap:0; border:1px solid rgba(209,212,225,.46); border-radius:16px; background:linear-gradient(110deg,rgba(91,89,114,.07),rgba(24,29,41,.09)); }
        #frame-stats > div { padding:3px 0; gap:4px; border-right:1px solid rgba(216,223,242,.22); }
        #frame-stats > div:last-child { border-right:0; }
        #frame-stats svg { width:18px; height:18px; stroke:#99e0ff; }
        #frame-stats small { color:#edf1fc; font-size:12px; }
        #frame-stats strong { color:#f5f5fc; font-size:13px; font-weight:500; }
        #frame-stats > div:nth-child(2) strong { color:#bca1f2; }
        #frame-stats > div:nth-child(4) strong { color:#f5f5fc; }
        #recommended-preset { color:#ffe49a; border-color:#dcca75; background:rgba(219,184,57,.12); }
        #panel button:focus-visible,#panel input:focus-visible,#panel summary:focus-visible { outline:2px solid #addefa; outline-offset:3px; }
        #panel .panel-art { position:absolute; inset:-9px; z-index:0; pointer-events:none; user-select:none; }
        .panel-art * { pointer-events:none!important; }
        .skin-ribbon { position:absolute; inset:0; width:100%; height:100%; overflow:visible; fill:none; stroke-width:1; filter:drop-shadow(0 0 3px rgba(130,194,255,.55)); }
        .skin-ribbon .ribbon-blue { stroke:#a0dfff; opacity:.9; }
        .skin-ribbon .ribbon-pink { stroke:#efaecf; opacity:.6; }
        .skin-ribbon .ribbon-light { stroke:#ebf7ff; opacity:.65; stroke-width:.5; }
        .skin-mascot { position:absolute; width:92px; height:92px; background-image:var(--ak-poodles); background-size:200% 200%; background-repeat:no-repeat; filter:drop-shadow(0 3px 3px rgba(10,17,28,.38)); }
        .mascot-top { top:-63px; right:18px; background-position:0 0; }
        .mascot-left { top:36%; left:-44px; width:66px; height:66px; background-position:100% 0; }
        .mascot-hat { bottom:68px; right:-48px; width:82px; height:82px; background-position:0 100%; }
        .mascot-sleep { bottom:-62px; left:4px; width:108px; height:108px; background-position:100% 100%; }
        .skin-paw { position:absolute; width:20px; height:20px; fill:#ffd7a5; filter:drop-shadow(0 0 4px rgba(253,171,111,.7)); }
        .paw-left { top:54%; left:-14px; transform:rotate(-20deg); }
        .paw-right { top:19%; right:-12px; transform:rotate(18deg); }
        .paw-bottom { bottom:-13px; right:30px; fill:#bcefff; }
        .skin-star { position:absolute; color:#f6c3db; font:20px/1 var(--ak-font); text-shadow:0 0 8px rgba(255,151,210,.6); }
        .star-top { left:5px; top:24px; }
        .star-right { right:-15px; bottom:34%; }
        .skin-heart { position:absolute; top:-22px; right:5px; color:#f8bfda; font:22px/1 var(--ak-font); transform:rotate(15deg); text-shadow:0 0 6px #d267a0; }
        #panel[data-minimized="true"] { top:10px; left:10px; overflow:hidden; }
        #panel[data-minimized="true"] .panel-art { display:none; }
        #panel[data-minimized="true"][data-corner="top-right"] { top:10px; right:10px; }
        #panel[data-minimized="true"][data-corner="bottom-left"],#panel[data-minimized="true"][data-corner="bottom-right"] { bottom:10px; }

        /* Size the controls against the video host, including videos inside iframes. */
        :host { container-type:size; container-name:anime4k-player; }
        #tab-content { flex:1 1 auto; }
        @container anime4k-player (max-width:1100px) or (max-height:650px) {
          #panel .panel-art { display:none; }
          #panel:not([data-positioned="true"]) { top:10px; left:10px; }
          #panel:not([data-positioned="true"])[data-corner="top-right"] { left:auto; right:10px; }
          #panel:not([data-positioned="true"])[data-corner="bottom-left"] { top:auto; bottom:10px; }
          #panel:not([data-positioned="true"])[data-corner="bottom-right"] { top:auto; left:auto; right:10px; bottom:10px; }
          #panel:not([data-minimized="true"]) { overflow:hidden; }
          .setting:has(> .label + .segments[data-setting="quality"]) { grid-template-columns:minmax(0,1fr); }
          #panel:not([data-minimized="true"]) { width:min(320px,calc(100% - 20px)); max-height:min(360px,66cqh,calc(100cqh - 72px)); padding:8px 12px; gap:6px; }
          header { gap:6px; min-height:34px; padding:0 0 6px; }
          .brand-subtitle { display:none; }
          #brand-mark { width:28px; height:28px; border-radius:9px; }
          #brand-mark img { width:24px; height:24px; }
          #status-state { gap:4px; padding:3px 6px; font-size:11px; }
          #minimize,#dismiss { width:28px; min-width:28px; height:28px; }
          #tabs button { height:30px; gap:0; }
          /* Keep the accessible tab names while the icons take less room. */
          #tabs button span { position:absolute; width:1px; height:1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
          #tabs svg { display:block; width:18px; height:18px; }
          .setting { margin:4px 0; min-height:32px; }
          .card { padding-top:8px; margin-top:8px; }
          .card-title { margin-bottom:6px; }
          .segments { height:34px; }
          .segments button { height:26px; }
          .setting:has(> .segments[data-setting="scale"]),.setting:has(> .segments[data-setting="interpolationMode"]),.setting:has(> .segments[data-setting="fluencyControlMode"]),#target-control { grid-template-columns:minmax(0,1fr); gap:4px; }
          .frames-heading { min-height:44px; margin-bottom:8px; padding:6px; gap:6px; }
          .frames-heading > svg { width:18px; height:18px; }
          .frames-heading p { display:none; }
          .multiplier-cards button { height:48px; }
          #frame-stats { padding-top:6px; }
          #frame-stats svg { display:none; }
          #frame-stats > div { padding:0; }
        }
        @container anime4k-player (max-width:800px) or (max-height:450px) {
          #panel:not([data-minimized="true"]) { width:min(300px,calc(100% - 20px)); max-height:min(320px,65cqh,calc(100cqh - 64px)); }
          .intensity-setting { grid-template-columns:minmax(64px,84px) minmax(0,1fr) auto; gap:6px; }
        }
        @container anime4k-player (max-width:400px) or (max-height:350px) {
          #panel:not([data-minimized="true"]) { width:min(284px,calc(100% - 20px)); max-height:min(70cqh,calc(100cqh - 52px)); padding:6px 8px; gap:4px; }
          #frame-stats { display:none; } /* Statistics remain in Info and the F3 HUD. */
          .card-title { flex-wrap:wrap; }
        }
        @container anime4k-player (max-height:220px) {
          #panel:not([data-minimized="true"]) { max-height:calc(100cqh - 52px); }
          header { min-height:30px; padding-bottom:4px; }
          #tabs { padding-block:2px; }
          #tabs button { height:28px; }
        }
        @media (prefers-reduced-motion:reduce) { *,*::before,*::after { animation-duration:.01ms!important; animation-iteration-count:1!important; scroll-behavior:auto!important; transition-duration:.01ms!important; } }
      </style>
      <section id="panel" aria-label="Controles de Anime4K">
        <div class="panel-art" aria-hidden="true">
          <svg class="skin-ribbon" viewBox="0 0 380 540" preserveAspectRatio="none"><path class="ribbon-blue" d="M36 8C-35 40 30 105 9 188S-13 311 15 375-15 467 23 515 217 562 342 533 366 455 377 372 349 274 378 208 364 91 352 21 104 38 36 8Z"/><path class="ribbon-pink" d="M10 53C45-8 181 25 286 10S410 48 370 141 407 296 375 351 408 485 359 528 223 506 135 542-20 494 13 421-24 297 11 246-21 112 10 53Z"/><path class="ribbon-light" d="M28 2H331Q378 2 378 49V489Q378 538 330 538H47Q3 538 3 492V53Q3 2 28 2Z"/></svg>
          <span class="skin-mascot mascot-top"></span><span class="skin-mascot mascot-left"></span><span class="skin-mascot mascot-hat"></span><span class="skin-mascot mascot-sleep"></span>
          <svg class="skin-paw paw-left" viewBox="0 0 32 32" aria-hidden="true"><ellipse cx="8" cy="9" rx="3" ry="4"/><ellipse cx="16" cy="6" rx="3" ry="4"/><ellipse cx="24" cy="9" rx="3" ry="4"/><ellipse cx="28" cy="16" rx="2.5" ry="3.5"/><path d="M8 25c-3-5 4-14 8-14s12 9 8 14c-2 3-6 0-8 0s-6 3-8 0Z"/></svg><svg class="skin-paw paw-right" viewBox="0 0 32 32" aria-hidden="true"><ellipse cx="8" cy="9" rx="3" ry="4"/><ellipse cx="16" cy="6" rx="3" ry="4"/><ellipse cx="24" cy="9" rx="3" ry="4"/><ellipse cx="28" cy="16" rx="2.5" ry="3.5"/><path d="M8 25c-3-5 4-14 8-14s12 9 8 14c-2 3-6 0-8 0s-6 3-8 0Z"/></svg><svg class="skin-paw paw-bottom" viewBox="0 0 32 32" aria-hidden="true"><ellipse cx="8" cy="9" rx="3" ry="4"/><ellipse cx="16" cy="6" rx="3" ry="4"/><ellipse cx="24" cy="9" rx="3" ry="4"/><ellipse cx="28" cy="16" rx="2.5" ry="3.5"/><path d="M8 25c-3-5 4-14 8-14s12 9 8 14c-2 3-6 0-8 0s-6 3-8 0Z"/></svg>
          <span class="skin-star star-top">✧</span><span class="skin-star star-right">✧</span><span class="skin-heart">♡</span>
        </div>
        <header><span id="brand-mark"><img src="${chrome.runtime.getURL("assets/logo-perro.png")}" alt=""></span><span class="brand-copy"><strong>Anime4K</strong><span class="brand-subtitle">Mejora tu experiencia visual</span></span><span id="status-dot" aria-hidden="true"></span><span id="status-state" aria-hidden="true"></span><button id="minimize" type="button" aria-label="Minimizar panel" data-tooltip="Minimizar panel"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg></button><button id="dismiss" type="button" title="Ocultar panel" aria-label="Ocultar panel">×</button></header>
        <nav id="tabs" role="tablist" aria-label="Secciones Anime4K"><span class="tab-indicator" aria-hidden="true"></span><button type="button" role="tab" data-tab="image" aria-selected="true" title="Imagen"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="9" cy="9" r="1.5"/><path d="m5 17 5-5 3 3 3-4 3 6"/></svg><span>Imagen</span></button><button type="button" role="tab" data-tab="filters" aria-selected="false" title="Filtros"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/><circle cx="8" cy="6" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="12" cy="18" r="1.5"/></svg><span>Filtros</span></button><button type="button" role="tab" data-tab="frames" aria-selected="false" title="Generación de fotogramas (experimental; atajo configurable)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v14H5zM9 9l6 3-6 3z"/></svg><span>Fotogramas</span></button><button type="button" role="tab" data-tab="info" aria-selected="false" title="Info"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg><span>Info</span></button></nav>
        <div id="tab-content">
          <div class="tab-page is-active" data-page="image" role="tabpanel">
            <section class="card"><h3 class="card-title">Procesamiento</h3><div class="setting"><span class="label">Filtro Anime4K</span><button class="switch" type="button" role="switch" aria-checked="false" aria-label="Activar filtro Anime4K" data-setting="enabled"></button></div><div class="setting"><span class="label">Modo <kbd data-shortcut-range="mode">1-3</kbd></span><div class="segments" data-setting="mode"><button type="button" data-value="A">A</button><button type="button" data-value="B">B</button><button type="button" data-value="C">C</button></div></div><div class="setting"><span class="label">Calidad <kbd data-shortcut="quality">Q</kbd></span><div class="segments" data-setting="quality"><button type="button" data-value="Fast">Fast</button><button type="button" data-value="HQ">HQ</button><button type="button" data-value="Máxima">Máxima</button></div></div><div class="setting"><span class="label">Escala <kbd data-shortcut="scale">S</kbd></span><div class="segments" data-setting="scale"><button type="button" data-value="1">1×</button><button type="button" data-value="1.5">1,5×</button><button type="button" data-value="2">2×</button><button type="button" data-value="Auto">Auto</button></div></div></section>
            <section class="card ai-card"><details id="photo-guide" class="photo-guide"><summary><span class="card-title">Foto de alta calidad con IA <span class="experimental-chip">Experimental</span></span><small>1. Pausá en el dibujo más nítido.</small></summary><div class="photo-body"><p class="muted-hint">1. Pausá en el dibujo más nítido.<br>2. Para comparar, elegí Máxima y 2× o Auto.<br>3. Activá Detalle y usá Nitidez con moderación; procesá y guardá el PNG.<br>La foto IA es x2 fijo: Máxima y Escala afectan la vista Anime4K; Detalle y Nitidez sí afectan la foto.</p><button id="ai-improve" type="button" data-tooltip="Procesa el frame pausado con Real-ESRGAN animevideov3. Puede tardar unos segundos. Atajo configurable.">Procesar foto con IA <kbd data-shortcut="aiImprove">E</kbd></button><div id="ai-progress-wrap" hidden><div class="ai-progress-line"><span id="ai-progress-label">Preparando…</span><button id="ai-cancel" type="button">Cancelar</button></div><progress id="ai-progress" max="100" value="0"></progress></div><div class="ai-actions"><button id="ai-toggle-preview" type="button" disabled>Ver Anime4K</button><button id="ai-save" type="button" disabled>Guardar PNG</button></div></div></details></section>
            <section class="card"><h3 class="card-title">Comparación</h3><div class="setting"><span class="label" title="Compará el video original con la imagen procesada; atajo configurable">Comparar <kbd data-shortcut="compare">C</kbd></span><button class="switch" type="button" role="switch" aria-checked="false" aria-label="Comparar original y Anime4K" data-setting="compare"></button></div><div class="setting"><span class="label">Etiquetas</span><button class="switch" type="button" role="switch" aria-checked="true" aria-label="Mostrar etiquetas de comparación" data-setting="compareLabels"></button></div></section>
          </div>
          <div class="tab-page" data-page="filters" role="tabpanel" hidden>
            <section class="card"><h3 class="card-title">Filtros</h3><div class="setting"><span class="label" title="Realza la textura de los fondos">Detalle</span><button class="switch" type="button" role="switch" aria-checked="false" aria-label="Activar Detalle. Realza la textura de los fondos" data-setting="detail"></button></div><div class="setting"><span class="label">Tamaño</span><div class="segments" data-setting="detailSize"><button type="button" data-value="Fino">Fino</button><button type="button" data-value="Medio">Medio</button><button type="button" data-value="Amplio">Amplio</button></div></div><label class="intensity-setting" for="detailIntensity" hidden><span>Intensidad</span><input id="detailIntensity" type="range" min="0" max="200" value="100" aria-label="Intensidad de Detalle"><output id="detailValue">100%</output></label><div class="setting"><span class="label">Nitidez</span><button class="switch" type="button" role="switch" aria-checked="false" aria-label="Activar nitidez" data-setting="sharpening"></button></div><label class="intensity-setting" for="sharpeningIntensity"><span>Intensidad</span><input id="sharpeningIntensity" type="range" min="0" max="200" value="50" aria-label="Intensidad de nitidez"><output id="sharpeningValue">50%</output></label><details><summary>Avanzado</summary><label class="intensity-setting" for="lineEnhancementIntensity"><span>Realce de líneas</span><input id="lineEnhancementIntensity" type="range" min="0" max="100" value="0" aria-label="Realce de líneas"><output id="lineEnhancementValue">0%</output></label><div class="setting"><span class="label" title="Muestra en blanco y negro las líneas que detecta el filtro">Depurar máscara</span><button class="switch" type="button" role="switch" aria-checked="false" aria-label="Depurar máscara de líneas" data-setting="lineMaskDebug"></button></div></details></section>
          </div>
          <div class="tab-page" data-page="frames" role="tabpanel" hidden>
            <section class="card frames-card"><div class="frames-heading"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-9 12h7l-1 8 10-13h-7z"/></svg><div><h3 class="card-title">Generación de fotogramas</h3><p>Suaviza el movimiento y mejora la fluidez</p></div><button class="switch" type="button" role="switch" aria-checked="false" aria-label="Activar generación de fotogramas" data-setting="fluency" data-tooltip="Generación de fotogramas experimental; atajo configurable"></button></div><div class="setting icon-setting"><span class="label"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/></svg>Método <span class="help" data-tooltip="Mezcla combina dibujos; Movimiento estima el desplazamiento para formar intermedios.">?</span></span><div class="segments" data-setting="interpolationMode"><button type="button" data-value="mix"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h5l4 10h5M5 17h5l4-10h5"/></svg>Mezcla</button><button type="button" data-value="motion"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h13m-5-5 5 5-5 5M3 6v12"/></svg>Movimiento</button></div></div><div class="setting icon-setting"><span class="label"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="17" r="2"/></svg>Cálculo <span class="help" data-tooltip="Elegí un múltiplo fijo o un objetivo de salida en fps.">?</span></span><div class="segments" data-setting="fluencyControlMode"><button type="button" data-value="multiplier">Multiplicador</button><button type="button" data-value="target">Objetivo</button></div></div><div class="setting multiplier-row" id="multiplier-control"><span class="label">Multiplicador <span class="help" data-tooltip="Los fps se calculan usando la frecuencia real medida del video.">?</span></span><div class="multiplier-cards" data-setting="fluencyMultiplier"><button type="button" data-value="2"><strong>x2</strong><small id="multiplier-fps-2">— fps</small></button><button type="button" data-value="3"><strong>x3</strong><small id="multiplier-fps-3">— fps</small></button><button type="button" data-value="4"><strong>x4</strong><small id="multiplier-fps-4">— fps</small></button></div></div><div class="setting" id="target-control"><span class="label">FPS objetivo <span class="help" data-tooltip="Definí la frecuencia de salida. Auto usa el mayor múltiplo posible según el refresco detectado.">?</span></span><div class="segments fluency-target-control"><button id="target-minus" type="button" aria-label="Bajar objetivo">−</button><input id="fluencyTargetInput" type="number" min="24" max="240" step="1" aria-label="Fotogramas por segundo objetivo"><button id="target-plus" type="button" aria-label="Subir objetivo">+</button><button id="fluencyTargetAuto" type="button" aria-pressed="false" title="Usa el mayor objetivo que no supera el refresco medido del monitor">⌁ Auto</button></div></div><details><summary><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="M19 13.5a7.4 7.4 0 0 0 0-3l2-1.2-2-3.4-2.2 1a8 8 0 0 0-2.5-1.4L14 3h-4l-.4 2.5a8 8 0 0 0-2.5 1.4l-2.2-1-2 3.4 2 1.2a7.4 7.4 0 0 0 0 3l-2 1.2 2 3.4 2.2-1a8 8 0 0 0 2.5 1.4L10 21h4l.4-2.5a8 8 0 0 0 2.5-1.4l2.2 1 2-3.4z"/></svg>Configuración avanzada</summary><p class="muted-hint" title="Si el equipo no alcanza el presupuesto, se mostrarán solo los frames reales; la calidad no cambia automáticamente.">Experimental · atajo configurable · ante una carga alta se presentan frames reales</p><div class="setting"><span class="label">Depurar máscara</span><button class="switch" type="button" role="switch" aria-checked="false" aria-label="Depurar máscara de líneas" data-setting="lineMaskDebug"></button></div></details></section>
          </div>
          <div class="tab-page" data-page="info" role="tabpanel" hidden><section class="card"><details id="statsDetails"><summary>Estadísticas <kbd data-shortcut="stats">F2</kbd> · HUD <kbd data-shortcut="fpsHud">F3</kbd></summary><pre id="stats"></pre></details><div class="info-actions"><button id="recommended-preset" type="button" title="Aplica el ajuste recomendado para la mayoría de videos: Modo A, Fast">Recomendado</button><button id="save-preset" type="button" title="Guarda el modo y calidad actuales como tu preset en este sitio">Guardar como mi preset</button><button id="reset-site" type="button" title="Restablece los ajustes de este sitio a los valores iniciales">Restablecer este sitio</button><button id="deactivate-site" type="button">Desactivar en este sitio</button></div></section></div>
        </div><footer id="frame-stats" aria-label="Estadísticas de fotogramas"><div><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM8 9h8M8 13h5"/></svg><small>Video</small><strong id="frame-stat-video">— fps</strong></div><div><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM9 8l6 4-6 4z"/></svg><small>Salida</small><strong id="frame-stat-output">— fps</strong></div><div><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1"/><circle cx="12" cy="12" r="4"/></svg><small>Render</small><strong id="frame-stat-render">— ms</strong></div><div><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18m0-18 7 7m-7-7L5 10m7 11 7-7m-7 7-7-7"/></svg><small>Generados</small><strong id="frame-stat-generated">—/s</strong></div></footer>
      </section><button id="reopen-indicator" type="button" hidden data-corner="bottom-right" title="Reabrir Anime4K" aria-label="Reabrir panel Anime4K">A</button><div id="ui-tooltip" role="tooltip" hidden></div><div id="ui-toast" role="status" aria-live="polite" hidden></div>
      <aside id="fps-hud" hidden aria-label="Contador de FPS Anime4K"><span>Video: — fps</span><span>Salida: — fps</span><span class="fps-hud-generated" hidden>Generados: +—</span><span class="fps-hud-multiplier" hidden>Modo: Multiplicador · x2</span><span class="fps-hud-expected" hidden>Salida esperada: — fps</span><span class="fps-hud-render-times">Anime4K — ms · Filtros — ms · Generación de fotogramas — ms</span><span id="fps-hud-max-warning" hidden></span></aside>`;
    const panel = shadow.querySelector("#panel");
    const stats = shadow.querySelector("#stats");
    const statsDetails = shadow.querySelector("#statsDetails");
    const aiImproveButton = shadow.querySelector("#ai-improve");
    const aiProgressWrap = shadow.querySelector("#ai-progress-wrap");
    const aiProgressLabel = shadow.querySelector("#ai-progress-label");
    const aiProgress = shadow.querySelector("#ai-progress");
    const aiTogglePreview = shadow.querySelector("#ai-toggle-preview");
    const aiSaveButton = shadow.querySelector("#ai-save");
    const compareVisuals = compareShadow.querySelector("#compare-visuals");
    const dividerLine = compareShadow.querySelector("#divider-line");
    const dividerGrip = compareShadow.querySelector("#divider-grip");
    const dismissButton = shadow.querySelector("#dismiss");
    const tabContent = shadow.querySelector("#tab-content");
    const tabButtons = [...shadow.querySelectorAll('[role="tab"][data-tab]')];
    const tabPages = [...shadow.querySelectorAll(".tab-page")];
    const statusDot = shadow.querySelector("#status-dot");
    const tooltip = shadow.querySelector("#ui-tooltip");
    let tooltipTimer = null;
    let tooltipTarget = null;
    const uiToast = shadow.querySelector("#ui-toast");
    let uiToastTimer = null;
    let uiToastHideTimer = null;
    const reopenIndicator = shadow.querySelector("#reopen-indicator");
    const fpsHud = shadow.querySelector("#fps-hud");
    const fpsHudVideo = fpsHud.children[0];
    const fpsHudOutput = fpsHud.children[1];
    const fpsHudGenerated = fpsHud.children[2];
    const fpsHudMultiplier = fpsHud.children[3];
    const fpsHudExpected = fpsHud.children[4];
    const fpsHudRenderTimes = fpsHud.children[5];
    const fluencyTargetInput = shadow.querySelector("#fluencyTargetInput");
    const fluencyTargetAuto = shadow.querySelector("#fluencyTargetAuto");
    const detailSlider = shadow.querySelector("#detailIntensity");
    const detailValue = shadow.querySelector("#detailValue");
    const sharpeningSlider = shadow.querySelector("#sharpeningIntensity");
    const sharpeningValue = shadow.querySelector("#sharpeningValue");
    const lineEnhancementSlider = shadow.querySelector("#lineEnhancementIntensity");
    const lineEnhancementValue = shadow.querySelector("#lineEnhancementValue");
    let panelVisible = false;
    let panelHideTimer = null;
    let draggingPanel = false;
    let panelDragState = null;
    let fpsHudVisible = false;
    let draggingFpsHud = false;
    let fpsHudDragState = null;
    let fpsHudPositionLocal = fpsHudPosition ? { ...fpsHudPosition } : null;
    let lastHudVideoCallback = null;
    let videoFpsMeasured = 24;
    const mediaIntervalSamples = [];
    let lastMediaTimeSeconds = null;
    let lastMediaFrameNumber = null;
    let fractionalFrameAccumulator = 0;
    let comparisonPosition = 0.5;
    let draggingDivider = false;
    let aiRunGeneration = 0;
    let aiProcessing = false;
    let aiTaskId = null;
    let aiPreviewActive = false;
    let aiResultReady = false;
    let aiPresentationPending = null;
    let aiResultContext = null;
    let lastCompareLabelLayout = 0;
    panel.classList.add("is-hidden");
    panel.setAttribute("aria-hidden", "true");
    for (const element of shadow.querySelectorAll("[title]")) {
      element.dataset.tooltip = element.title;
      element.removeAttribute("title");
    }
    const hideTooltip = () => {
      if (tooltipTimer !== null) clearTimeout(tooltipTimer);
      tooltipTimer = null;
      tooltipTarget = null;
      tooltip.hidden = true;
    };
    function showToast(message) {
      clearTimeout(uiToastTimer);
      clearTimeout(uiToastHideTimer);
      uiToast.textContent = message;
      uiToast.hidden = false;
      uiToast.classList.remove("is-leaving", "is-visible");
      void uiToast.offsetWidth;
      uiToast.classList.add("is-visible");
      uiToastTimer = setTimeout(() => {
        uiToast.classList.remove("is-visible");
        uiToast.classList.add("is-leaving");
        uiToastHideTimer = setTimeout(() => {
          uiToast.hidden = true;
          uiToast.classList.remove("is-leaving");
        }, 190);
      }, 1650);
    }
    async function startAiImproveFrame() {
      if (!video.paused) {
        showToast("La foto con IA solo se procesa con el video pausado");
        return;
      }
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) {
        showToast("No hay un frame disponible para la foto");
        return;
      }
      if (aiProcessing) return;
      shadow.querySelector("#photo-guide").open = true;
      aiProcessing = true;
      aiProgressWrap.hidden = false;
      aiProgress.value = 0;
      aiProgressLabel.textContent = "Buscando el modelo…";
      aiImproveButton.disabled = true;
      const generation = ++aiRunGeneration;
      const taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      aiTaskId = taskId;
      let aiOffscreenRequested = false;
      let tileInput = null;
      let tileResult = null;
      const startedAt = performance.now();
      const throwIfCancelled = () => {
        if (generation !== aiRunGeneration || !video.paused || stopped) throw new DOMException("Procesamiento de foto cancelado", "AbortError");
      };
      const sendAiMessage = async (action, values = {}) => {
        const response = await chrome.runtime.sendMessage({ channel: "anime4k-ai", action, taskId, ...values });
        if (!response?.ok) throw new Error(response?.error || "El procesador IA no respondió");
        return response;
      };
      try {
        // Todo el acceso al modelo/runtime empieza tras el gesto del usuario o
        // 400 ms después del evento pause. Durante reproducción no se asignan
        // buffers, texturas, sesión ni mosaicos de IA.
        const modelUrl = chrome.runtime.getURL("models/realesr-animevideov3.onnx");
        const response = await fetch(modelUrl, { method: "HEAD", cache: "no-store" });
        throwIfCancelled();
        if (!response.ok) {
          aiProgressLabel.textContent = "Falta el modelo";
          showToast("Falta el modelo. Ejecutá: .\\.venv-tools\\Scripts\\python.exe tools\\convert_model.py models\\realesr-animevideov3.pth models\\realesr-animevideov3.onnx");
          return;
        }
        aiOffscreenRequested = true;
        await sendAiMessage("start");
        throwIfCancelled();

        const sourceWidth = video.videoWidth;
        const sourceHeight = video.videoHeight;
        const tileSize = 256;
        const overlap = 16;
        const stride = tileSize - overlap;
        const xPositions = Array.from({ length: Math.ceil(sourceWidth / stride) }, (_, index) => index * stride);
        const yPositions = Array.from({ length: Math.ceil(sourceHeight / stride) }, (_, index) => index * stride);
        const tileCount = xPositions.length * yPositions.length;
        if (!aiResultContext || aiResultCanvas.width !== sourceWidth * 2 || aiResultCanvas.height !== sourceHeight * 2) {
          aiResultCanvas.width = sourceWidth * 2;
          aiResultCanvas.height = sourceHeight * 2;
          aiResultContext = aiResultCanvas.getContext("2d", { alpha: true, willReadFrequently: true });
        } else aiResultContext.clearRect(0, 0, aiResultCanvas.width, aiResultCanvas.height);
        // Cada mosaico aporta solo su peso en el solapamiento; "lighter"
        // acumula los colores premultiplicados sin abrir una franja transparente.
        aiResultContext.globalCompositeOperation = "lighter";
        tileInput = document.createElement("canvas");
        tileResult = document.createElement("canvas");
        const tileInputContext = tileInput.getContext("2d", { willReadFrequently: true });
        const tileResultContext = tileResult.getContext("2d", { willReadFrequently: true });
        let tileNumber = 0;
        for (let yIndex = 0; yIndex < yPositions.length; yIndex++) {
          const y = yPositions[yIndex];
          const previousY = yPositions[yIndex - 1];
          const nextY = yPositions[yIndex + 1];
          const topOverlap = previousY === undefined ? 0 : Math.max(0, previousY + Math.min(tileSize, sourceHeight - previousY) - y);
          const bottomOverlap = nextY === undefined ? 0 : Math.max(0, y + Math.min(tileSize, sourceHeight - y) - nextY);
          for (let xIndex = 0; xIndex < xPositions.length; xIndex++) {
            const x = xPositions[xIndex];
            const previousX = xPositions[xIndex - 1];
            const nextX = xPositions[xIndex + 1];
            const leftOverlap = previousX === undefined ? 0 : Math.max(0, previousX + Math.min(tileSize, sourceWidth - previousX) - x);
            const rightOverlap = nextX === undefined ? 0 : Math.max(0, x + Math.min(tileSize, sourceWidth - x) - nextX);
            throwIfCancelled();
            const coreWidth = Math.min(tileSize, sourceWidth - x);
            const coreHeight = Math.min(tileSize, sourceHeight - y);
            const inputX = Math.max(0, x - overlap);
            const inputY = Math.max(0, y - overlap);
            const inputRight = Math.min(sourceWidth, x + coreWidth + overlap);
            const inputBottom = Math.min(sourceHeight, y + coreHeight + overlap);
            const inputWidth = inputRight - inputX;
            const inputHeight = inputBottom - inputY;
            tileInput.width = inputWidth;
            tileInput.height = inputHeight;
            tileInputContext.drawImage(video, inputX, inputY, inputWidth, inputHeight, 0, 0, inputWidth, inputHeight);
            let tileDataUrl;
            try { tileDataUrl = tileInput.toDataURL("image/png"); }
            catch (error) {
              if (error?.name === "SecurityError") throw new Error("CORS bloqueó la lectura del frame del video");
              throw error;
            }
            const crop = { x: x - inputX, y: y - inputY, width: coreWidth, height: coreHeight };
            const tileResponse = await sendAiMessage("tile", { dataUrl: tileDataUrl, x, y, crop });
            throwIfCancelled();
            const bitmap = await createImageBitmap(await (await fetch(tileResponse.dataUrl)).blob());
            tileResult.width = coreWidth * 2;
            tileResult.height = coreHeight * 2;
            tileResultContext.clearRect(0, 0, tileResult.width, tileResult.height);
            tileResultContext.drawImage(bitmap, 0, 0);
            bitmap.close();
            const pixels = tileResultContext.getImageData(0, 0, tileResult.width, tileResult.height);
            const leftFeather = leftOverlap * 2;
            const rightFeather = rightOverlap * 2;
            const topFeather = topOverlap * 2;
            const bottomFeather = bottomOverlap * 2;
            const horizontalWeights = new Float32Array(tileResult.width);
            const verticalWeights = new Float32Array(tileResult.height);
            for (let px = 0; px < tileResult.width; px++) {
              let weight = 1;
              if (leftFeather && px < leftFeather) weight = Math.min(weight, (px + 0.5) / leftFeather);
              if (rightFeather && px >= tileResult.width - rightFeather) weight = Math.min(weight, (tileResult.width - px - 0.5) / rightFeather);
              horizontalWeights[px] = weight;
            }
            for (let py = 0; py < tileResult.height; py++) {
              let verticalWeight = 1;
              if (topFeather && py < topFeather) verticalWeight = Math.min(verticalWeight, (py + 0.5) / topFeather);
              if (bottomFeather && py >= tileResult.height - bottomFeather) verticalWeight = Math.min(verticalWeight, (tileResult.height - py - 0.5) / bottomFeather);
              verticalWeights[py] = verticalWeight;
              for (let px = 0; px < tileResult.width; px++) {
                const weight = horizontalWeights[px] * verticalWeight;
                pixels.data[(py * tileResult.width + px) * 4 + 3] = Math.round(255 * Math.max(0, Math.min(1, weight)));
              }
            }
            tileResultContext.putImageData(pixels, 0, 0);
            aiResultContext.drawImage(tileResult, x * 2, y * 2);
            tileNumber++;
            aiProgress.value = Math.round(tileNumber * 100 / tileCount);
            aiProgressLabel.textContent = `Mosaico ${tileNumber}/${tileCount} · ${aiProgress.value}% · ${((performance.now() - startedAt) / 1000).toFixed(1)} s`;
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
        throwIfCancelled();
        aiResultContext.globalCompositeOperation = "source-over";
        aiResultReady = true;
        aiPreviewActive = true;
        aiTogglePreview.textContent = "Ver Anime4K";
        aiTogglePreview.disabled = false;
        aiSaveButton.disabled = false;
        if (!await renderCurrentFrame()) throw new Error("No se pudo presentar la foto IA en el canvas");
        throwIfCancelled();
        refreshComparisonPresentation();
        placeOverlay();
        showToast(`Foto IA lista · x2 · ${((performance.now() - startedAt) / 1000).toFixed(1)} s`);
      } catch (error) {
        if (error?.name !== "AbortError") {
          console.error("[IA Error]:", error);
          aiPreviewActive = false;
          aiResultReady = false;
          const reason = error?.name === "SecurityError" || /CORS/i.test(error?.message || "")
            ? "CORS bloqueó la lectura del frame; no se procesó la imagen"
            : `No se pudo procesar la foto con IA: ${error?.message || error}`;
          showToast(reason);
          refreshComparisonPresentation();
          placeOverlay();
          if (overlayEnabled) redrawNow();
          else restoreOriginal();
        }
      } finally {
        if (aiOffscreenRequested) {
          try { await sendAiMessage("end"); } catch { /* El offscreen puede haberse cerrado tras un fallo inicial. */ }
        }
        if (aiTaskId === taskId) aiTaskId = null;
        tileInput?.remove();
        tileResult?.remove();
        if (generation === aiRunGeneration) {
          aiProcessing = false;
          aiProgressWrap.hidden = true;
          aiImproveButton.disabled = false;
          aiTogglePreview.disabled = !aiResultReady;
          aiSaveButton.disabled = !aiResultReady;
        }
      }
    }
    function cancelAiImproveFrame() {
      if (!aiProcessing && !aiTaskId && !aiResultReady && !aiPreviewActive) return;
      aiRunGeneration += 1;
      aiProcessing = false;
      const taskId = aiTaskId;
      aiTaskId = null;
      if (taskId) void chrome.runtime.sendMessage({ channel: "anime4k-ai", action: "cancel", taskId }).catch(() => {});
      aiPreviewActive = false;
      aiResultReady = false;
      aiProgressWrap.hidden = true;
      aiImproveButton.disabled = false;
      aiTogglePreview.disabled = true;
      aiSaveButton.disabled = true;
      const state = gpuState;
      const clearResult = () => {
        aiResultCanvas.width = 0;
        aiResultCanvas.height = 0;
        aiResultContext = null;
        aiPresentationPending = null;
      };
      if (state && aiPresentationPending) {
        state.device.queue.onSubmittedWorkDone().then(clearResult, clearResult);
      } else clearResult();
      refreshComparisonPresentation();
      placeOverlay();
      if (overlayEnabled && video.paused && !stopped) redrawNow();
      else restoreOriginal();
    }
    const showTooltipAfterDelay = (target) => {
      const text = target?.dataset?.tooltip;
      if (!text) return;
      if (tooltipTimer !== null) clearTimeout(tooltipTimer);
      tooltipTarget = target;
      tooltipTimer = setTimeout(() => {
        if (!tooltipTarget?.isConnected) return hideTooltip();
        tooltip.textContent = text;
        tooltip.hidden = false;
        const hostRect = uiHost.getBoundingClientRect();
        const targetRect = tooltipTarget.getBoundingClientRect();
        const sx = uiHost.offsetWidth / (hostRect.width || 1);
        const sy = uiHost.offsetHeight / (hostRect.height || 1);
        const left = Math.max(8, Math.min(uiHost.offsetWidth - tooltip.offsetWidth - 8, (targetRect.left - hostRect.left) * sx));
        let top = (targetRect.bottom - hostRect.top) * sy + 6;
        if (top + tooltip.offsetHeight > uiHost.offsetHeight) top = Math.max(4, (targetRect.top - hostRect.top) * sy - tooltip.offsetHeight - 6);
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
        tooltipTimer = null;
      }, 400);
    };
    shadow.addEventListener("pointerover", (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-tooltip]") : null;
      if (target && !target.contains(event.relatedTarget)) showTooltipAfterDelay(target);
    });
    shadow.addEventListener("pointerout", (event) => {
      if (tooltipTarget && !tooltipTarget.contains(event.relatedTarget)) hideTooltip();
    });
    shadow.addEventListener("focusin", (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-tooltip]") : null;
      if (target) showTooltipAfterDelay(target);
    });
    shadow.addEventListener("focusout", (event) => {
      if (tooltipTarget && !tooltipTarget.contains(event.relatedTarget)) hideTooltip();
    });
    function setPanelTab(value, persist = true) {
      if (!["image", "filters", "frames", "info"].includes(value)) return;
      panelTab = value;
      for (const tab of tabButtons) {
        const selected = tab.dataset.tab === value;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
      }
      for (const page of tabPages) {
        const active = page.dataset.page === value;
        page.classList.toggle("is-active", active);
        page.hidden = !active;
      }
      tabContent.scrollTop = 0;
      requestAnimationFrame(updateTabScrollFade);
      if (persist) saveSitePreference({ panelTab: value });
    }
    function updateTabScrollFade() {
      const hasOverflow = tabContent.scrollHeight > tabContent.clientHeight + 1;
      const atEnd = tabContent.scrollTop + tabContent.clientHeight >= tabContent.scrollHeight - 2;
      tabContent.dataset.scrollEnd = String(!hasOverflow || atEnd);
    }
    tabContent.addEventListener("scroll", updateTabScrollFade, { passive: true });
    const tabContentResizeObserver = new ResizeObserver(updateTabScrollFade);
    tabContentResizeObserver.observe(tabContent);
    for (const page of tabPages) tabContentResizeObserver.observe(page);
    updateTabScrollFade();
    setPanelTab(panelTab, false);
    for (const tab of tabButtons) tab.addEventListener("click", (event) => {
      event.stopPropagation();
      setPanelTab(tab.dataset.tab);
    });
    reopenIndicator.addEventListener("pointerdown", (event) => event.stopPropagation(), true);
    reopenIndicator.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setPanelManuallyHidden(false);
    });
    fpsHud.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const hostRect = uiHost.getBoundingClientRect();
      const sx = uiHost.offsetWidth / (hostRect.width || 1);
      const sy = uiHost.offsetHeight / (hostRect.height || 1);
      const rect = fpsHud.getBoundingClientRect();
      const x = fpsHudPositionLocal ? fpsHudPositionLocal.x : (rect.left - hostRect.left) * sx;
      const y = fpsHudPositionLocal ? fpsHudPositionLocal.y : (rect.top - hostRect.top) * sy;
      draggingFpsHud = true;
      fpsHud.dataset.dragging = "true";
      fpsHudDragState = { pointerId: event.pointerId, sx, sy, ox: event.clientX * sx - hostRect.left * sx - x, oy: event.clientY * sy - hostRect.top * sy - y };
      fpsHud.setPointerCapture(event.pointerId);
      applyFpsHudPosition({ x, y });
    });
    fpsHud.addEventListener("pointermove", (event) => {
      if (!draggingFpsHud || fpsHudDragState?.pointerId !== event.pointerId) return;
      const rect = uiHost.getBoundingClientRect();
      applyFpsHudPosition({ x: event.clientX * fpsHudDragState.sx - rect.left * fpsHudDragState.sx - fpsHudDragState.ox, y: event.clientY * fpsHudDragState.sy - rect.top * fpsHudDragState.sy - fpsHudDragState.oy });
    });
    const finishHudDrag = (event) => {
      if (!draggingFpsHud || fpsHudDragState?.pointerId !== event.pointerId) return;
      draggingFpsHud = false;
      fpsHud.removeAttribute("data-dragging");
      fpsHudDragState = null;
      if (fpsHud.hasPointerCapture(event.pointerId)) fpsHud.releasePointerCapture(event.pointerId);
      chooseFpsHudPosition(fpsHudPositionLocal);
    };
    fpsHud.addEventListener("pointerup", finishHudDrag);
    fpsHud.addEventListener("pointercancel", finishHudDrag);
    fpsHud.addEventListener("dblclick", (event) => {
      event.preventDefault(); event.stopPropagation();
      fpsHudPositionLocal = null;
      fpsHud.removeAttribute("data-positioned");
      fpsHud.style.removeProperty("left"); fpsHud.style.removeProperty("top"); fpsHud.style.removeProperty("right");
      chooseFpsHudPosition(null);
    });
    canvas.style.setProperty("pointer-events", "none", "important");
    video.insertAdjacentElement("afterend", canvas);
    canvas.insertAdjacentElement("afterend", uiHost);
    uiHost.insertAdjacentElement("afterend", compareHost);

    function updateComparisonPosition(event) {
      const rect = compareHost.getBoundingClientRect();
      if (!rect.width) return;
      comparisonPosition = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      canvas.style.clipPath = `inset(0 0 0 ${comparisonPosition * 100}%)`;
      dividerLine.style.left = `${comparisonPosition * 100}%`;
      dividerGrip.style.left = `${comparisonPosition * 100}%`;
      placeOverlay();
      layoutComparisonLabels(true);
    }
    dividerGrip.addEventListener("pointerdown", (event) => {
      if (!comparisonEnabled || originalPreviewHeld) return;
      event.preventDefault();
      event.stopPropagation();
      draggingDivider = true;
      dividerGrip.setPointerCapture(event.pointerId);
      updateComparisonPosition(event);
    });
    dividerGrip.addEventListener("pointermove", (event) => {
      if (draggingDivider) updateComparisonPosition(event);
    });
    const stopDividerDrag = (event) => {
      if (!draggingDivider) return;
      draggingDivider = false;
      if (dividerGrip.hasPointerCapture(event.pointerId)) dividerGrip.releasePointerCapture(event.pointerId);
    };
    dividerGrip.addEventListener("pointerup", stopDividerDrag);
    dividerGrip.addEventListener("pointercancel", stopDividerDrag);

    shadow.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      event.stopPropagation();
      if (button.id === "dismiss") {
        setPanelManuallyHidden(true);
        return;
      }
      if (button.id === "ai-improve") { void startAiImproveFrame(); return; }
      if (button.id === "ai-cancel") { cancelAiImproveFrame(); showToast("Procesamiento de foto cancelado"); return; }
      if (button.id === "ai-toggle-preview") {
        if (!aiResultReady) return;
        aiPreviewActive = !aiPreviewActive;
        button.textContent = aiPreviewActive ? "Ver Anime4K" : "Ver IA";
        refreshComparisonPresentation();
        placeOverlay();
        if (aiPreviewActive) void renderCurrentFrame();
        else redrawNow();
        return;
      }
      if (button.id === "ai-save") {
        if (!aiResultReady || !video.paused) return;
        aiResultCanvas.toBlob((blob) => {
          if (!blob) { showToast("No se pudo generar el PNG"); return; }
          const date = new Date();
          const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}-${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}`;
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = `anime4k-ia-${stamp}.png`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          showToast("PNG guardado");
        }, "image/png");
        return;
      }
      if (button.id === "minimize") {
        panelMinimized = !panelMinimized;
        panel.dataset.minimized = String(panelMinimized);
        button.setAttribute("aria-label", panelMinimized ? "Expandir panel" : "Minimizar panel");
        button.dataset.tooltip = panelMinimized ? "Expandir panel" : "Minimizar panel";
        button.innerHTML = panelMinimized ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M12 5v14"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>';
        saveSitePreference({ panelMinimized });
        refreshBadge();
        return;
      }
      if (button.id === "deactivate-site") {
        deactivateCurrentSite();
        return;
      }
      if (button.id === "recommended-preset") {
        chooseMode("A");
        chooseQuality("Fast");
        chooseScale("Auto");
        setPanelTab("image");
        showToast("Ajustes recomendados aplicados");
        return;
      }
      if (button.id === "save-preset") {
        const myPreset = { mode: activeMode, quality: activeQuality, scale: outputScale, sharpeningEnabled, sharpeningIntensity, lineEnhancementIntensity };
        saveSitePreference({ myPreset });
        button.textContent = "Preset guardado";
        showToast("Preset guardado");
        setTimeout(() => { if (button.isConnected) button.textContent = "Guardar como mi preset"; }, 1800);
        return;
      }
      if (button.id === "reset-site") {
        const retained = { activated: true, enabled: overlayEnabled, panelManuallyHidden, panelPosition: null, panelTab: "image", fpsHudPosition: null, comparisonLabelsVisible: true };
        if (comparisonEnabled) chooseComparison(false);
        applySiteRecord(retained);
        saveSiteRecord();
        setPanelTab("image", false);
        showToast("Sitio restablecido");
        return;
      }
      if (button.id === "fluencyTargetAuto") {
        chooseFluencyTarget("Auto");
        return;
      }
      if (button.id === "target-minus" || button.id === "target-plus") {
        if (button.dataset.longRepeated === "true") { delete button.dataset.longRepeated; return; }
        const current = fluencyTarget === "Auto" ? Math.round(getExpectedOutputFps()) : Number(fluencyTarget);
        chooseFluencyTarget(Math.min(240, Math.max(24, current + (button.id === "target-plus" ? 1 : -1))));
        return;
      }
      const group = button.closest("[data-setting]")?.dataset.setting;
      const value = button.matches('[role="switch"]')
        ? (getSwitchState(group) ? "off" : "on")
        : button.dataset.value;
      if (group === "enabled") chooseEnabled(value === "on");
      else if (group === "mode") chooseMode(value);
      else if (group === "quality") chooseQuality(value);
      else if (group === "compare") chooseComparison(value === "on");
      else if (group === "compareLabels") chooseComparisonLabels(value === "on");
      else if (group === "scale") chooseScale(value === "Auto" ? "Auto" : Number(value));
      else if (group === "detail") chooseDetail(value === "on");
      else if (group === "detailSize") chooseDetailSize(value);
      else if (group === "sharpening") chooseOptionalFilter("sharpen", value === "on");
      else if (group === "lineMaskDebug") chooseLineMaskDebug(value === "on");
      else if (group === "fluency") chooseFluency(value === "on");
      else if (group === "interpolationMode") chooseInterpolationMode(value);
      else if (group === "fluencyControlMode") chooseFluencyControlMode(value);
      else if (group === "fluencyMultiplier") chooseFluencyMultiplier(Number(value));
      if (button.matches('[role="switch"]')) renderSwitch(button);
    });
    fluencyTargetInput.addEventListener("change", () => {
      const value = Math.min(240, Math.max(24, Number(fluencyTargetInput.value)));
      chooseFluencyTarget(value);
    });
    for (const stepButton of shadow.querySelectorAll("#target-minus,#target-plus")) {
      let repeatDelay = null;
      let repeatTimer = null;
      const changeTarget = () => {
        const current = fluencyTarget === "Auto" ? Math.round(getExpectedOutputFps()) : Number(fluencyTarget);
        chooseFluencyTarget(Math.min(240, Math.max(24, current + (stepButton.id === "target-plus" ? 1 : -1))));
        stepButton.dataset.longRepeated = "true";
      };
      const stopRepeat = () => { clearTimeout(repeatDelay); clearInterval(repeatTimer); repeatDelay = repeatTimer = null; };
      stepButton.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        delete stepButton.dataset.longRepeated;
        repeatDelay = setTimeout(() => { changeTarget(); repeatTimer = setInterval(changeTarget, 95); }, 380);
      });
      stepButton.addEventListener("pointerup", stopRepeat);
      for (const eventName of ["pointercancel", "pointerleave", "blur"]) stepButton.addEventListener(eventName, () => { stopRepeat(); delete stepButton.dataset.longRepeated; });
    }
    detailSlider.addEventListener("input", () => chooseDetailIntensity(Number(detailSlider.value) / 200));
    detailSlider.addEventListener("change", () => chooseDetailIntensity(Number(detailSlider.value) / 200, true));
    sharpeningSlider.addEventListener("input", () => chooseOptionalFilterIntensity("sharpen", Number(sharpeningSlider.value) / 100));
    sharpeningSlider.addEventListener("change", () => chooseOptionalFilterIntensity("sharpen", Number(sharpeningSlider.value) / 100, true));
    lineEnhancementSlider.addEventListener("input", () => chooseLineEnhancementIntensity(Number(lineEnhancementSlider.value) / 100));
    lineEnhancementSlider.addEventListener("change", () => chooseLineEnhancementIntensity(Number(lineEnhancementSlider.value) / 100, true));
    const interactivePanelSelector = "button,[role='switch'],[role='tab'],label,input,select,textarea,a,summary,.segments,.help,#dismiss,#fluencyTargetAuto,#fps-hud";
    panel.addEventListener("pointerdown", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const blocked = target?.closest(interactivePanelSelector);
      const scrollArea = target?.closest("#tab-content");
      const scrollRect = scrollArea?.getBoundingClientRect();
      const onScrollbar = scrollRect && event.clientX >= scrollRect.right - 12;
      if (draggingPanel || event.button !== 0) return;
      if (blocked || onScrollbar || panelManuallyHidden) { panelDragState = null; return; }
      const hostRect = uiHost.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const scaleX = uiHost.offsetWidth / (hostRect.width || 1);
      const scaleY = uiHost.offsetHeight / (hostRect.height || 1);
      const currentX = panelPosition ? panelPosition.x : (panelRect.left - hostRect.left) * scaleX;
      const currentY = panelPosition ? panelPosition.y : (panelRect.top - hostRect.top) * scaleY;
      panelDragState = {
        pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
        startPosition: { x: currentX, y: currentY },
        offsetX: event.clientX * scaleX - (hostRect.left * scaleX + currentX),
        offsetY: event.clientY * scaleY - (hostRect.top * scaleY + currentY), scaleX, scaleY,
        dragging: false
      };
    });
    panel.addEventListener("wheel", (event) => {
      const scrollArea = event.target instanceof Element ? event.target.closest("#tab-content") : null;
      if (!scrollArea) {
        event.preventDefault();
        return;
      }
      const canScroll = scrollArea.scrollHeight > scrollArea.clientHeight + 1 &&
        (event.deltaY < 0 ? scrollArea.scrollTop > 0 : scrollArea.scrollTop + scrollArea.clientHeight < scrollArea.scrollHeight - 1);
      if (!canScroll) event.preventDefault();
    }, { passive: false });
    panel.addEventListener("pointermove", (event) => {
      if (!draggingPanel || panelDragState?.pointerId !== event.pointerId) return;
      const hostRect = uiHost.getBoundingClientRect();
      const x = event.clientX * panelDragState.scaleX - hostRect.left * panelDragState.scaleX - panelDragState.offsetX;
      const y = event.clientY * panelDragState.scaleY - hostRect.top * panelDragState.scaleY - panelDragState.offsetY;
      applySavedPanelPosition({ x, y });
      layoutComparisonLabels(true);
    });
    panel.addEventListener("pointermove", (event) => {
      if (draggingPanel || panelDragState?.pointerId !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - panelDragState.startX, event.clientY - panelDragState.startY);
      if (distance < 4) return;
      event.preventDefault();
      event.stopPropagation();
      draggingPanel = true;
      panel.dataset.dragging = "true";
      if (panelHideTimer !== null) clearTimeout(panelHideTimer);
      panelHideTimer = null;
      panelPosition = panelDragState.startPosition;
      applySavedPanelPosition(panelPosition);
      if (!panel.hasPointerCapture(event.pointerId)) panel.setPointerCapture(event.pointerId);
      const hostRect = uiHost.getBoundingClientRect();
      const x = event.clientX * panelDragState.scaleX - hostRect.left * panelDragState.scaleX - panelDragState.offsetX;
      const y = event.clientY * panelDragState.scaleY - hostRect.top * panelDragState.scaleY - panelDragState.offsetY;
      applySavedPanelPosition({ x, y });
      layoutComparisonLabels(true);
    });
    const stopPanelDrag = (event) => {
      if (panelDragState?.pointerId !== event.pointerId) return;
      if (!draggingPanel) { panelDragState = null; return; }
      draggingPanel = false;
      panel.removeAttribute("data-dragging");
      const position = { x: Number.parseFloat(panel.style.left) || 0, y: Number.parseFloat(panel.style.top) || 0 };
      panelDragState = null;
      if (panel.hasPointerCapture(event.pointerId)) panel.releasePointerCapture(event.pointerId);
      choosePanelPosition(position);
      revealPanel();
    };
    panel.addEventListener("pointerup", stopPanelDrag);
    panel.addEventListener("pointercancel", stopPanelDrag);
    panel.addEventListener("dblclick", (event) => {
      if (event.target.closest("button,input,select,textarea,a,summary,[role=tab],[role=switch],.segments")) return;
      event.preventDefault();
      event.stopPropagation();
      resetPanelPosition();
    });
    statsDetails.addEventListener("toggle", () => {
      revealPanel();
    });
    panel.addEventListener("pointerdown", revealPanel, true);

    let hiddenOriginal = false;
    let hasReadableFrame = false;
    const originalOpacity = video.style.getPropertyValue("opacity");
    const originalOpacityPriority = video.style.getPropertyPriority("opacity");
    let callbackId = null;
    let stopped = false;
    let lastLogKey = "";
    let canvasZIndex = Math.max(1, (Number.parseInt(getComputedStyle(video).zIndex, 10) || 0) + 1);
    const changedControls = new Map();
    let gpuState = null;
    let gpuFailed = false;
    let gpuStatus = "Preparando WebGPU…";
    let frameMilliseconds = null;
    let interpolationMilliseconds = 0;
    let fluencyDegraded = false;
    let fluencyDegradedSince = null;
    let fluencyRenderSamples = [];
    let filterTimingFrameCounter = 0;
    let interpolatedFrames = 0;
    let repeatedFrames = 0;
    let skippedFrames = 0;
    let interpolationHistory = null;
    let interpolationTimer = null;
    let interpolationRaf = null;
    let interpolationSamples = [];
    let interpolationWarning = "";
    let fluencyFailureNotice = "";
    let fluencyFailureNoticeTimer = null;
    let canvasOutputSequence = 0;
    let lastCanvasOutputPresented = 0;
    let pendingCanvasOutput = null;
    let canvasPresentationRaf = null;
    let outputPresentationTimes = [];
    let outputFps = 0;
    let intermediateOutputsPresented = 0;
    let realOutputsPresented = 0;
    let outputFramesDropped = 0;
    const presentationQueue = [];
    let presentationRaf = null;
    let fluencyGpuCommandsInFlight = 0;
    let previousFrameTiming = null;
    let fluencyProcessing = Promise.resolve();
    let fluencyGeneration = 0;
    let detailFilterMilliseconds = null;
    let sharpeningFilterMilliseconds = null;
    let sharpeningPassLogged = false;
    let lineMaskDebugLogged = false;
    let frameBudgetMs = 1000 / 24;
    let measuredRefreshHz = 60;
    let refreshMeasurementId = 0;
    let fluencyTargetWarning = "";
    let fluencyTargetWarningTimer = null;
    let overBudgetSince = null;
    let performanceSamples = [];
    let performanceWarning = "";
    let resizeTimer = null;
    let renderingFrame = false;
    let renderLockPromise = Promise.resolve();
    let lastPanelCornerCheck = 0;

    function getSourceFps() {
      return videoFpsMeasured;
    }

    function getEffectiveFluencyMultiplier() {
      const fps = getSourceFps();
      return fluencyControlMode === "multiplier" ? fluencyMultiplier : fps > 0 ? getExpectedOutputFps() / fps : 1;
    }

    function getExpectedOutputFps() {
      if (fluencyControlMode === "multiplier") return videoFpsMeasured * fluencyMultiplier;
      const desired = fluencyTarget === "Auto" ? Math.min(240, measuredRefreshHz) : Number(fluencyTarget);
      return desired < videoFpsMeasured ? videoFpsMeasured : desired;
    }

    function getMaximumIntermediatesPerFrame() {
      const ratio = getEffectiveFluencyMultiplier();
      if (ratio <= 1) return 0;
      return fluencyControlMode === "multiplier" ? fluencyMultiplier - 1 : Math.max(0, Math.ceil(ratio - 1e-8) - 1);
    }

    function nextOutputFrameCount() {
      const ratio = getEffectiveFluencyMultiplier();
      if (ratio <= 1) { fractionalFrameAccumulator = 0; return 1; }
      if (fluencyControlMode === "multiplier") return fluencyMultiplier;
      const accumulated = ratio + fractionalFrameAccumulator;
      const frameCount = Math.max(1, Math.floor(accumulated + 1e-8));
      fractionalFrameAccumulator = accumulated - frameCount;
      return frameCount;
    }

    function updateFluencyTargetWarning(show = true) {
      const fps = videoFpsMeasured;
      const requested = fluencyTarget === "Auto" ? measuredRefreshHz : Number(fluencyTarget);
      const closest = Math.max(fps, Math.min(measuredRefreshHz, requested));
      const issues = [];
      if (fluencyControlMode === "target" && fluencyTarget === "Auto" && measuredRefreshHz < fps) issues.push(`el refresco medido (${measuredRefreshHz.toFixed(0)} Hz) es menor que el video (${fps.toFixed(2)} fps)`);
      if (fluencyControlMode === "target" && fluencyTarget !== "Auto" && Number(fluencyTarget) > measuredRefreshHz + 1) issues.push(`supera el refresco medido (${measuredRefreshHz.toFixed(0)} Hz)`);
      if (fluencyControlMode === "target" && fluencyTarget !== "Auto" && Number(fluencyTarget) < fps) issues.push(`es menor que el video (${fps.toFixed(2)} fps); no se interpolará`);
      fluencyTargetWarning = issues.length ? `Objetivo ${fluencyTarget === "Auto" ? "Auto" : `${Number(fluencyTarget).toFixed(1)} fps`}: ${issues.join(" y ")}; sugerencia cercana: ${closest} fps.` : "";
      if (fluencyTargetWarningTimer !== null) clearTimeout(fluencyTargetWarningTimer);
      if (show && fluencyTargetWarning) fluencyTargetWarningTimer = setTimeout(() => { fluencyTargetWarning = ""; refreshBadge(); }, 4500);
      if (show && fluencyTargetWarning) say(fluencyTargetWarning);
      return fluencyTargetWarning;
    }

    function measureMonitorRefresh() {
      const token = ++refreshMeasurementId;
      const samples = [];
      let previous = null;
      const sample = (timestamp) => {
        if (token !== refreshMeasurementId || stopped || !fluencyEnabled || document.hidden) return;
        if (previous !== null) {
          const delta = timestamp - previous;
          if (delta >= 5 && delta <= 50) samples.push(delta);
        }
        previous = timestamp;
        if (samples.length < 36) { requestAnimationFrame(sample); return; }
        const sorted = [...samples].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const nextRefresh = Math.max(20, Math.min(360, 1000 / median));
        const changed = Math.abs(nextRefresh - measuredRefreshHz) > 2;
        measuredRefreshHz = nextRefresh;
        updateFluencyTargetWarning(true);
        if (changed && gpuState && fluencyEnabled) {
          if (gpuState.fluencyPool && gpuState.fluencyPoolIntermediates !== getMaximumIntermediatesPerFrame()) resetInterpolationHistory("cambio del refresco medido");
          ensureInterpolationResources(gpuState);
        }
        refreshBadge();
      };
      requestAnimationFrame(sample);
    }

    function getAutoScale() {
      const sourceHeight = video.videoHeight;
      if (!sourceHeight) return 1;
      if (sourceHeight <= 480) return 2;
      if (sourceHeight <= 900) return 1.5;
      return 1;
    }

    function getEffectiveScale() {
      if (outputScale === "Auto") return getAutoScale();
      return document.fullscreenElement ? 1 : outputScale;
    }

    function renderSwitch(button) {
      if (!button?.matches('[role="switch"]')) return;
      const settingName = button.closest("[data-setting]")?.dataset.setting;
      button.setAttribute("aria-checked", String(getSwitchState(settingName)));
    }

    function refreshBadge() {
      panel.dataset.minimized = String(panelMinimized);
      const minimizeButton = shadow.querySelector("#minimize");
      if (minimizeButton && !minimizeButton.matches(":focus")) {
        minimizeButton.setAttribute("aria-label", panelMinimized ? "Expandir panel" : "Minimizar panel");
        minimizeButton.dataset.tooltip = panelMinimized ? "Expandir panel" : "Minimizar panel";
        minimizeButton.innerHTML = panelMinimized ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M12 5v14"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>';
      }
      const measuredFps = Math.max(0, videoFpsMeasured);
      shadow.querySelector("#frame-stat-video").textContent = `${measuredFps.toFixed(1)} fps`;
      shadow.querySelector("#frame-stat-output").textContent = `${Math.max(0, outputFps).toFixed(1)} fps`;
      shadow.querySelector("#frame-stat-render").textContent = `${frameMilliseconds === null ? "—" : frameMilliseconds.toFixed(1)} ms`;
      shadow.querySelector("#frame-stat-generated").textContent = `${Math.max(0, outputFps - measuredFps).toFixed(1)}/s`;
      for (const factor of [2, 3, 4]) shadow.querySelector(`#multiplier-fps-${factor}`).textContent = `${(measuredFps * factor).toFixed(0)} fps`;
      const input = video.videoWidth && video.videoHeight ? `${video.videoWidth}×${video.videoHeight}` : "—";
      const output = gpuState?.animePipeline?.getOutputTexture?.();
      const outputSize = output ? `${output.width}×${output.height}` : "—";
      const noUpscale = output && output.width <= video.videoWidth && output.height <= video.videoHeight;
      const scaleLabel = output ? (noUpscale
        ? " (sin escalado)"
        : ` (escala ${ (output.width / video.videoWidth).toFixed(2) }× horizontal, ${ (output.height / video.videoHeight).toFixed(2) }× vertical)`) : "";
      const timing = frameMilliseconds === null ? "calculando…" : `Render real (CPU + cola GPU): ${frameMilliseconds.toFixed(1)} ms`;
      const target = `${canvas.width}×${canvas.height}`;
      const fullscreen = Boolean(document.fullscreenElement);
      const effectiveScale = getEffectiveScale();
      const scaleText = outputScale === "Auto"
        ? `Auto (${effectiveScale}× aplicada)`
        : fullscreen ? `1× (pantalla completa; guardada ${outputScale}×)` : `${effectiveScale}×`;
      const budget = `${frameBudgetMs.toFixed(1)} ms (${(1000 / frameBudgetMs).toFixed(0)} fps)`;
      const warning = `${performanceWarning ? `\n${performanceWarning}` : ""}${interpolationWarning ? `\n${interpolationWarning}` : ""}${fluencyTargetWarning ? `\n${fluencyTargetWarning}` : ""}${fluencyDegraded ? "\nGeneración de fotogramas pausó los intermedios por carga; mostrando frames reales." : ""}${fluencyFailureNotice ? `\n${fluencyFailureNotice}` : ""}`;
      const timingText = (value) => value !== null ? `+${value.toFixed(2)} ms/frame` : gpuState && !gpuState.timestampQuerySet ? "medición GPU no disponible" : "midiendo…";
      const filterTimings = `Detalle: ${detailEnabled ? timingText(detailFilterMilliseconds) : "apagado"}\nNitidez: ${sharpeningEnabled ? timingText(sharpeningFilterMilliseconds) : "apagada"}`;
      const effectiveRatio = getEffectiveFluencyMultiplier();
      const ratioLabel = effectiveRatio.toFixed(2).replace(/0+$/, "").replace(/\.$/, "").replace(".", ",");
      const expectedFps = getExpectedOutputFps();
      const interpolationText = fluencyEnabled && videoFpsMeasured < 48
        ? `Generación de fotogramas ${interpolationMode === "mix" ? "Mezcla" : "Movimiento"} · ${fluencyControlMode === "multiplier" ? "Multiplicador" : "Objetivo"}: x${ratioLabel} | Salida esperada: ${expectedFps.toFixed(1)} fps | Refresco ${measuredRefreshHz.toFixed(0)} Hz | +${interpolationMilliseconds.toFixed(2)} ms/frame | Intermedios generados ${interpolatedFrames}, repetidos ${repeatedFrames}, salteados ${skippedFrames}\nSalida observada por requestAnimationFrame: ${outputFps.toFixed(1)} fps | Presentados: ${intermediateOutputsPresented} intermedios + ${realOutputsPresented} reales | En cola omitidos: ${outputFramesDropped}`
        : videoFpsMeasured >= 48 ? "Generación de fotogramas deshabilitada: video a 48 fps o más" : "Generación de fotogramas apagada";
      const note = shadow.querySelector("#fluency-note");
      if (note) note.textContent = videoFpsMeasured >= 48 ? "(deshabilitada: video ≥48 fps)" : fluencyTargetWarning ? `(${fluencyTargetWarning})` : fluencyControlMode === "multiplier" ? `(x${fluencyMultiplier})` : fluencyTarget === "Auto" ? `(Auto · ${measuredRefreshHz.toFixed(0)} Hz)` : `(objetivo ${Number(fluencyTarget).toFixed(1)} fps)`;
      stats.textContent = `${gpuStatus}\nEntrada: ${input} | Salida: ${outputSize}${scaleLabel}\nEscala: ${scaleText} | Canvas: ${target}\n${timing} | Presupuesto: ${budget}\n${filterTimings}\n${interpolationText}${warning}`;
      const animeEstimate = frameMilliseconds === null ? null : Math.max(0, frameMilliseconds - filterTimingTotal());
      const detailHudTime = `Detalle ${detailSizeMode} ${detailEnabled ? timingText(detailFilterMilliseconds) : "apagado"}`;
      fpsHudRenderTimes.textContent = activeQuality === "Máxima"
        ? `Anime4K ${animeEstimate === null ? "—" : animeEstimate.toFixed(1)} ms/frame · Filtros ${filterTimingTotal().toFixed(1)} ms · ${detailHudTime}`
        : `Anime4K ~${animeEstimate === null ? "—" : animeEstimate.toFixed(1)} ms · Filtros ${filterTimingTotal().toFixed(1)} ms · ${detailHudTime} · Generación de fotogramas ${interpolationMilliseconds.toFixed(1)} ms`;
      const maxWarning = shadow.querySelector("#fps-hud-max-warning");
      maxWarning.hidden = activeQuality !== "Máxima" || !/^Calidad Máxima/.test(performanceWarning);
      maxWarning.textContent = maxWarning.hidden ? "" : performanceWarning;
      stats.classList.toggle("warn", frameMilliseconds !== null && frameMilliseconds > frameBudgetMs);
      const selected = { enabled: overlayEnabled ? "on" : "off", mode: activeMode, quality: activeQuality, compare: comparisonEnabled ? "on" : "off", compareLabels: comparisonLabelsVisible ? "on" : "off", scale: String(outputScale), detail: detailEnabled ? "on" : "off", detailSize: detailSizeMode, sharpening: sharpeningEnabled ? "on" : "off", lineMaskDebug: lineMaskDebugEnabled ? "on" : "off", fluency: fluencyEnabled ? "on" : "off", interpolationMode, fluencyControlMode, fluencyMultiplier: String(fluencyMultiplier) };
      for (const button of shadow.querySelectorAll("[data-setting] button, button[data-setting][role='switch']")) {
        const settingName = button.closest("[data-setting]").dataset.setting;
        const isSwitch = button.matches('[role="switch"]');
        const isSelected = isSwitch ? getSwitchState(settingName) : button.dataset.value === selected[settingName];
        if (isSwitch) renderSwitch(button);
        else button.setAttribute("aria-pressed", String(isSelected));
        if (button.closest("[data-setting]").dataset.setting === "lineMaskDebug") button.disabled = !sharpeningEnabled;
        if (button.closest("[data-setting]").dataset.setting === "compare") button.disabled = !overlayEnabled;
        if (button.closest("[data-setting]").dataset.setting === "fluency") button.disabled = videoFpsMeasured >= 48;
      }
      statusDot.classList.toggle("is-on", overlayEnabled);
      statusDot.setAttribute("aria-label", overlayEnabled ? "Filtro activo" : "Filtro inactivo");
      const multiplierControl = shadow.querySelector("#multiplier-control");
      const targetControl = shadow.querySelector("#target-control");
      const multiplierDisabled = fluencyControlMode !== "multiplier";
      const targetDisabled = fluencyControlMode !== "target";
      multiplierControl.classList.toggle("is-disabled", multiplierDisabled);
      targetControl.classList.toggle("is-disabled", targetDisabled);
      for (const button of multiplierControl.querySelectorAll("button")) button.disabled = multiplierDisabled;
      fluencyTargetInput.disabled = targetDisabled;
      fluencyTargetInput.value = fluencyTarget === "Auto" ? Math.min(240, measuredRefreshHz).toFixed(1) : String(fluencyTarget);
      fluencyTargetAuto.disabled = targetDisabled;
      fluencyTargetAuto.setAttribute("aria-pressed", String(fluencyTarget === "Auto"));
      compareVisuals.classList.toggle("labels-hidden", !comparisonLabelsVisible);
      detailSlider.value = String(Math.round(detailIntensity * 200));
      detailSlider.disabled = !detailEnabled;
      detailSlider.closest(".intensity-setting").hidden = !detailEnabled;
      detailValue.textContent = `${Math.round(detailIntensity * 200)}%`;
      sharpeningSlider.value = String(Math.round(sharpeningIntensity * 100));
      sharpeningSlider.disabled = !sharpeningEnabled;
      sharpeningSlider.closest(".intensity-setting").hidden = !sharpeningEnabled;
      sharpeningValue.textContent = `${Math.round(sharpeningIntensity * 100)}%`;
      lineEnhancementSlider.value = String(Math.round(lineEnhancementIntensity * 100));
      lineEnhancementSlider.disabled = !sharpeningEnabled;
      lineEnhancementSlider.closest(".intensity-setting").hidden = !sharpeningEnabled;
      updateFpsHud();
      lineEnhancementValue.textContent = `${Math.round(lineEnhancementIntensity * 100)}%`;
      panel.dataset.enabled = String(overlayEnabled);
      refreshShortcutLabels();
    }

    function refreshShortcutLabels() {
      for (const keycap of shadow.querySelectorAll("[data-shortcut]")) keycap.textContent = displayShortcutKey(shortcuts[keycap.dataset.shortcut]);
      const modeKeycap = shadow.querySelector('[data-shortcut-range="mode"]');
      if (modeKeycap) {
        const modeKeys = [shortcuts.modeA, shortcuts.modeB, shortcuts.modeC];
        modeKeycap.textContent = modeKeys.join(",") === "1,2,3" ? "1-3" : modeKeys.map(displayShortcutKey).join(" · ");
      }
      statsDetails.dataset.tooltip = `Mostrar/ocultar estadísticas (${displayShortcutKey(shortcuts.stats)})`;
      fpsHud.dataset.tooltip = `Contador de FPS; arrastrá para mover, doble clic para restablecer (${displayShortcutKey(shortcuts.fpsHud)})`;
      dismissButton.dataset.tooltip = `Ocultar panel; mostrar con ${displayShortcutKey(shortcuts.togglePanel)}`;
      reopenIndicator.dataset.tooltip = `Reabrir Anime4K (${displayShortcutKey(shortcuts.togglePanel)})`;
      for (const button of shadow.querySelectorAll('[data-setting="mode"] button')) {
        button.dataset.tooltip = `Modo ${button.dataset.value} (${displayShortcutKey(shortcuts[`mode${button.dataset.value}`])})`;
      }
      shadow.querySelector('[data-setting="quality"]').dataset.tooltip = `Cambiar calidad (${displayShortcutKey(shortcuts.quality)})`;
      shadow.querySelector('[data-setting="scale"]').dataset.tooltip = `Cambiar escala (${displayShortcutKey(shortcuts.scale)})`;
      shadow.querySelector('[data-setting="compare"]').dataset.tooltip = `Comparar original y Anime4K (${displayShortcutKey(shortcuts.compare)})`;
      shadow.querySelector('[data-setting="fluency"]').dataset.tooltip = `Generación de fotogramas experimental. Activar o desactivar con ${displayShortcutKey(shortcuts.fluency)}; si el equipo no alcanza el rendimiento, se mostrarán solo frames reales.`;
    }

    function restoreOriginal() {
      if (!hiddenOriginal) return;
      if (originalOpacity) video.style.setProperty("opacity", originalOpacity, originalOpacityPriority);
      else video.style.removeProperty("opacity");
      hiddenOriginal = false;
    }

    function setEnabled(enabled) {
      if (!enabled) releaseInterpolationResources(gpuState);
      else if (fluencyEnabled && videoFpsMeasured < 48) setFluency(true, interpolationMode, fluencyControlMode, fluencyMultiplier, fluencyTarget);
      if (enabled && hasReadableFrame && !gpuFailed && document.fullscreenElement !== video && !comparisonEnabled && !originalPreviewHeld) {
        video.style.setProperty("opacity", "0", "important");
        hiddenOriginal = true;
      } else {
        restoreOriginal();
      }
      syncControlStacking(enabled);
      refreshComparisonPresentation();
      placeOverlay();
      logPlayerTree();
      refreshBadge();
      revealPanel();
      if (enabled) {
        redrawNow();
      }
    }

    function syncFullscreenLayer() {
      const fullscreen = document.fullscreenElement;
      // Si el propio <video> entra en fullscreen, un canvas hermano no puede
      // cubrirlo. Devolvemos el video para que fullscreen siga mostrando imagen.
      if (fullscreen === video) {
        restoreOriginal();
        canvas.style.display = "none";
        compareHost.style.display = "none";
        return;
      }
      // El canvas sigue siendo hermano del video; si el contenedor entra en
      // fullscreen, ambos ya están dentro de ese mismo subárbol.
      if (!fullscreen && hasReadableFrame && overlayEnabled && !comparisonEnabled && !originalPreviewHeld) {
        video.style.setProperty("opacity", "0", "important");
        hiddenOriginal = true;
      }
      syncControlStacking(overlayEnabled);
      refreshComparisonPresentation();
      placeOverlay();
      revealPanel();
    }

    const frameType = () => {
      let inIframe = false;
      try { inIframe = window.top !== window; } catch { inIframe = true; }
      const src = video.currentSrc || video.src || "(sin src; puede usar <source> o MediaStream)";
      return `src: ${src} | blob: ${src.startsWith("blob:") ? "sí" : "no"} | iframe: ${inIframe ? "sí" : "no"}`;
    };

    function say(status, error = "") {
      const message = `[Anime4K diagnóstico] ${status} — ${frameType()}${error ? ` — ${error}` : ""}`;
      const logKey = `${status}|${frameType()}|${error}`;
      if (logKey !== lastLogKey) {
        console.info(message);
        lastLogKey = logKey;
      }
      gpuStatus = error ? `${status}: ${error}` : status;
      refreshBadge();
    }

    function makeRelativeIfNeeded(element) {
      if (getComputedStyle(element).position !== "static") return;
      if (!changedUiParentPositions.has(element)) {
        changedUiParentPositions.set(element, {
          value: element.style.getPropertyValue("position"),
          priority: element.style.getPropertyPriority("position")
        });
      }
      element.style.setProperty("position", "relative", "important");
    }

    function restoreUiParentPosition(element) {
      const previous = changedUiParentPositions.get(element);
      if (!previous) return;
      if (previous.value) element.style.setProperty("position", previous.value, previous.priority);
      else element.style.removeProperty("position");
      changedUiParentPositions.delete(element);
    }

    function moveUiTo(parent) {
      if (!parent || parent === video) return;
      if (uiParent !== parent) {
        restoreUiParentPosition(uiParent);
        makeRelativeIfNeeded(parent);
        parent.append(uiHost);
        parent.append(compareHost);
        uiParent = parent;
      } else makeRelativeIfNeeded(parent);
    }

    function refreshComparisonPresentation() {
      if (stopped) return;
      const processedEnabled = overlayEnabled || (aiPreviewActive && aiResultReady);
      const canCompare = comparisonEnabled && processedEnabled && hasReadableFrame && !gpuFailed && document.fullscreenElement !== video;
      const showOriginal = originalPreviewHeld || (canCompare && !originalPreviewHeld);
      if (showOriginal) restoreOriginal();
      else if (processedEnabled && hasReadableFrame && !gpuFailed && document.fullscreenElement !== video) {
        video.style.setProperty("opacity", "0", "important");
        hiddenOriginal = true;
      } else restoreOriginal();
      const showProcessed = processedEnabled && hasReadableFrame && !gpuFailed && document.fullscreenElement !== video && !originalPreviewHeld;
      canvas.style.clipPath = canCompare ? `inset(0 0 0 ${comparisonPosition * 100}%)` : "none";
      dividerLine.style.left = `${comparisonPosition * 100}%`;
      dividerGrip.style.left = `${comparisonPosition * 100}%`;
      compareHost.style.display = canCompare && !originalPreviewHeld ? "block" : "none";
      compareVisuals.classList.toggle("labels-hidden", !comparisonLabelsVisible);
      const processedLabel = compareShadow.querySelector("#anime-label");
      if (processedLabel) processedLabel.textContent = aiPreviewActive ? "Foto IA" : "Anime4K";
      // El estado visual se refleja también en el panel después de cambios por atajo.
      refreshBadge();
      return showProcessed;
    }

    function setComparison(enabled) {
      if (enabled && !overlayEnabled) return;
      refreshComparisonPresentation();
      placeOverlay();
      refreshBadge();
      revealPanel();
    }

    function setOriginalPreview(held) {
      refreshComparisonPresentation();
      placeOverlay();
      if (!held && overlayEnabled) redrawNow();
    }

    function setComparisonLabels(visible) {
      comparisonLabelsVisible = Boolean(visible);
      compareVisuals.classList.toggle("labels-hidden", !comparisonLabelsVisible);
      layoutComparisonLabels();
      refreshBadge();
    }

    function setPanelPosition(position) {
      applySavedPanelPosition(position);
      placeOverlay();
    }

    function applyFpsHudPosition(position) {
      const maxX = Math.max(0, uiHost.clientWidth - fpsHud.offsetWidth);
      const maxY = Math.max(0, uiHost.clientHeight - fpsHud.offsetHeight);
      const next = position && Number.isFinite(position.x) && Number.isFinite(position.y)
        ? { x: Math.min(maxX, Math.max(0, position.x)), y: Math.min(maxY, Math.max(0, position.y)) } : null;
      fpsHudPositionLocal = next;
      if (!next) {
        fpsHud.removeAttribute("data-positioned");
        for (const property of ["left", "top"]) fpsHud.style.removeProperty(property);
      } else {
        fpsHud.dataset.positioned = "true";
        fpsHud.style.left = `${next.x}px`;
        fpsHud.style.top = `${next.y}px`;
      }
      return next;
    }

    function setFpsHudPosition(position) {
      fpsHudPositionLocal = applyFpsHudPosition(position);
      placeOverlay();
    }

    function toggleFpsHud() {
      if (!siteActivated) return;
      fpsHudVisible = !fpsHudVisible;
      fpsHud.hidden = !fpsHudVisible;
      if (fpsHudVisible) {
        applyFpsHudPosition(fpsHudPositionLocal || fpsHudPosition);
        updateFpsHud();
      }
    }

    function updateFpsHud() {
      const videoFps = videoFpsMeasured;
      const ratio = getEffectiveFluencyMultiplier().toFixed(2).replace(/0+$/, "").replace(/\.$/, "").replace(".", ",");
      fpsHudVideo.textContent = `Video: ${videoFps.toFixed(2)} fps`;
      fpsHudOutput.textContent = `Salida: ${outputFps.toFixed(0)} fps`;
      const generated = Math.max(0, outputFps - videoFps);
      fpsHudGenerated.hidden = !fluencyEnabled;
      fpsHudGenerated.textContent = `Generados: +${generated.toFixed(0)}`;
      fpsHudMultiplier.hidden = !fluencyEnabled;
      fpsHudMultiplier.textContent = `Modo: ${fluencyControlMode === "multiplier" ? "Multiplicador" : "Objetivo"} · x${ratio}`;
      fpsHudExpected.hidden = !fluencyEnabled;
      fpsHudExpected.textContent = `Salida esperada: ${getExpectedOutputFps().toFixed(1)} fps`;
    }

    function filterTimingTotal() {
      return (detailEnabled ? (detailFilterMilliseconds || 0) : 0) + (sharpeningEnabled ? (sharpeningFilterMilliseconds || 0) : 0);
    }

    function applySavedPanelPosition(position) {
      if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
        panel.removeAttribute("data-positioned");
        for (const property of ["left", "top", "right", "bottom"]) panel.style.removeProperty(property);
        return null;
      }
      if (!uiHost.clientWidth || !uiHost.clientHeight) {
        panel.dataset.positioned = "true";
        panel.style.left = `${Math.max(0, position.x)}px`;
        panel.style.top = `${Math.max(0, position.y)}px`;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        return { x: Math.max(0, position.x), y: Math.max(0, position.y) };
      }
      const maxX = Math.max(0, uiHost.clientWidth - panel.offsetWidth);
      const maxY = Math.max(0, uiHost.clientHeight - panel.offsetHeight);
      const actual = { x: Math.max(0, Math.min(maxX, position.x)), y: Math.max(0, Math.min(maxY, position.y)) };
      panel.dataset.positioned = "true";
      panel.style.left = `${actual.x}px`;
      panel.style.top = `${actual.y}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      return actual;
    }

    function layoutComparisonLabels(force = false) {
      const original = compareShadow.querySelector("#original-label");
      const anime = compareShadow.querySelector("#anime-label");
      if (!comparisonLabelsVisible || !comparisonEnabled || compareHost.style.display === "none") {
        original.style.visibility = "hidden";
        anime.style.visibility = "hidden";
        return;
      }
      const width = compareHost.clientWidth;
      const height = compareHost.clientHeight;
      if (!width || !height) return;
      const now = performance.now();
      if (!force && lastCompareLabelLayout && now - lastCompareLabelLayout < 150) return;
      lastCompareLabelLayout = now;
      const dividerX = width * comparisonPosition;
      const gap = 12;
      const margin = 12;
      const leftAvailable = Math.max(0, dividerX - gap - margin);
      const rightAvailable = Math.max(0, width - dividerX - gap - margin);
      for (const [label, available, isLeft] of [[original, leftAvailable, true], [anime, rightAvailable, false]]) {
        if (available < 88) {
          label.style.visibility = "hidden";
          continue;
        }
        label.style.visibility = "hidden";
        label.style.display = "block";
        label.style.maxWidth = `${available}px`;
        const labelWidth = Math.min(label.scrollWidth + 22, available);
        const left = isLeft ? dividerX - gap - labelWidth : dividerX + gap;
        label.style.left = `${Math.max(margin, Math.min(width - margin - labelWidth, left))}px`;
        const obstacleRoot = document.fullscreenElement && document.fullscreenElement.contains(video) ? document.fullscreenElement : playerContainer;
        const controls = getControls(obstacleRoot).map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 8 && rect.height > 8);
        const captionSelector = "[class*='subtitle' i],[class*='caption' i],[class*='text-track' i],[data-subtitle]";
        const captions = [...obstacleRoot.querySelectorAll(captionSelector)].map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 8 && rect.height > 8);
        const panelRect = panel.getBoundingClientRect();
        const obstacles = [...controls, ...captions];
        if (panelVisible) obstacles.push(panelRect);
        let placed = false;
        const panelBelow = panelVisible ? panelRect.bottom - compareHost.getBoundingClientRect().top + 10 : 0;
        const candidates = [...new Set([12, 48, 84, 120, 156, panelBelow])].filter((y) => y >= 8).sort((a, b) => a - b);
        for (const y of candidates) {
          if (y + label.offsetHeight > height - 8) continue;
          label.style.top = `${y}px`;
          const rect = label.getBoundingClientRect();
          const overlaps = obstacles.some((obstacle) => rect.left < obstacle.right && rect.right > obstacle.left && rect.top < obstacle.bottom && rect.bottom > obstacle.top);
          if (!overlaps) {
            label.style.visibility = "visible";
            placed = true;
            break;
          }
        }
        if (!placed) label.style.visibility = "hidden";
      }
    }

    function applySettings(changes) {
      if (changes.panelTabChanged) setPanelTab(panelTab, false);
      if (changes.enabledChanged) setEnabled(overlayEnabled);
      if (changes.comparisonChanged) setComparison(comparisonEnabled);
      if (changes.lineMaskDebugChanged) setLineMaskDebug(lineMaskDebugEnabled);
      if (changes.modeChanged || changes.qualityChanged) {
        if (changes.modeChanged || changes.qualityChanged) rebuildPreset();
        gpuStatus = `Anime4K Modo ${activeMode} (${activeQuality}) activo`;
      } else if (changes.scaleChanged && gpuState && !gpuFailed) {
        try { updateGpuTarget(gpuState); } catch (error) { failGpu(error); }
      }
      if (changes.detailChanged) setDetail(detailEnabled);
      if (changes.detailIntensityChanged) setDetailIntensity(detailIntensity);
      if (changes.detailSizeChanged) setDetailSize(detailSizeMode);
      if (changes.sharpeningChanged) setSharpening(sharpeningEnabled);
      if (changes.sharpeningIntensityChanged) setSharpeningIntensity(sharpeningIntensity);
      if (changes.lineEnhancementIntensityChanged) setLineEnhancementIntensity(lineEnhancementIntensity);
      if (changes.fluencyChanged || changes.interpolationModeChanged || changes.fluencyConfigChanged) setFluency(fluencyEnabled, interpolationMode, fluencyControlMode, fluencyMultiplier, fluencyTarget);
      if (changes.panelPositionChanged) setPanelPosition(panelPosition);
      if (changes.fpsHudPositionChanged) setFpsHudPosition(fpsHudPosition);
      if (changes.comparisonLabelsChanged) setComparisonLabels(comparisonLabelsVisible);
      refreshBadge();
      revealPanel();
      if (changes.modeChanged || changes.qualityChanged || changes.scaleChanged || changes.enabledChanged || changes.detailChanged || changes.detailIntensityChanged || changes.detailSizeChanged || changes.sharpeningChanged || changes.sharpeningIntensityChanged || changes.lineEnhancementIntensityChanged || changes.fluencyChanged || changes.interpolationModeChanged || changes.fluencyConfigChanged) redrawNow();
      if (changes.manualPanelChanged) {
        if (panelManuallyHidden) hidePanel();
        else revealPanel();
      }
    }

    function settingsReady() {
      refreshBadge();
      setComparison(comparisonEnabled);
      setLineMaskDebug(lineMaskDebugEnabled);
      if (panelManuallyHidden) hidePanel();
      else revealPanel();
      redrawNow();
    }

    function applyPanelManualVisibility(hidden) {
      if (hidden) hidePanel();
      else revealPanel();
      syncReopenIndicator();
    }

    function syncReopenIndicator() {
      reopenIndicator.hidden = !(panelManuallyHidden && !panelVisible);
    }

    function revealPanel() {
      if (!settingsLoaded || !siteActivated || panelManuallyHidden) {
        hidePanel();
        return;
      }
      panelVisible = true;
      panel.classList.remove("is-hidden");
      panel.setAttribute("aria-hidden", "false");
      if (panelHideTimer !== null) clearTimeout(panelHideTimer);
      panelHideTimer = draggingPanel ? null : setTimeout(hidePanel, 3000);
      syncReopenIndicator();
    }

    function hidePanel() {
      if (draggingPanel) return;
      panelVisible = false;
      panel.classList.add("is-hidden");
      panel.setAttribute("aria-hidden", "true");
      if (panelHideTimer !== null) clearTimeout(panelHideTimer);
      panelHideTimer = null;
      syncReopenIndicator();
      layoutComparisonLabels(true);
    }

    playerContainer.addEventListener("pointermove", revealPanel, { capture: true, passive: true });
    playerContainer.addEventListener("pointerdown", revealPanel, { capture: true, passive: true });
    uiHost.addEventListener("pointermove", revealPanel, true);
    uiHost.addEventListener("pointerdown", revealPanel, true);

    function toggleStats() {
      if (panelManuallyHidden) return;
      const nextOpen = !statsDetails.open;
      setPanelTab("info");
      statsDetails.open = nextOpen;
      revealPanel();
      refreshBadge();
    }

    function placeOverlay() {
      if (stopped) return;
      if (!video.isConnected) {
        canvas.remove(); uiHost.remove(); compareHost.remove(); stopped = true;
        if (panelHideTimer !== null) clearTimeout(panelHideTimer);
        if (callbackId !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(callbackId);
        return;
      }
      const fullscreen = document.fullscreenElement;
      const nextUiParent = fullscreen && fullscreen !== video && fullscreen.contains(video) ? fullscreen : playerContainer;
      moveUiTo(nextUiParent);
      const rect = video.getBoundingClientRect();
      const parentRect = playerContainer.getBoundingClientRect();
      const scaleX = parentRect.width / (playerContainer.offsetWidth || 1) || 1;
      const scaleY = parentRect.height / (playerContainer.offsetHeight || 1) || 1;
      const left = (rect.left - parentRect.left - playerContainer.clientLeft * scaleX) / scaleX + playerContainer.scrollLeft;
      const top = (rect.top - parentRect.top - playerContainer.clientTop * scaleY) / scaleY + playerContainer.scrollTop;
      const width = rect.width / scaleX;
      const height = rect.height / scaleY;
      const visible = rect.width > 0 && rect.height > 0;
      const styles = { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` };
      Object.assign(canvas.style, styles, { display: visible && canvas.width > 0 && (overlayEnabled || (aiPreviewActive && aiResultReady) || false) && hasReadableFrame && !originalPreviewHeld && fullscreen !== video ? "block" : "none" });
      const uiParentRect = uiParent.getBoundingClientRect();
      const uiScaleX = uiParentRect.width / (uiParent.offsetWidth || 1) || 1;
      const uiScaleY = uiParentRect.height / (uiParent.offsetHeight || 1) || 1;
      const uiLeft = (rect.left - uiParentRect.left - uiParent.clientLeft * uiScaleX) / uiScaleX + uiParent.scrollLeft;
      const uiTop = (rect.top - uiParentRect.top - uiParent.clientTop * uiScaleY) / uiScaleY + uiParent.scrollTop;
      const uiStyles = { left: `${uiLeft}px`, top: `${uiTop}px`, width: `${rect.width / uiScaleX}px`, height: `${rect.height / uiScaleY}px` };
      Object.assign(uiHost.style, uiStyles, { display: visible && fullscreen !== video ? "block" : "none" });
      if (fpsHudPositionLocal && !draggingFpsHud && uiHost.style.display !== "none") {
        const previousHudPosition = fpsHudPositionLocal;
        const clampedHudPosition = applyFpsHudPosition(fpsHudPositionLocal);
        if (clampedHudPosition && (clampedHudPosition.x !== previousHudPosition.x || clampedHudPosition.y !== previousHudPosition.y) && settingsLoaded && siteActivated) chooseFpsHudPosition(clampedHudPosition);
      }
      Object.assign(compareHost.style, uiStyles, { display: visible && comparisonEnabled && overlayEnabled && hasReadableFrame && !gpuFailed && !originalPreviewHeld && fullscreen !== video ? "block" : "none" });
      if (panelPosition && !draggingPanel) {
        const clampedPosition = applySavedPanelPosition(panelPosition);
        if (clampedPosition && (clampedPosition.x !== panelPosition.x || clampedPosition.y !== panelPosition.y) && settingsLoaded && siteActivated && !draggingPanel) choosePanelPosition(clampedPosition);
      }
      layoutComparisonLabels();
      if (visible && (panelVisible || panelManuallyHidden) && performance.now() - lastPanelCornerCheck > 250) {
        lastPanelCornerCheck = performance.now();
        if (panelVisible) {
          if (!panelPosition) choosePanelCorner();
        } else chooseIndicatorCorner();
      }
    }

    function chooseIndicatorCorner() {
      if (!video.isConnected || uiHost.style.display === "none") return;
      reopenIndicator.hidden = false;
      reopenIndicator.style.visibility = "hidden";
      chooseClearCorner(reopenIndicator, "bottom-right");
      reopenIndicator.style.visibility = "";
      syncReopenIndicator();
    }

    function choosePanelCorner() {
      if (!video.isConnected || uiHost.style.display === "none") return;
      chooseClearCorner(panel, "top-left");
    }

    function chooseClearCorner(element, fallback) {
      const obstacleRoot = document.fullscreenElement && document.fullscreenElement.contains(video) ? document.fullscreenElement : playerContainer;
      const controls = getControls(obstacleRoot).map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 8 && rect.height > 8);
      const captionSelector = "[class*='subtitle' i],[class*='caption' i],[class*='text-track' i],[data-subtitle]";
      const captions = [...obstacleRoot.querySelectorAll(captionSelector)].map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 8 && rect.height > 8);
      const obstacles = [...controls, ...captions];
      const overlaps = (first, second) => first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
      for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
        element.dataset.corner = corner;
        const elementRect = element.getBoundingClientRect();
        if (!obstacles.some((rect) => overlaps(elementRect, rect))) return;
      }
      element.dataset.corner = fallback;
    }

    function elementInfo(element) {
      const style = getComputedStyle(element);
      const classes = typeof element.className === "string" ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 4) : [];
      return {
        element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${classes.map((name) => `.${name}`).join("")}`,
        position: style.position,
        zIndex: style.zIndex
      };
    }

    function logPlayerTree() {
      if (!video.isConnected) return;
      const controlsSelector = "button,[role='button'],[role='slider'],input[type='range'],[class*='control' i],[id*='control' i],[aria-label*='volume' i]";
      let playerRoot = playerContainer;
      let ancestor = playerContainer;
      for (let depth = 0; ancestor && depth < 8; depth++, ancestor = ancestor.parentElement) {
        if (ancestor.querySelector(controlsSelector)) {
          playerRoot = ancestor;
          break;
        }
      }
      canvasZIndex = Math.max(1, (Number.parseInt(getComputedStyle(video).zIndex, 10) || 0) + 1);
      canvas.style.setProperty("z-index", String(canvasZIndex), "important");
      uiHost.style.setProperty("z-index", String(canvasZIndex + 2), "important");
      compareHost.style.setProperty("z-index", String(canvasZIndex), "important");
      const controls = getControls(playerRoot, controlsSelector);
      syncControlStacking(overlayEnabled, controls);
      const included = new Set([video, canvas, ...controls]);
      for (const element of [...included]) {
        let parent = element.parentElement;
        while (parent && parent !== playerRoot) {
          included.add(parent);
          parent = parent.parentElement;
        }
      }
      function buildTree(element) {
        return {
          ...elementInfo(element),
          children: [...element.children].filter((child) => included.has(child)).map(buildTree)
        };
      }
      console.info("[Anime4K diagnóstico] Árbol del reproductor (z-index y position)", {
        insertadoComo: "hermano inmediato del video, dentro del mismo contenedor padre",
        canvasInsertadoEn: elementInfo(playerContainer),
        canvasEsHermanoInmediato: video.nextElementSibling === canvas,
        reproductor: buildTree(playerRoot),
        nota: "Los controles nativos internos del navegador pueden no aparecer en el DOM inspeccionable."
      });
    }

    function getControls(root, selector = "button,[role='button'],[role='slider'],input[type='range'],[class*='control' i],[id*='control' i],[aria-label*='volume' i]") {
      return [...root.querySelectorAll(selector)].slice(0, 60);
    }

    function syncControlStacking(active, knownControls = null) {
      const controls = knownControls || getControls(playerContainer);
      if (!active) {
        for (const [element, previous] of changedControls) {
          if (element.isConnected) {
            for (const [property, value] of Object.entries(previous)) {
              if (value.value) element.style.setProperty(property, value.value, value.priority);
              else element.style.removeProperty(property);
            }
          }
          changedControls.delete(element);
        }
        return;
      }
      for (const control of controls) {
        const computed = getComputedStyle(control);
        const currentZ = Number.parseInt(computed.zIndex, 10);
        if (computed.zIndex !== "auto" && Number.isFinite(currentZ) && currentZ > canvasZIndex) continue;
        if (!changedControls.has(control)) {
          changedControls.set(control, {
            position: { value: control.style.getPropertyValue("position"), priority: control.style.getPropertyPriority("position") },
            "z-index": { value: control.style.getPropertyValue("z-index"), priority: control.style.getPropertyPriority("z-index") }
          });
        }
        if (computed.position === "static") control.style.setProperty("position", "relative", "important");
        control.style.setProperty("z-index", String(canvasZIndex + 1), "important");
      }
    }

    const copyShader = `
      struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
      @group(0) @binding(0) var sourceVideo: texture_external;
      @group(0) @binding(1) var sourceSampler: sampler;
      @vertex fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOut {
        var points = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
        let point = points[index];
        var output: VertexOut;
        output.position = vec4f(point, 0.0, 1.0);
        output.uv = vec2f(point.x * 0.5 + 0.5, 0.5 - point.y * 0.5);
        return output;
      }
      @fragment fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
        return textureSampleBaseClampToEdge(sourceVideo, sourceSampler, input.uv);
      }
    `;

    // Un grupo de trabajo procesa un bloque de 8×8. El modo Movimiento busca
    // correspondencias sobre luminancia en radio ±4; ante baja confianza mezcla.
    const interpolationShader = `
      @group(0) @binding(0) var previousFrame: texture_2d<f32>;
      @group(0) @binding(1) var currentFrame: texture_2d<f32>;
      @group(0) @binding(2) var outputFrame: texture_storage_2d<rgba16float, write>;
      struct Settings { mode: u32, width: u32, height: u32, confidence: f32, fraction: f32 };
      @group(0) @binding(3) var<uniform> settings: Settings;
      var<workgroup> blockOffset: vec2i;
      var<workgroup> blockCost: f32;
      fn luma(color: vec4f) -> f32 { return dot(color.rgb, vec3f(0.2126,0.7152,0.0722)); }
      @compute @workgroup_size(8,8) fn main(
        @builtin(global_invocation_id) pixel: vec3u,
        @builtin(workgroup_id) group: vec3u,
        @builtin(local_invocation_index) localIndex: u32
      ) {
        let dimensions=vec2i(i32(settings.width),i32(settings.height));
        let origin=vec2i(group.xy*vec2u(8u,8u));
        if (localIndex==0u) {
          blockOffset=vec2i(0,0); blockCost=0.0;
          if (settings.mode==1u) {
            let samples=array<vec2i,4>(vec2i(1,1),vec2i(6,1),vec2i(1,6),vec2i(6,6));
            var best=1e6; var bestOffset=vec2i(0,0);
            for (var y:i32=-4; y<=4; y=y+1) { for (var x:i32=-4; x<=4; x=x+1) {
              var cost=0.0;
              for (var sampleIndex:u32=0u; sampleIndex<4u; sampleIndex=sampleIndex+1u) {
                let currentCoord=clamp(origin+samples[sampleIndex],vec2i(0,0),dimensions-vec2i(1,1));
                let previousCoord=clamp(currentCoord+vec2i(x,y),vec2i(0,0),dimensions-vec2i(1,1));
                cost=cost+abs(luma(textureLoad(previousFrame,previousCoord,0))-luma(textureLoad(currentFrame,currentCoord,0)));
              }
              cost=cost*0.25;
              if (cost<best) { best=cost; bestOffset=vec2i(x,y); }
            } }
            blockOffset=bestOffset; blockCost=best;
          }
        }
        workgroupBarrier();
        if (pixel.x>=settings.width || pixel.y>=settings.height) { return; }
        let coord=vec2i(pixel.xy);
        let current=textureLoad(currentFrame,coord,0);
        let previous=textureLoad(previousFrame,coord,0);
        var result=mix(previous,current,settings.fraction);
        if (settings.mode==1u && blockCost<=settings.confidence) {
          let previousOffset=vec2i(round(vec2f(blockOffset)*settings.fraction));
          let currentOffset=vec2i(round(vec2f(blockOffset)*(1.0-settings.fraction)));
          let fromPrevious=textureLoad(previousFrame,clamp(coord+previousOffset,vec2i(0,0),dimensions-vec2i(1,1)),0);
          let fromCurrent=textureLoad(currentFrame,clamp(coord-currentOffset,vec2i(0,0),dimensions-vec2i(1,1)),0);
          result=mix(fromPrevious,fromCurrent,settings.fraction);
        }
        textureStore(outputFrame,coord,result);
      }
    `;

    const copyTextureShader = `
      struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
      @group(0) @binding(0) var imageSampler: sampler;
      @group(0) @binding(1) var imageTexture: texture_2d<f32>;
      @vertex fn vertexMain(@builtin(vertex_index) index:u32)->VertexOut {
        var points=array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0)); let point=points[index];
        var output:VertexOut; output.position=vec4f(point,0.0,1.0); output.uv=vec2f(point.x*0.5+0.5,0.5-point.y*0.5); return output;
      }
      @fragment fn fragmentMain(input:VertexOut)->@location(0) vec4f { return textureSample(imageTexture,imageSampler,input.uv); }
    `;

    const displayShader = `
      struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
      @group(0) @binding(0) var imageSampler: sampler;
      @group(0) @binding(1) var imageTexture: texture_2d<f32>;
      @vertex fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOut {
        var points = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
        let point = points[index];
        var output: VertexOut;
        output.position = vec4f(point, 0.0, 1.0);
        output.uv = vec2f(point.x * 0.5 + 0.5, 0.5 - point.y * 0.5);
        return output;
      }
      @fragment fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
        return textureSample(imageTexture, imageSampler, input.uv);
      }
    `;

    const detailHorizontalShader = `
      struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
      struct FilterSettings { intensity: f32, radius: f32, pad1: f32, pad2: f32 };
      @group(0) @binding(0) var imageSampler: sampler;
      @group(0) @binding(1) var imageTexture: texture_2d<f32>;
      @group(0) @binding(2) var<uniform> settings: FilterSettings;
      @vertex fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOut {
        var points = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
        let point = points[index]; var output: VertexOut;
        output.position = vec4f(point, 0.0, 1.0); output.uv = vec2f(point.x * 0.5 + 0.5, 0.5 - point.y * 0.5); return output;
      }
      @fragment fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
        let texel = 1.0 / vec2f(textureDimensions(imageTexture));
        var sum = 0.0; var weightSum = 0.0;
        let radius = i32(round(settings.radius));
        let sigma = max(settings.radius * 0.5, 1.0);
        for (var i = -12; i <= 12; i++) {
          if (abs(i) > radius) { continue; }
          let x = f32(i); let weight = exp(-(x * x) / (2.0 * sigma * sigma));
          let color = textureSample(imageTexture, imageSampler, input.uv + vec2f(x * texel.x, 0.0)).rgb;
          sum += dot(color, vec3f(0.2126, 0.7152, 0.0722)) * weight; weightSum += weight;
        }
        let luma = sum / weightSum;
        return vec4f(luma, luma, luma, 1.0);
      }
    `;

    const detailVerticalShader = `
      struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
      struct FilterSettings { intensity: f32, radius: f32, pad1: f32, pad2: f32 };
      @group(0) @binding(0) var imageSampler: sampler;
      @group(0) @binding(1) var imageTexture: texture_2d<f32>;
      @group(0) @binding(2) var horizontalBlur: texture_2d<f32>;
      @group(0) @binding(3) var<uniform> settings: FilterSettings;
      @vertex fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOut {
        var points = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
        let point = points[index]; var output: VertexOut;
        output.position = vec4f(point, 0.0, 1.0); output.uv = vec2f(point.x * 0.5 + 0.5, 0.5 - point.y * 0.5); return output;
      }
      fn luma(color: vec3f) -> f32 { return dot(color, vec3f(0.2126, 0.7152, 0.0722)); }
      @fragment fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
        let center = textureSample(imageTexture, imageSampler, input.uv);
        let texel = 1.0 / vec2f(textureDimensions(imageTexture));
        var blur = 0.0; var weightSum = 0.0;
        let radius = i32(round(settings.radius));
        let sigma = max(settings.radius * 0.5, 1.0);
        for (var i = -12; i <= 12; i++) {
          if (abs(i) > radius) { continue; }
          let y = f32(i); let weight = exp(-(y * y) / (2.0 * sigma * sigma));
          blur += textureSample(horizontalBlur, imageSampler, input.uv + vec2f(0.0, y * texel.y)).r * weight;
          weightSum += weight;
        }
        blur /= weightSum;
        let centerLuma = luma(center.rgb);
        let north = luma(textureSample(imageTexture, imageSampler, input.uv + vec2f(0.0, -texel.y)).rgb);
        let south = luma(textureSample(imageTexture, imageSampler, input.uv + vec2f(0.0, texel.y)).rgb);
        let east = luma(textureSample(imageTexture, imageSampler, input.uv + vec2f(texel.x, 0.0)).rgb);
        let west = luma(textureSample(imageTexture, imageSampler, input.uv + vec2f(-texel.x, 0.0)).rgb);
        let low = min(centerLuma, min(min(north, south), min(east, west)));
        let high = max(centerLuma, max(max(north, south), max(east, west)));
        let gradient = max(max(abs(centerLuma - north), abs(centerLuma - south)), max(abs(centerLuma - east), abs(centerLuma - west)));
        let protection = 1.0 - smoothstep(0.018, 0.075, gradient);
        let adjusted = clamp(centerLuma + (centerLuma - blur) * settings.intensity * 3.0 * protection, low, high);
        let scale = adjusted / max(centerLuma, 0.0001);
        return vec4f(clamp(center.rgb * scale, vec3f(0.0), vec3f(1.0)), center.a);
      }
    `;

    // CAS adaptativo con clamp del rango local. El centro participa en los
    // extremos para no borrar líneas que ya son más oscuras que sus vecinos.
    const sharpeningShader = `
      struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
      struct FilterSettings { intensity: f32, lineIntensity: f32, debugMask: f32, pad0: f32 };
      @group(0) @binding(0) var imageSampler: sampler;
      @group(0) @binding(1) var imageTexture: texture_2d<f32>;
      @group(0) @binding(2) var<uniform> settings: FilterSettings;
      @vertex fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOut {
        var points = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
        let point = points[index]; var output: VertexOut;
        output.position = vec4f(point, 0.0, 1.0); output.uv = vec2f(point.x * 0.5 + 0.5, 0.5 - point.y * 0.5); return output;
      }
      fn luminance(color: vec3f) -> f32 {
        return dot(color, vec3f(0.2126, 0.7152, 0.0722));
      }
      @fragment fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
        let center = textureSample(imageTexture, imageSampler, input.uv);
        let texel = 1.0 / vec2f(textureDimensions(imageTexture));
        let north = textureSample(imageTexture, imageSampler, input.uv + vec2f(0.0, -texel.y)).rgb;
        let south = textureSample(imageTexture, imageSampler, input.uv + vec2f(0.0, texel.y)).rgb;
        let east = textureSample(imageTexture, imageSampler, input.uv + vec2f(texel.x, 0.0)).rgb;
        let west = textureSample(imageTexture, imageSampler, input.uv + vec2f(-texel.x, 0.0)).rgb;
        let northWest = textureSample(imageTexture, imageSampler, input.uv + vec2f(-texel.x, -texel.y)).rgb;
        let northEast = textureSample(imageTexture, imageSampler, input.uv + vec2f(texel.x, -texel.y)).rgb;
        let southWest = textureSample(imageTexture, imageSampler, input.uv + vec2f(-texel.x, texel.y)).rgb;
        let southEast = textureSample(imageTexture, imageSampler, input.uv + vec2f(texel.x, texel.y)).rgb;
        let centerLuma = luminance(center.rgb);
        let northLuma = luminance(north); let southLuma = luminance(south);
        let eastLuma = luminance(east); let westLuma = luminance(west);
        let northWestLuma = luminance(northWest); let northEastLuma = luminance(northEast);
        let southWestLuma = luminance(southWest); let southEastLuma = luminance(southEast);
        let neighborMin = min(min(min(northLuma, southLuma), min(eastLuma, westLuma)), min(min(northWestLuma, northEastLuma), min(southWestLuma, southEastLuma)));
        let neighborMax = max(max(max(northLuma, southLuma), max(eastLuma, westLuma)), max(max(northWestLuma, northEastLuma), max(southWestLuma, southEastLuma)));
        let localMin = min(centerLuma, neighborMin);
        let localMax = max(centerLuma, neighborMax);
        let localContrast = localMax - localMin;
        let blurLuma = (centerLuma * 4.0 + (northLuma + southLuma + eastLuma + westLuma) * 2.0 + northWestLuma + northEastLuma + southWestLuma + southEastLuma) / 16.0;
        let adaptiveGain = clamp(1.0 / (0.12 + localContrast * 2.5), 0.35, 1.5);
        let casLuma = centerLuma + (centerLuma - blurLuma) * settings.intensity * 3.0 * adaptiveGain;
        let safeCasLuma = clamp(casLuma, localMin, localMax);
        // Umbral más amplio para incluir líneas oscuras suavizadas por compresión
        // y menor gradiente para detectar trazos finos, sin afectar planos.
        let darkMask = 1.0 - smoothstep(0.30, 0.68, centerLuma);
        let edgeMask = smoothstep(0.006, 0.045, localContrast);
        let lineMask = darkMask * edgeMask;
        if (settings.debugMask > 0.5) {
          return vec4f(vec3f(lineMask), 1.0);
        }
        // Se aplica tras el clamp CAS: la atenuación intencional de la línea
        // no debe ser anulada por el límite local que protege de halos claros.
        let safeLuma = max(0.0, safeCasLuma - settings.lineIntensity * 0.28 * lineMask);
        let colorDelta = safeLuma - centerLuma;
        let safeColor = clamp(center.rgb + vec3f(colorDelta), vec3f(0.0), vec3f(1.0));
        return vec4f(safeColor, center.a);
      }
    `;

    function makeRenderPipeline(device, shaderCode, format, label) {
      const module = device.createShaderModule({ label, code: shaderCode });
      return device.createRenderPipeline({
        label,
        layout: "auto",
        vertex: { module, entryPoint: "vertexMain" },
        fragment: { module, entryPoint: "fragmentMain", targets: [{ format }] },
        primitive: { topology: "triangle-list" }
      });
    }

    function updateDetailUniform(state) {
      const radius = detailRadiusPixels();
      if (state.detailIntensityUploaded === detailIntensity && state.detailRadiusUploaded === radius) return;
      state.device.queue.writeBuffer(state.detailUniformBuffer, 0, new Float32Array([detailIntensity, radius, 0, 0]));
      state.detailIntensityUploaded = detailIntensity;
      state.detailRadiusUploaded = radius;
    }

    function updateSharpeningUniform(state) {
      const debugValue = lineMaskDebugEnabled ? 1 : 0;
      if (state.sharpenIntensityUploaded === sharpeningIntensity && state.lineEnhancementUploaded === lineEnhancementIntensity && state.lineMaskDebugUploaded === debugValue) return;
      state.device.queue.writeBuffer(state.sharpenUniformBuffer, 0, new Float32Array([sharpeningIntensity, lineEnhancementIntensity, debugValue, 0]));
      state.sharpenIntensityUploaded = sharpeningIntensity;
      state.lineEnhancementUploaded = lineEnhancementIntensity;
      state.lineMaskDebugUploaded = debugValue;
    }

    function ensureDetailResources(state) {
      if (!state.detailHorizontalPipeline) state.detailHorizontalPipeline = makeRenderPipeline(state.device, detailHorizontalShader, "rgba16float", "Anime4K Detail horizontal gaussian");
      if (!state.detailVerticalPipeline) state.detailVerticalPipeline = makeRenderPipeline(state.device, detailVerticalShader, state.format, "Anime4K Detail local contrast");
      if (!state.detailUniformBuffer) state.detailUniformBuffer = state.device.createBuffer({ label: "Anime4K Detail intensity", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      updateDetailUniform(state);
      if (!state.sharpIntermediate || state.sharpIntermediate.width !== state.targetWidth || state.sharpIntermediate.height !== state.targetHeight) {
        if (state.sharpIntermediate) deferResourceDestroy(state, state.sharpIntermediate);
        state.sharpIntermediate = state.device.createTexture({ label: "Anime4K pre-detail output", size: { width: state.targetWidth, height: state.targetHeight, depthOrArrayLayers: 1 }, format: state.format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
      }
      if (!state.detailHorizontalTexture || state.detailHorizontalTexture.width !== state.targetWidth || state.detailHorizontalTexture.height !== state.targetHeight) {
        if (state.detailHorizontalTexture) deferResourceDestroy(state, state.detailHorizontalTexture);
        state.detailHorizontalTexture = state.device.createTexture({ label: "Anime4K Detail horizontal blur", size: { width: state.targetWidth, height: state.targetHeight, depthOrArrayLayers: 1 }, format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
      }
      if (sharpeningEnabled && (!state.detailOutputTexture || state.detailOutputTexture.width !== state.targetWidth || state.detailOutputTexture.height !== state.targetHeight)) {
        if (state.detailOutputTexture) deferResourceDestroy(state, state.detailOutputTexture);
        state.detailOutputTexture = state.device.createTexture({ label: "Anime4K post-detail input to sharpness", size: { width: state.targetWidth, height: state.targetHeight, depthOrArrayLayers: 1 }, format: state.format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
      }
    }

    function ensureSharpenResources(state) {
      if (!state.sharpenPipeline) state.sharpenPipeline = makeRenderPipeline(state.device, sharpeningShader, state.format, "Anime4K controlled sharpness");
      if (!state.sharpenUniformBuffer) state.sharpenUniformBuffer = state.device.createBuffer({ label: "Anime4K sharpness intensity", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      updateSharpeningUniform(state);
      if (!state.sharpIntermediate || state.sharpIntermediate.width !== state.targetWidth || state.sharpIntermediate.height !== state.targetHeight) {
        if (state.sharpIntermediate) deferResourceDestroy(state, state.sharpIntermediate);
        state.sharpIntermediate = state.device.createTexture({
          label: "Anime4K pre-sharpen output",
          size: { width: state.targetWidth, height: state.targetHeight, depthOrArrayLayers: 1 },
          format: state.format,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
        });
      }
    }

    function releaseInterpolationResources(state = gpuState) {
      if (!state) return;
      fluencyGeneration += 1;
      if (interpolationHistory && typeof interpolationHistory === "object") releaseQueuedTexture(interpolationHistory);
      interpolationHistory = null;
      for (const item of presentationQueue.splice(0)) releaseQueuedTexture(item.record);
      if (presentationRaf !== null) cancelAnimationFrame(presentationRaf);
      presentationRaf = null;
      if (state.interpolationUniformBuffer) deferResourceDestroy(state, state.interpolationUniformBuffer);
      state.interpolationUniformBuffer = null;
      void retireFluencyPool(state);
      state.interpolationPipeline = null;
      state.copyTexturePipeline = null;
      if (interpolationTimer !== null) clearTimeout(interpolationTimer);
      interpolationTimer = null;
      if (interpolationRaf !== null) cancelAnimationFrame(interpolationRaf);
      interpolationRaf = null;
      if (presentationRaf !== null) cancelAnimationFrame(presentationRaf);
      presentationRaf = null;
      if (canvasPresentationRaf !== null) cancelAnimationFrame(canvasPresentationRaf);
      canvasPresentationRaf = null;
      pendingCanvasOutput = null;
      outputPresentationTimes = [];
      outputFps = 0;
      previousFrameTiming = null;
    }

    function ensureInterpolationResources(state) {
      if (!state.fluencyPrepareWaiters) state.fluencyPrepareWaiters = [];
      if (!Number.isFinite(state.fluencyPreparations)) state.fluencyPreparations = 0;
      if (!state.interpolationPipeline) {
        const interpolationModule = state.device.createShaderModule({ label: "Anime4K 8x8 block matching", code: interpolationShader });
        state.interpolationPipeline = state.device.createComputePipeline({ label: "Anime4K experimental frame interpolation", layout: "auto", compute: { module: interpolationModule, entryPoint: "main" } });
        state.copyTexturePipeline = makeRenderPipeline(state.device, copyTextureShader, "rgba16float", "Anime4K interpolation input copy");
        state.interpolationUniformBuffer = state.device.createBuffer({ label: "Anime4K interpolation settings", size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      }
      const maxIntermediates = getMaximumIntermediatesPerFrame();
      if (state.fluencyPool && state.fluencyPoolIntermediates !== maxIntermediates) {
        if (!state.fluencyPoolRetirePromise) {
          void retireFluencyPool(state).then(() => {
            if (gpuState === state && fluencyEnabled && !stopped) ensureInterpolationResources(state);
          });
        }
        return;
      }
      if (!state.fluencyPool && !state.fluencyPoolRetirePromise) {
        const textureOptions = {
          size: { width: state.width, height: state.height, depthOrArrayLayers: 1 },
          format: "rgba16float",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING
        };
        const slotCount = maxIntermediates + 4;
        state.fluencyPool = Array.from({ length: slotCount }, (_, index) => ({
          kind: "fluency-pool-slot", status: "libre", refs: 0, inFlight: 0,
          texture: state.device.createTexture({ ...textureOptions, label: `Anime4K fluency pool slot ${index + 1}` })
        }));
        state.fluencyPoolIntermediates = maxIntermediates;
      }
    }

    function setFluency(enabled, mode = interpolationMode, controlMode = fluencyControlMode, multiplier = fluencyMultiplier, target = fluencyTarget) {
      fluencyControlMode = controlMode === "target" ? "target" : "multiplier";
      fluencyMultiplier = [2, 3, 4].includes(multiplier) ? multiplier : 2;
      fluencyTarget = target === "Auto" ? "Auto" : Number.isFinite(target) ? Math.min(240, Math.max(24, target)) : 60;
      interpolationMode = mode === "motion" ? "motion" : "mix";
      if (videoFpsMeasured >= 48 && enabled) {
        fluencyEnabled = false;
        say("Generación de fotogramas no disponible: este video ya tiene 48 fps o más");
      }
      else fluencyEnabled = Boolean(enabled);
      updateFluencyTargetWarning(true);
      if (!gpuState || gpuFailed) { refreshBadge(); return; }
      resetInterpolationHistory(enabled ? "Generación de fotogramas activada" : "Generación de fotogramas desactivada");
      try {
        if (fluencyEnabled && videoFpsMeasured < 48 && getMaximumIntermediatesPerFrame() > 0) {
          ensureInterpolationResources(gpuState);
          interpolationHistory = null;
          measureMonitorRefresh();
        }
        else releaseInterpolationResources(gpuState);
      } catch (error) {
        failFluency(new Error(`No se pudo preparar el pool de Generación de fotogramas: ${error?.name || "Error"}: ${error?.message || error}`));
      }
      refreshBadge();
      revealPanel();
      redrawNow();
    }

    function improveAiFrame() { void startAiImproveFrame(); }

    function resetInterpolationHistory(reason = "") {
      fluencyGeneration += 1;
      fluencyDegraded = false;
      fluencyDegradedSince = null;
      fluencyRenderSamples = [];
      fractionalFrameAccumulator = 0;
      if (interpolationHistory && typeof interpolationHistory === "object") releaseQueuedTexture(interpolationHistory);
      interpolationHistory = null;
      interpolationSamples = [];
      interpolationWarning = "";
      if (interpolationTimer !== null) clearTimeout(interpolationTimer);
      interpolationTimer = null;
      if (interpolationRaf !== null) cancelAnimationFrame(interpolationRaf);
      interpolationRaf = null;
      if (canvasPresentationRaf !== null) cancelAnimationFrame(canvasPresentationRaf);
      canvasPresentationRaf = null;
      pendingCanvasOutput = null;
      for (const item of presentationQueue.splice(0)) releaseQueuedTexture(item.record);
      if (gpuState) void retireFluencyPool(gpuState);
      previousFrameTiming = null;
      outputPresentationTimes = [];
      outputFps = 0;
      if (reason) console.info(`[Anime4K diagnóstico] Historial de Generación de fotogramas reiniciado: ${reason}`);
      refreshBadge();
    }

    function observeCanvasOutput(state, kind) {
      const sequence = ++canvasOutputSequence;
      state.device.queue.onSubmittedWorkDone().then(() => {
        if (gpuState !== state || gpuFailed || !fluencyEnabled) return;
        requestAnimationFrame((timestamp) => {
          if (gpuState !== state || gpuFailed || !fluencyEnabled || document.hidden) return;
          // Una entrada de la cola equivale a una pasada enviada al canvas y observada
          // en una oportunidad de pintura de rAF; rAF no confirma la composición física.
          outputFramesDropped += Math.max(0, sequence - lastCanvasOutputPresented - 1);
          lastCanvasOutputPresented = sequence;
          if (kind === "intermediate") intermediateOutputsPresented += 1;
          else if (kind === "real") realOutputsPresented += 1;
          outputPresentationTimes.push(timestamp);
          while (outputPresentationTimes.length && timestamp - outputPresentationTimes[0] > 1000) outputPresentationTimes.shift();
          outputFps = outputPresentationTimes.length;
          refreshBadge();
        });
      }).catch(() => {});
    }

    function releaseQueuedTexture(record) {
      if (!record) return;
      record.refs = Math.max(0, record.refs - 1);
      updateFluencySlotState(record);
    }

    function updateFluencySlotState(slot) {
      if (!slot || slot.kind !== "fluency-pool-slot") return;
      slot.status = slot.inFlight > 0 ? "en uso por submit" : slot.refs > 0 ? "en cola" : "libre";
    }

    function acquireFluencySlot(state) {
      const slot = state?.fluencyPool?.find((candidate) => candidate.status === "libre");
      if (!slot) return null;
      slot.refs = 1;
      slot.status = "en uso por submit";
      return slot;
    }

    function markFluencySlotsInFlight(slots) {
      for (const slot of slots) {
        if (!slot || slot.kind !== "fluency-pool-slot") continue;
        slot.inFlight += 1;
        updateFluencySlotState(slot);
      }
      fluencyGpuCommandsInFlight += 1;
    }

    function markFluencySubmitComplete(slots) {
      for (const slot of slots) {
        if (!slot || slot.kind !== "fluency-pool-slot") continue;
        slot.inFlight = Math.max(0, slot.inFlight - 1);
        updateFluencySlotState(slot);
      }
      fluencyGpuCommandsInFlight = Math.max(0, fluencyGpuCommandsInFlight - 1);
    }

    function deferResourceDestroy(state, resource) {
      if (!state || !resource) return;
      state.device.queue.onSubmittedWorkDone().then(() => resource.destroy()).catch(() => {
        // En caso de pérdida del dispositivo, no se vuelve a enviar trabajo a la cola.
        state.device.lost.then(() => { try { resource.destroy(); } catch { /* Dispositivo perdido. */ } });
      });
    }

    function destroyDeviceAfterQueue(state) {
      if (!state) return;
      Promise.resolve(state.fluencyPoolRetirePromise).then(() => state.device.queue.onSubmittedWorkDone().catch(() => null)).then(() => {
        try { state.device.destroy(); } catch { /* El dispositivo puede haberse perdido. */ }
      });
    }

    function retireFluencyPool(state) {
      if (!state) return Promise.resolve();
      const pool = state.fluencyPool;
      if (!pool) return state.fluencyPoolRetirePromise || Promise.resolve();
      state.fluencyPool = null;
      const waitForPreparation = state.fluencyPreparations > 0
        ? new Promise((resolve) => state.fluencyPrepareWaiters.push(resolve)) : Promise.resolve();
      state.fluencyPoolRetirePromise = waitForPreparation.then(() => state.device.queue.onSubmittedWorkDone().catch(() => null)).then(() => {
        for (const slot of pool) {
          try { slot.texture.destroy(); } catch { /* Pool retirado o dispositivo perdido. */ }
          slot.status = "libre";
        }
      }).finally(() => {
        state.fluencyPoolRetirePromise = null;
      });
      return state.fluencyPoolRetirePromise;
    }

    function enqueuePresentation(record, targetTime, kind, ready = null) {
      if (!record) return;
      record.refs += 1;
      presentationQueue.push({ record, targetTime, kind, ready, generation: fluencyGeneration, order: canvasOutputSequence + presentationQueue.length + 1 });
      presentationQueue.sort((a, b) => a.targetTime - b.targetTime || a.order - b.order);
      pumpPresentationQueue();
    }

    async function pumpPresentationQueue() {
      if (presentationRaf !== null || stopped) return;
      const next = presentationQueue[0];
      if (!next) return;
      presentationRaf = requestAnimationFrame(async (timestamp) => {
        presentationRaf = null;
        if (stopped || next.generation !== fluencyGeneration || !fluencyEnabled || document.hidden || video.paused || !overlayEnabled) return;
        if (timestamp + 0.25 < next.targetTime) { pumpPresentationQueue(); return; }
        presentationQueue.shift();
        const leasedState = gpuState;
        if (leasedState) leasedState.fluencyPreparations = (leasedState.fluencyPreparations || 0) + 1;
        try {
          if (next.ready) await next.ready;
          if (next.generation !== fluencyGeneration || !fluencyEnabled) return;
          const submitted = await renderCurrentFrame(next.record.texture, next.kind, next.generation);
          if (!submitted) outputFramesDropped += 1;
        } catch (error) {
          outputFramesDropped += 1;
          console.warn("[Anime4K diagnóstico] Error presentando un frame en cola", error);
        } finally {
          releaseQueuedTexture(next.record);
          if (leasedState) {
            leasedState.fluencyPreparations = Math.max(0, (leasedState.fluencyPreparations || 1) - 1);
            if (!leasedState.fluencyPreparations) for (const resolve of leasedState.fluencyPrepareWaiters?.splice(0) || []) resolve();
          }
          refreshBadge();
          pumpPresentationQueue();
        }
      });
    }

    function monitorInterpolation(now) {
      if (!fluencyEnabled || interpolationMilliseconds <= 0) return;
      interpolationSamples.push({ at: now, ms: interpolationMilliseconds });
      while (interpolationSamples.length && now - interpolationSamples[0].at > 4000) interpolationSamples.shift();
      if (interpolationSamples.length > 2 && now - interpolationSamples[0].at >= 3500) {
        const average = interpolationSamples.reduce((sum, sample) => sum + sample.ms, 0) / interpolationSamples.length;
        interpolationWarning = average > frameBudgetMs
          ? `Generación de fotogramas promedia ${average.toFixed(1)} ms sobre ${frameBudgetMs.toFixed(1)} ms; probá bajar calidad o escala.`
          : "";
      }
      refreshBadge();
    }

    function copyExternalToTexture(state, target) {
      const external = state.device.importExternalTexture({ source: video });
      const bindGroup = state.device.createBindGroup({
        layout: state.copyPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: external }, { binding: 1, resource: state.sampler }]
      });
      const encoder = state.device.createCommandEncoder({ label: "Capture Anime4K fluency history" });
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.texture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }] });
      pass.setPipeline(state.copyPipeline); pass.setBindGroup(0, bindGroup); pass.draw(3); pass.end();
      markFluencySlotsInFlight([target]);
      try { state.device.queue.submit([encoder.finish()]); }
      catch (error) { markFluencySubmitComplete([target]); throw error; }
      state.device.queue.onSubmittedWorkDone().then(() => markFluencySubmitComplete([target])).catch((error) => {
        markFluencySubmitComplete([target]);
        failFluency(error);
      });
    }

    async function renderInterpolatedFrame(state, previousRecord, currentRecord, generation, fraction, targetTime) {
      const outputRecord = acquireFluencySlot(state);
      if (!outputRecord) return false;
      let fluencySlotsMarked = false;
      let outputEnqueued = false;
      state.fluencyPreparations = (state.fluencyPreparations || 0) + 1;
      try {
      const outputTexture = outputRecord.texture;
      const mode = interpolationMode === "motion" ? 1 : 0;
      const settingsBytes = new ArrayBuffer(32);
      const settingsView = new DataView(settingsBytes);
      settingsView.setUint32(0, mode, true);
      settingsView.setUint32(4, state.width, true);
      settingsView.setUint32(8, state.height, true);
      settingsView.setFloat32(12, 0.10, true);
      settingsView.setFloat32(16, fraction, true);
      state.device.queue.writeBuffer(state.interpolationUniformBuffer, 0, settingsBytes);
      const bindGroup = state.device.createBindGroup({
        layout: state.interpolationPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: previousRecord.texture.createView() },
          { binding: 1, resource: currentRecord.texture.createView() },
          { binding: 2, resource: outputTexture.createView() },
          { binding: 3, resource: { buffer: state.interpolationUniformBuffer } }
        ]
      });
        if (generation !== fluencyGeneration || !fluencyEnabled || state.fluencyPoolRetirePromise) {
          releaseQueuedTexture(outputRecord);
          outputEnqueued = true;
          return false;
        }
        const encoder = state.device.createCommandEncoder({ label: "Anime4K interpolate source frame" });
        const pass = encoder.beginComputePass({ label: "Anime4K 8x8 frame interpolation" });
        pass.setPipeline(state.interpolationPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(state.width / 8), Math.ceil(state.height / 8));
        pass.end();
        markFluencySlotsInFlight([previousRecord, currentRecord, outputRecord]);
        fluencySlotsMarked = true;
        try { state.device.queue.submit([encoder.finish()]); }
        catch (error) { markFluencySubmitComplete([previousRecord, currentRecord, outputRecord]); fluencySlotsMarked = false; throw error; }
        const submittedAt = performance.now();
        const completion = state.device.queue.onSubmittedWorkDone().then(() => {
          interpolationMilliseconds = performance.now() - submittedAt;
          markFluencySubmitComplete([previousRecord, currentRecord, outputRecord]);
          if (generation === fluencyGeneration && fluencyEnabled) {
            monitorInterpolation(performance.now());
            refreshBadge();
          }
        }).catch((error) => {
          markFluencySubmitComplete([previousRecord, currentRecord, outputRecord]);
          failFluency(error);
          throw error;
        });
        // Mantener ocupados los slots hasta completar el submit; la cola de
        // presentación espera esta promesa sin detener el callback del video.
        fluencySlotsMarked = false;
        enqueuePresentation(outputRecord, targetTime, "intermediate", completion);
        outputEnqueued = true;
        releaseQueuedTexture(outputRecord);
        interpolatedFrames += 1;
        refreshBadge();
        return true;
      } catch (error) {
        if (fluencySlotsMarked) markFluencySubmitComplete([previousRecord, currentRecord, outputRecord]);
        if (!outputEnqueued) releaseQueuedTexture(outputRecord);
        throw error;
      } finally {
        state.fluencyPreparations = Math.max(0, (state.fluencyPreparations || 1) - 1);
        if (!state.fluencyPreparations) for (const resolve of state.fluencyPrepareWaiters?.splice(0) || []) resolve();
      }
    }

    function monitorFluencyRender(now, milliseconds) {
      if (!fluencyEnabled || !Number.isFinite(milliseconds)) return;
      fluencyRenderSamples.push({ at: now, milliseconds });
      while (fluencyRenderSamples.length && now - fluencyRenderSamples[0].at > 1000) fluencyRenderSamples.shift();
      if (fluencyRenderSamples.length < 3 || now - fluencyRenderSamples[0].at < 750) return;
      const average = fluencyRenderSamples.reduce((sum, sample) => sum + sample.milliseconds, 0) / fluencyRenderSamples.length;
      if (average > frameBudgetMs) {
        if (!fluencyDegraded) {
          fluencyDegraded = true;
          fractionalFrameAccumulator = 0;
          interpolationWarning = `Generación de fotogramas pausó los intermedios: ${average.toFixed(1)} ms promedio supera el presupuesto de ${frameBudgetMs.toFixed(1)} ms.`;
          setTimeout(() => { interpolationWarning = ""; refreshBadge(); }, 3500);
        }
        fluencyDegradedSince = null;
      } else if (fluencyDegraded) {
        if (fluencyDegradedSince === null) fluencyDegradedSince = now;
        if (now - fluencyDegradedSince >= 1000) {
          fluencyDegraded = false;
          fractionalFrameAccumulator = 0;
          fluencyDegradedSince = null;
          fluencyRenderSamples = [];
          interpolationWarning = "Generación de fotogramas se recuperó; vuelven los frames intermedios.";
          setTimeout(() => { interpolationWarning = ""; refreshBadge(); }, 2500);
        }
      }
      refreshBadge();
    }

    function recordFilterTimings(state, encoder, activeDetail, activeSharpen) {
      if (!state.timestampQuerySet || (!activeDetail && !activeSharpen)) return null;
      filterTimingFrameCounter += 1;
      if (filterTimingFrameCounter % 8 !== 0) return null;
      const slot = state.timestampReadbacks.find((item) => !item.busy);
      if (!slot) return null;
      encoder.resolveQuerySet(state.timestampQuerySet, 0, 8, state.timestampResolveBuffer, 0);
      encoder.copyBufferToBuffer(state.timestampResolveBuffer, 0, slot.buffer, 0, 64);
      slot.busy = true;
      return slot;
    }

    function readFilterTimings(state, slot, activeDetail, activeSharpen) {
      if (!slot) return;
      slot.buffer.mapAsync(GPUMapMode.READ).then(() => {
        if (gpuState !== state || gpuFailed) { slot.buffer.unmap(); return; }
        const values = new BigUint64Array(slot.buffer.getMappedRange().slice(0));
        if (activeDetail) detailFilterMilliseconds = (Number(values[3] - values[2]) + Number(values[5] - values[4])) / 1e6;
        if (activeSharpen) sharpeningFilterMilliseconds = Number(values[7] - values[6]) / 1e6;
        slot.buffer.unmap();
        slot.busy = false;
        refreshBadge();
      }).catch((error) => {
        slot.busy = false;
        if (gpuState === state && !gpuFailed) console.warn("[Anime4K diagnóstico] No se pudieron leer los tiempos de filtros", error);
      });
    }

    function getTargetDimensions() {
      const rect = video.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const effectiveScale = getEffectiveScale();
      const width = Math.max(1, Math.round((rect.width || video.videoWidth || 1) * ratio * effectiveScale));
      const height = Math.max(1, Math.round((rect.height || video.videoHeight || 1) * ratio * effectiveScale));
      return { width, height };
    }

    function getPresetName(mode, quality) {
      const names = quality === "HQ"
        ? { A: "ModeAA", B: "ModeBB", C: "ModeCA" }
        : { A: "ModeA", B: "ModeB", C: "ModeC" };
      return names[mode];
    }

    function makePreset(device, inputTexture, width, height) {
      const library = globalThis["anime4k-webgpu"];
    if (activeQuality === "Máxima") return makeMaximumPreset(library, device, inputTexture, width, height);
      const presetName = getPresetName(activeMode, activeQuality);
      const Preset = library?.[presetName];
      if (!Preset) throw new Error(`La librería no ofrece el preset ${presetName}`);
      const mode = new Preset({
        device,
        inputTexture,
        nativeDimensions: { width: video.videoWidth, height: video.videoHeight },
        targetDimensions: { width, height }
      });
      console.info(`[Anime4K diagnóstico] Etapas seleccionadas por Modo ${activeMode} (${activeQuality}; ${presetName})`, mode.pipelines.map((stage) => stage.constructor.name));
      return mode;
    }

    function makeMaximumPreset(library, device, inputTexture, width, height) {
      if (!library) throw new Error("No se encontró la librería Anime4K WebGPU");
      const pipelines = [];
      const add = (name, texture = pipelines.at(-1)?.getOutputTexture() || inputTexture) => {
        const Pipeline = library[name];
        if (typeof Pipeline !== "function") return false;
        pipelines.push(new Pipeline({ device, inputTexture: texture }));
        return true;
      };
      const restore = activeMode === "A" ? "CNNUL" : "CNNVL";
      const upscale = typeof library.CNNx2UL === "function" ? "CNNx2UL" : "CNNx2VL";
      if (activeMode === "C") {
        // El modo C empieza por una etapa Upscale_Denoise, según la guía avanzada.
        if (!add("DenoiseCNNx2VL") && !add("CNNx2VL") && !add("CNNx2UL")) {
          throw new Error("No está disponible una etapa Anime4K x2 con reducción de ruido");
        }
      } else {
        const restoreName = activeMode === "B" && typeof library.CNNSoftVL === "function" ? "CNNSoftVL" : restore;
        if (!add(restoreName) && !add("CNNVL")) {
          throw new Error(`No está disponible la restauración Anime4K para el Modo ${activeMode}`);
        }
      }
      const scaled = add(upscale);
      if (!scaled && !add("CNNx2UL") && !add("CNNx2VL")) {
        throw new Error("No está disponible una etapa Anime4K de escalado x2");
      }
      let output = pipelines.at(-1).getOutputTexture();
      if (output.width > width || output.height > height) {
        const Downscale = library.Downscale;
        if (typeof Downscale === "function") {
          const fit = new Downscale({ device, inputTexture: output, targetDimensions: { width, height }, name: "max-fit-target" });
          pipelines.push(fit);
          output = fit.getOutputTexture();
        }
      }
      if (typeof library.GANUUL === "function") add("GANUUL", output);
      else console.warn("[Anime4K diagnóstico] GANUUL no está exportado; Máxima continúa sin esa etapa de restauración GAN.");
      const mode = {
        pipelines,
        pass(encoder) { for (const pipeline of pipelines) pipeline.pass(encoder); },
        getOutputTexture() { return pipelines.at(-1).getOutputTexture(); }
      };
      console.info(`[Anime4K diagnóstico] Etapas Máxima Modo ${activeMode}`, pipelines.map((stage) => stage.constructor.name));
      return mode;
    }

    function disposePreset(mode, device) {
      if (!mode) return;
      const textures = new Set();
      const visited = new Set();
      const visit = (stage) => {
        if (!stage || typeof stage !== "object" || visited.has(stage)) return;
        visited.add(stage);
        const texture = stage.getOutputTexture?.();
        if (texture && texture !== gpuState?.inputTexture) textures.add(texture);
        for (const key of ["pipelines", "pipelines6", "pipelinesUps"]) {
          if (Array.isArray(stage[key])) for (const child of stage[key]) visit(child);
        }
      };
      visit(mode);
      const release = () => {
        for (const texture of textures) {
          try { texture.destroy(); } catch { /* Ya liberada por el dispositivo. */ }
        }
      };
      device.queue.onSubmittedWorkDone().then(release).catch(() => {
        device.lost.then(release);
      });
    }

    function updateGpuTarget(state) {
      const target = getTargetDimensions();
      if (target.width === state.targetWidth && target.height === state.targetHeight) return false;

      const oldMode = state.animePipeline;
      canvas.width = target.width;
      canvas.height = target.height;
      state.gpuCanvas.configure({ device: state.device, format: state.format, alphaMode: "premultiplied" });
      state.animePipeline = makePreset(state.device, state.inputTexture, target.width, target.height);
      state.targetWidth = target.width;
      state.targetHeight = target.height;
      disposePreset(oldMode, state.device);
      frameMilliseconds = null;
      refreshBadge();
      console.info(`[Anime4K diagnóstico] Tamaño de salida actualizado: ${target.width}×${target.height} píxeles (${window.devicePixelRatio || 1} DPR)`);
      return true;
    }

    function updateVideoSourceDimensions(state) {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height || (width === state.width && height === state.height)) return false;
      const target = getTargetDimensions();
      if (state.interpolationPipeline) releaseInterpolationResources(state);
      const oldInput = state.inputTexture;
      const oldPreset = state.animePipeline;
      const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST;
      state.inputTexture = state.device.createTexture({
        label: "Anime4K input frame (resized)",
        size: { width, height, depthOrArrayLayers: 1 },
        format: "rgba16float",
        usage
      });
      state.width = width;
      state.height = height;
      canvas.width = target.width;
      canvas.height = target.height;
      state.gpuCanvas.configure({ device: state.device, format: state.format, alphaMode: "premultiplied" });
      state.animePipeline = makePreset(state.device, state.inputTexture, target.width, target.height);
      state.targetWidth = target.width;
      state.targetHeight = target.height;
      disposePreset(oldPreset, state.device);
      deferResourceDestroy(state, oldInput);
      frameMilliseconds = null;
      refreshBadge();
      console.info(`[Anime4K diagnóstico] Resolución de entrada actualizada: ${width}×${height}; escala actual ${outputScale === "Auto" ? `${getAutoScale()}× (Auto)` : `${getEffectiveScale()}×`}`);
      return true;
    }

    function rebuildPreset() {
      if (!gpuState || gpuFailed) { refreshBadge(); return; }
      try {
        const state = gpuState;
        const target = getTargetDimensions();
        const oldMode = state.animePipeline;
        canvas.width = target.width;
        canvas.height = target.height;
        state.gpuCanvas.configure({ device: state.device, format: state.format, alphaMode: "premultiplied" });
        state.animePipeline = makePreset(state.device, state.inputTexture, target.width, target.height);
        state.targetWidth = target.width;
        state.targetHeight = target.height;
        disposePreset(oldMode, state.device);
        frameMilliseconds = null;
        refreshBadge();
      } catch (error) {
        failGpu(error);
      }
    }

    function setMode(mode) {
      rebuildPreset();
      gpuStatus = `Anime4K Modo ${mode} (${activeQuality}) activo`;
      refreshBadge();
      revealPanel();
      redrawNow();
    }

    function setQuality(quality) {
      performanceWarning = "";
      rebuildPreset();
      gpuStatus = `Anime4K Modo ${activeMode} (${quality}) activo`;
      refreshBadge();
      revealPanel();
      redrawNow();
    }

    function setDetail(enabled) {
      detailEnabled = Boolean(enabled);
      if (detailEnabled && gpuState && !gpuFailed) ensureDetailResources(gpuState);
      if (!detailEnabled && gpuState) {
        const state = gpuState;
        for (const name of ["detailHorizontalTexture", "detailOutputTexture", "detailUniformBuffer"]) {
          if (state[name]) deferResourceDestroy(state, state[name]);
          state[name] = null;
        }
        state.detailIntensityUploaded = null;
        if (!sharpeningEnabled && state.sharpIntermediate) {
          deferResourceDestroy(state, state.sharpIntermediate);
          state.sharpIntermediate = null;
        }
      }
      detailFilterMilliseconds = null;
      refreshBadge();
      revealPanel();
      redrawNow();
    }

    function setDetailIntensity(intensity) {
      detailIntensity = Math.min(1, Math.max(0, Number(intensity)));
      if (gpuState && detailEnabled && gpuState.detailUniformBuffer) updateDetailUniform(gpuState);
      detailFilterMilliseconds = null;
      refreshBadge();
      redrawNow();
    }

    function setDetailSize(size) {
      if (!["Fino", "Medio", "Amplio"].includes(size)) return;
      detailSizeMode = size;
      if (gpuState && detailEnabled && gpuState.detailUniformBuffer) updateDetailUniform(gpuState);
      detailFilterMilliseconds = null;
      refreshBadge();
      redrawNow();
    }

    function setSharpening(enabled) {
      try {
        if (enabled && gpuState && !gpuFailed) ensureSharpenResources(gpuState);
        if (detailEnabled && gpuState) {
          if (enabled) ensureDetailResources(gpuState);
          else if (gpuState.detailOutputTexture) {
            deferResourceDestroy(gpuState, gpuState.detailOutputTexture);
            gpuState.detailOutputTexture = null;
          }
        }
        sharpeningFilterMilliseconds = null;
      } catch (error) { failGpu(error); return; }
      refreshBadge(); revealPanel(); redrawNow();
    }

    function setSharpeningIntensity(intensity) {
      if (gpuState?.sharpenUniformBuffer && sharpeningEnabled) updateSharpeningUniform(gpuState);
      sharpeningFilterMilliseconds = null;
      refreshBadge(); redrawNow();
    }

    function setLineEnhancementIntensity(intensity) {
      if (gpuState?.sharpenUniformBuffer && sharpeningEnabled) updateSharpeningUniform(gpuState);
      sharpeningFilterMilliseconds = null;
      refreshBadge(); redrawNow();
    }

    function setLineMaskDebug(enabled) {
      if (!sharpeningEnabled) return;
      lineMaskDebugEnabled = Boolean(enabled);
      lineMaskDebugLogged = false;
      if (gpuState?.sharpenUniformBuffer) updateSharpeningUniform(gpuState);
      refreshBadge(); revealPanel(); redrawNow();
    }

    function setScale(scale, automatic = false) {
      if (automatic) performanceWarning = `Rendimiento bajo: escala reducida automáticamente a ${scale}×.`;
      else performanceWarning = document.fullscreenElement
        ? `Escala ${scale === "Auto" ? "Auto" : `${scale}×`} guardada; se aplicará al salir de pantalla completa.`
        : "";
      if (gpuState && !gpuFailed) {
        try {
          updateGpuTarget(gpuState);
          placeOverlay();
          redrawNow();
        } catch (error) {
          failGpu(error);
        }
      } else redrawNow();
      refreshBadge();
      revealPanel();
    }

    function resetPerformanceAdjustment() {
      overBudgetSince = null;
      performanceSamples = [];
      performanceWarning = "";
      refreshBadge();
    }

    function updateFrameBudget(now, metadata) {
      const mediaTime = Number(metadata?.mediaTime);
      const presented = Number(metadata?.presentedFrames);
      if (document.hidden || video.paused || video.seeking || !Number.isFinite(mediaTime)) {
        resetVideoFpsHistory();
        return;
      }
      if (lastMediaTimeSeconds !== null) {
        const intervalSeconds = mediaTime - lastMediaTimeSeconds;
        const frameDelta = presented - lastMediaFrameNumber;
        const skipped = Number.isFinite(presented) && Number.isFinite(lastMediaFrameNumber) && frameDelta !== 1;
        if (!skipped && intervalSeconds >= 0.005 && intervalSeconds <= 0.1) {
          mediaIntervalSamples.push(intervalSeconds);
          if (mediaIntervalSamples.length > 41) mediaIntervalSamples.shift();
          if (mediaIntervalSamples.length >= 8) {
            const ordered = [...mediaIntervalSamples].sort((a, b) => a - b);
            const middle = ordered.length >> 1;
            const median = ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
            const measured = 1 / median;
            const standards = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
            videoFpsMeasured = standards.reduce((closest, candidate) => Math.abs(candidate - measured) < Math.abs(closest - measured) ? candidate : closest, standards[0]);
            frameBudgetMs = 1000 / videoFpsMeasured;
          }
        } else if (intervalSeconds > 0.1 || skipped) {
          // Un salto o callbacks perdidos no deben contaminar la mediana.
          mediaIntervalSamples.length = 0;
        }
      }
      if (mediaTime > lastMediaTimeSeconds || lastMediaTimeSeconds === null) lastMediaTimeSeconds = mediaTime;
      lastMediaFrameNumber = Number.isFinite(presented) ? presented : null;
    }

    function resetVideoFpsHistory(resetEstimate = false) {
      mediaIntervalSamples.length = 0;
      lastMediaTimeSeconds = null;
      lastMediaFrameNumber = null;
      if (resetEstimate) {
        videoFpsMeasured = 24;
        frameBudgetMs = 1000 / 24;
      }
    }

    function monitorPerformance(now) {
      if (frameMilliseconds === null || !Number.isFinite(frameMilliseconds)) return;
      const windowMs = 5000;
      const effectiveBudgetMs = frameBudgetMs;
      const toleratedBudget = effectiveBudgetMs * 1.3;
      performanceSamples.push({ at: now, milliseconds: frameMilliseconds });
      while (performanceSamples.length && now - performanceSamples[0].at > windowMs) performanceSamples.shift();
      const windowIsReady = performanceSamples.length > 1 && now - performanceSamples[0].at >= windowMs - 250;
      if (!windowIsReady) {
        overBudgetSince = null;
        refreshBadge();
        return;
      }
      const averageMilliseconds = performanceSamples.reduce((sum, sample) => sum + sample.milliseconds, 0) / performanceSamples.length;
      if (activeQuality === "Máxima") {
        overBudgetSince = null;
        performanceWarning = averageMilliseconds > effectiveBudgetMs
          ? `Calidad Máxima promedia ${averageMilliseconds.toFixed(1)} ms/frame durante 5 s, por encima del presupuesto de ${effectiveBudgetMs.toFixed(1)} ms; sugerencia: bajar a HQ.`
          : "";
        refreshBadge();
        return;
      }
      if (averageMilliseconds <= toleratedBudget) {
        overBudgetSince = null;
        if (performanceWarning.startsWith("Promedio de render real")) performanceWarning = "";
        refreshBadge();
        return;
      }
      performanceWarning = `Promedio de render real (CPU + espera de cola GPU): ${averageMilliseconds.toFixed(1)} ms durante 5 s; límite con tolerancia: ${toleratedBudget.toFixed(1)} ms.`;
      if (overBudgetSince === null) overBudgetSince = now;
      if (now - overBudgetSince < 1000 || now - lastAutomaticScaleAdjustment < 5000) {
        refreshBadge();
        return;
      }
      overBudgetSince = now;
      lastAutomaticScaleAdjustment = now;
      if (!document.fullscreenElement && outputScale !== "Auto" && outputScale > 1) {
        outputScale = outputScale === 2 ? 1.5 : 1;
        broadcast("setScale", outputScale, true);
      } else {
        performanceWarning = "Procesamiento lento: no queda una escala automática más liviana.";
        refreshBadge();
      }
    }

    function scheduleGpuResize() {
      if (aiProcessing || aiResultReady || aiPreviewActive) cancelAiImproveFrame();
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        if (fluencyEnabled) measureMonitorRefresh();
        if (gpuFailed) return;
        if (!gpuState) {
          redrawNow();
          return;
        }
        try {
          if (fluencyEnabled) resetInterpolationHistory("cambio de tamaño");
          if (updateVideoSourceDimensions(gpuState) || updateGpuTarget(gpuState)) placeOverlay();
          redrawNow();
        } catch (error) {
          failGpu(error);
        }
      }, 100);
    }

    function buildFrameResources(device, width, height, target) {
      const textureUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST;
      const inputTexture = device.createTexture({
        label: "Anime4K input frame",
        size: { width, height, depthOrArrayLayers: 1 },
        format: "rgba16float",
        usage: textureUsage
      });
      const animePipeline = makePreset(device, inputTexture, target.width, target.height);
      return { width, height, inputTexture, animePipeline, targetWidth: target.width, targetHeight: target.height };
    }

    async function initializeGpu() {
      if (!navigator.gpu) throw new Error("WebGPU no está disponible en este marco de Brave");
      const library = globalThis["anime4k-webgpu"];
      if (!library?.[getPresetName(activeMode, activeQuality)]) throw new Error("No se pudo cargar el preset Anime4K-WebGPU seleccionado");
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error("Brave no encontró un adaptador WebGPU disponible");
      const supportsTimestamps = adapter.features?.has("timestamp-query") === true;
      const device = await adapter.requestDevice({ requiredFeatures: supportsTimestamps ? ["timestamp-query"] : [] });
      const target = getTargetDimensions();
      canvas.width = target.width;
      canvas.height = target.height;
      const gpuCanvas = canvas.getContext("webgpu");
      if (!gpuCanvas) throw new Error("No se pudo crear el contexto WebGPU del canvas");
      const format = navigator.gpu.getPreferredCanvasFormat();
      gpuCanvas.configure({ device, format, alphaMode: "premultiplied" });

      const copyPipeline = makeRenderPipeline(device, copyShader, "rgba16float", "Importar frame de video");
      const displayPipeline = makeRenderPipeline(device, displayShader, format, "Mostrar salida Anime4K");
      const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
      const frameResources = buildFrameResources(device, video.videoWidth, video.videoHeight, target);
      const state = { adapter, device, gpuCanvas, format, copyPipeline, displayPipeline, sampler, detailHorizontalPipeline: null, detailVerticalPipeline: null, detailUniformBuffer: null, detailIntensityUploaded: null, detailHorizontalTexture: null, detailOutputTexture: null, sharpenPipeline: null, sharpenUniformBuffer: null, sharpenIntensityUploaded: null, sharpIntermediate: null, ...frameResources };
      if (supportsTimestamps) {
        state.timestampQuerySet = device.createQuerySet({ type: "timestamp", count: 8, label: "Anime4K optional filter timings" });
        state.timestampResolveBuffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC, label: "Anime4K timing resolve" });
        state.timestampReadbacks = Array.from({ length: 3 }, (_, index) => ({
          buffer: device.createBuffer({ size: 64, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: `Anime4K timing readback ${index}` }),
          busy: false
        }));
      }
      device.lost.then((info) => {
        if (gpuState === state && !gpuFailed) failGpu(new Error(`Dispositivo WebGPU perdido: ${info.message || info.reason}`));
      });
      device.addEventListener("uncapturederror", (event) => {
        const error = event.error || new Error("Error WebGPU no capturado");
        if (fluencyEnabled || fluencyGpuCommandsInFlight > 0) {
          if (fluencyEnabled) failFluency(error);
          else console.warn("[Anime4K diagnóstico] Error tardío de Generación de fotogramas aislado", error);
        }
        else failGpu(error);
      });
      return state;
    }

    function failFluency(error) {
      if (!fluencyEnabled) return;
      const detail = `${error?.name || "Error"}: ${error?.message || error}`;
      chooseFluency(false);
      fluencyFailureNotice = `Generación de fotogramas se apagó por un error; Anime4K sigue activo (${detail})`;
      if (fluencyFailureNoticeTimer !== null) clearTimeout(fluencyFailureNoticeTimer);
      fluencyFailureNoticeTimer = setTimeout(() => {
        fluencyFailureNotice = "";
        fluencyFailureNoticeTimer = null;
        refreshBadge();
      }, 5000);
      say("Generación de fotogramas se apagó; Anime4K sigue activo", detail);
      refreshBadge();
      redrawNow();
      console.warn("[Anime4K diagnóstico] Error aislado de Generación de fotogramas; se mantiene el pipeline Anime4K", error);
    }

    function failGpu(error) {
      if (gpuFailed) return;
      gpuFailed = true;
      hasReadableFrame = false;
      releaseInterpolationResources(gpuState);
      canvas.style.display = "none";
      restoreOriginal();
      syncControlStacking(false);
      for (const [element, previous] of changedControls) {
        if (!element.isConnected) continue;
        for (const [property, value] of Object.entries(previous)) {
          if (value.value) element.style.setProperty(property, value.value, value.priority);
          else element.style.removeProperty(property);
        }
      }
      changedControls.clear();
      const name = error?.name || "Error";
      const reason = error?.message || String(error);
      say("WebGPU/Anime4K falló; se muestra el video original", `${name}: ${reason}`);
      const failedState = gpuState;
      destroyDeviceAfterQueue(failedState);
      gpuState = null;
      placeOverlay();
    }

    function redrawNow() {
      if (stopped || (!overlayEnabled && !aiPreviewActive)) return;
      requestAnimationFrame(() => {
        if (!stopped && (overlayEnabled || aiPreviewActive)) void renderCurrentFrame();
      });
    }

    async function renderAiCurrentFrame(state, sourceCanvas = aiResultCanvas) {
      let aiFrame = null;
      let aiFrameSubmitted = false;
      try {
        if ((!video.paused || !aiPreviewActive || !aiResultReady) || !sourceCanvas.width) return false;
        if (detailEnabled) ensureDetailResources(state);
        if (sharpeningEnabled) ensureSharpenResources(state);
        if (!state.aiCopyPipeline) state.aiCopyPipeline = makeRenderPipeline(state.device, copyShader, state.format, "Presentar foto IA x2");
        if (typeof VideoFrame !== "function") throw new Error("Este navegador no permite crear VideoFrame desde el canvas IA");
        aiFrame = new VideoFrame(sourceCanvas, { timestamp: 0 });
        const external = state.device.importExternalTexture({ source: aiFrame });
        const bindGroup = state.device.createBindGroup({
          layout: state.aiCopyPipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: external }, { binding: 1, resource: state.sampler }]
        });
        const encoder = state.device.createCommandEncoder({ label: "Anime4K presentación de foto IA pausada" });
        const filtered = detailEnabled || sharpeningEnabled;
        const baseTarget = filtered ? state.sharpIntermediate : state.gpuCanvas.getCurrentTexture();
        const basePass = encoder.beginRenderPass({
          colorAttachments: [{ view: baseTarget.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }]
        });
        basePass.setPipeline(state.aiCopyPipeline);
        basePass.setBindGroup(0, bindGroup);
        basePass.draw(3);
        basePass.end();
        if (detailEnabled) {
          const horizontalBind = state.device.createBindGroup({
            layout: state.detailHorizontalPipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: state.sampler }, { binding: 1, resource: state.sharpIntermediate.createView() }, { binding: 2, resource: { buffer: state.detailUniformBuffer } }]
          });
          const verticalBind = state.device.createBindGroup({
            layout: state.detailVerticalPipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: state.sampler }, { binding: 1, resource: state.sharpIntermediate.createView() }, { binding: 2, resource: state.detailHorizontalTexture.createView() }, { binding: 3, resource: { buffer: state.detailUniformBuffer } }]
          });
          const horizontal = encoder.beginRenderPass({ colorAttachments: [{ view: state.detailHorizontalTexture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }] });
          horizontal.setPipeline(state.detailHorizontalPipeline); horizontal.setBindGroup(0, horizontalBind); horizontal.draw(3); horizontal.end();
          const verticalTarget = sharpeningEnabled ? state.detailOutputTexture : state.gpuCanvas.getCurrentTexture();
          const vertical = encoder.beginRenderPass({ colorAttachments: [{ view: verticalTarget.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }] });
          vertical.setPipeline(state.detailVerticalPipeline); vertical.setBindGroup(0, verticalBind); vertical.draw(3); vertical.end();
        }
        if (sharpeningEnabled) {
          const sharpenBind = state.device.createBindGroup({
            layout: state.sharpenPipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: state.sampler }, { binding: 1, resource: (detailEnabled ? state.detailOutputTexture : state.sharpIntermediate).createView() }, { binding: 2, resource: { buffer: state.sharpenUniformBuffer } }]
          });
          const sharpen = encoder.beginRenderPass({ colorAttachments: [{ view: state.gpuCanvas.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }] });
          sharpen.setPipeline(state.sharpenPipeline); sharpen.setBindGroup(0, sharpenBind); sharpen.draw(3); sharpen.end();
        }
        state.device.queue.submit([encoder.finish()]);
        aiFrameSubmitted = true;
        hasReadableFrame = true;
        const pending = state.device.queue.onSubmittedWorkDone();
        aiPresentationPending = pending;
        pending.then(() => aiFrame?.close(), () => aiFrame?.close());
        aiFrame = null;
        pending.then(() => {
          if (aiPresentationPending === pending) aiPresentationPending = null;
          if (gpuState === state) { refreshComparisonPresentation(); placeOverlay(); }
        }, (error) => {
          if (aiPresentationPending === pending) aiPresentationPending = null;
          console.warn("[Anime4K IA] No se pudo terminar la presentación", error);
        });
        refreshComparisonPresentation();
        placeOverlay();
        refreshBadge();
        return true;
      } catch (error) {
        if (aiFrame) {
          const frameToClose = aiFrame;
          aiFrame = null;
          if (aiFrameSubmitted) {
            void state.device.queue.onSubmittedWorkDone().then(() => frameToClose.close(), () => frameToClose.close());
          } else frameToClose.close();
        }
        console.error("[IA Error]:", error);
        aiPreviewActive = false;
        showToast(`No se pudo presentar la foto IA: ${error?.message || error}`);
        refreshComparisonPresentation();
        placeOverlay();
        return false;
      }
    }

    async function renderCurrentFrame(frameTexture = null, fluencyOutputKind = null, fluencyGenerationToken = null) {
      if (stopped) return false;
      if (frameTexture && fluencyGenerationToken !== null && fluencyGenerationToken !== fluencyGeneration) return false;
      if (renderingFrame) {
        await renderLockPromise;
        if (frameTexture && fluencyGenerationToken !== null && fluencyGenerationToken !== fluencyGeneration) return false;
        return renderCurrentFrame(frameTexture, fluencyOutputKind, fluencyGenerationToken);
      }
      renderingFrame = true;
      let releaseRenderLock;
      renderLockPromise = new Promise((resolve) => { releaseRenderLock = resolve; });
      let frameSubmitted = false;
      try {
        if ((!overlayEnabled && !aiPreviewActive) || !settingsLoaded) return;
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) {
          say("Esperando un frame disponible");
          return;
        }
        if (gpuFailed) return;
        if (!gpuState) {
          say(`Inicializando WebGPU y Anime4K Modo ${activeMode} (${activeQuality})…`);
          const initializedState = await initializeGpu();
          if (stopped || !siteActivated || (!overlayEnabled && !aiPreviewActive)) {
            try { initializedState.device.destroy(); } catch { /* Se desactivó mientras se inicializaba. */ }
            return;
          }
          gpuState = initializedState;
        }
        if (gpuState.width !== video.videoWidth || gpuState.height !== video.videoHeight) updateVideoSourceDimensions(gpuState);
        updateGpuTarget(gpuState);

        const state = gpuState;
        if (aiPreviewActive && aiResultReady && video.paused && !frameTexture) {
          frameSubmitted = await renderAiCurrentFrame(state);
          return frameSubmitted;
        }
        const startedAt = performance.now();
        const sharpenPassSubmitted = sharpeningEnabled;
        const lineMaskPassSubmitted = sharpeningEnabled && lineMaskDebugEnabled;
        if (detailEnabled) ensureDetailResources(state);
        if (sharpeningEnabled) ensureSharpenResources(state);
        // El frame actual se importa desde el callback normal o desde el redibujado
        // solicitado por una tecla; la textura externa se envía a la cola en esta tarea.
        const externalFrame = frameTexture ? null : state.device.importExternalTexture({ source: video });
        const importPipeline = frameTexture ? state.copyTexturePipeline : state.copyPipeline;
        const copyBindGroup = state.device.createBindGroup(frameTexture ? {
          layout: importPipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: state.sampler }, { binding: 1, resource: frameTexture.createView() }]
        } : {
          layout: importPipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: externalFrame }, { binding: 1, resource: state.sampler }]
        });
        let displayPipeline = state.displayPipeline;
        let displayEntries = [
          { binding: 0, resource: state.sampler },
          { binding: 1, resource: state.animePipeline.getOutputTexture().createView() }
        ];
        const displayBindGroup = state.device.createBindGroup({
          layout: displayPipeline.getBindGroupLayout(0),
          entries: displayEntries
        });
        const detailHorizontalBindGroup = detailEnabled ? state.device.createBindGroup({
          layout: state.detailHorizontalPipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: state.sampler }, { binding: 1, resource: state.sharpIntermediate.createView() }, { binding: 2, resource: { buffer: state.detailUniformBuffer } }]
        }) : null;
        const detailVerticalBindGroup = detailEnabled ? state.device.createBindGroup({
          layout: state.detailVerticalPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: state.sampler },
            { binding: 1, resource: state.sharpIntermediate.createView() },
            { binding: 2, resource: state.detailHorizontalTexture.createView() },
            { binding: 3, resource: { buffer: state.detailUniformBuffer } }
          ]
        }) : null;
        const sharpBindGroup = sharpeningEnabled ? state.device.createBindGroup({
          layout: state.sharpenPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: state.sampler },
            { binding: 1, resource: (detailEnabled ? state.detailOutputTexture : state.sharpIntermediate).createView() },
            { binding: 2, resource: { buffer: state.sharpenUniformBuffer } }
          ]
        }) : null;
        const timestampWrites = state.timestampQuerySet ? {
          detailHorizontal: { querySet: state.timestampQuerySet, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 },
          detailVertical: { querySet: state.timestampQuerySet, beginningOfPassWriteIndex: 4, endOfPassWriteIndex: 5 },
          sharpen: { querySet: state.timestampQuerySet, beginningOfPassWriteIndex: 6, endOfPassWriteIndex: 7 }
        } : null;
        const encoder = state.device.createCommandEncoder({ label: "Anime4K frame" });
        const importTarget = state.inputTexture;
        const importPass = encoder.beginRenderPass({
          colorAttachments: [{ view: importTarget.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }]
        });
        importPass.setPipeline(importPipeline);
        importPass.setBindGroup(0, copyBindGroup);
        importPass.draw(3);
        importPass.end();
        state.animePipeline.pass(encoder);
        const displayTarget = detailEnabled || sharpeningEnabled ? state.sharpIntermediate : state.gpuCanvas.getCurrentTexture();
        const displayPass = encoder.beginRenderPass({
          colorAttachments: [{ view: displayTarget.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }]
        });
        displayPass.setPipeline(displayPipeline);
        displayPass.setBindGroup(0, displayBindGroup);
        displayPass.draw(3);
        displayPass.end();
        if (detailEnabled) {
          const horizontalPass = encoder.beginRenderPass({
            colorAttachments: [{ view: state.detailHorizontalTexture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
            ...(timestampWrites ? { timestampWrites: timestampWrites.detailHorizontal } : {})
          });
          horizontalPass.setPipeline(state.detailHorizontalPipeline);
          horizontalPass.setBindGroup(0, detailHorizontalBindGroup);
          horizontalPass.draw(3);
          horizontalPass.end();
          const verticalPass = encoder.beginRenderPass({
            colorAttachments: [{ view: (sharpeningEnabled ? state.detailOutputTexture : state.gpuCanvas.getCurrentTexture()).createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
            ...(timestampWrites ? { timestampWrites: timestampWrites.detailVertical } : {})
          });
          verticalPass.setPipeline(state.detailVerticalPipeline);
          verticalPass.setBindGroup(0, detailVerticalBindGroup);
          verticalPass.draw(3);
          verticalPass.end();
        }
        if (sharpeningEnabled) {
          const sharpenPass = encoder.beginRenderPass({
            colorAttachments: [{ view: state.gpuCanvas.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
            ...(timestampWrites ? { timestampWrites: timestampWrites.sharpen } : {})
          });
          sharpenPass.setPipeline(state.sharpenPipeline);
          sharpenPass.setBindGroup(0, sharpBindGroup);
          sharpenPass.draw(3);
          sharpenPass.end();
        }
        const timingReadback = recordFilterTimings(state, encoder, detailEnabled, sharpeningEnabled);
        const inputSlot = frameTexture ? state.fluencyPool?.find((slot) => slot.texture === frameTexture) : null;
        if (inputSlot) markFluencySlotsInFlight([inputSlot]);
        try { state.device.queue.submit([encoder.finish()]); }
        catch (error) {
          if (inputSlot) markFluencySubmitComplete([inputSlot]);
          throw error;
        }
        frameSubmitted = true;
        if (fluencyOutputKind && fluencyEnabled) observeCanvasOutput(state, fluencyOutputKind);
        readFilterTimings(state, timingReadback, detailEnabled, sharpeningEnabled);
        hasReadableFrame = true;
        if (overlayEnabled && !comparisonEnabled && !originalPreviewHeld && !hiddenOriginal && document.fullscreenElement !== video) {
          video.style.setProperty("opacity", "0", "important");
          hiddenOriginal = true;
        }
        say(`Anime4K Modo ${activeMode} (${activeQuality}) activo`);
        state.device.queue.onSubmittedWorkDone().then(() => {
          if (inputSlot) markFluencySubmitComplete([inputSlot]);
          if (gpuState !== state || gpuFailed) return;
          if (fluencyOutputKind !== "intermediate") {
            frameMilliseconds = performance.now() - startedAt;
            refreshBadge();
          }
          if (sharpenPassSubmitted && !sharpeningPassLogged) {
            sharpeningPassLogged = true;
            console.info(`[Anime4K diagnóstico] Pasada de nitidez completada: Anime4K → textura intermedia ${state.targetWidth}×${state.targetHeight} → pasada unsharp mask → canvas ${canvas.width}×${canvas.height}.`);
          }
          if (lineMaskPassSubmitted && !lineMaskDebugLogged) {
            lineMaskDebugLogged = true;
            console.info(`[Anime4K diagnóstico] Máscara de líneas ejecutada y presentada: textura de entrada ${state.sharpIntermediate.width}×${state.sharpIntermediate.height} → salida blanco/negro → canvas ${canvas.width}×${canvas.height}.`);
          }
          if (fluencyOutputKind === "real" || (activeQuality === "Máxima" && fluencyOutputKind !== "intermediate")) {
            monitorPerformance(performance.now());
            if (fluencyOutputKind === "real") monitorFluencyRender(performance.now(), frameMilliseconds);
          }
        }).catch((error) => {
          if (inputSlot) markFluencySubmitComplete([inputSlot]);
          if (inputSlot && fluencyEnabled) failFluency(error);
          else failGpu(error);
        });
      } catch (error) {
        const message = error?.name === "SecurityError"
          ? "El navegador bloqueó la importación del video por CORS/DRM"
          : `${error?.name || "Error"}: ${error?.message || error}`;
        if (frameTexture && fluencyEnabled) failFluency(new Error(message));
        else failGpu(new Error(message));
      } finally {
        placeOverlay();
        renderingFrame = false;
        releaseRenderLock();
      }
      return frameSubmitted;
    }

    async function processFrame(now, metadata) {
      if (stopped) return;
      const previousFrameBudget = frameBudgetMs;
      updateFrameBudget(now, metadata);
      if (fluencyEnabled && Math.abs(frameBudgetMs - previousFrameBudget) > previousFrameBudget * 0.03) updateFluencyTargetWarning(true);
      if (fluencyEnabled && gpuState?.fluencyPool && gpuState.fluencyPoolIntermediates !== getMaximumIntermediatesPerFrame()) resetInterpolationHistory("cambio de fps del video");
      // Registrar el próximo callback antes de cualquier espera de GPU evita
      // dejar al video sin una suscripción mientras calculamos el intermedio.
      if (!stopped && !gpuFailed && video.requestVideoFrameCallback) callbackId = video.requestVideoFrameCallback(processFrame);
      if (videoFpsMeasured >= 48 && fluencyEnabled) chooseFluency(false);
      if (document.hidden) {
        resetInterpolationHistory();
        return;
      }
      const fluencyActive = !video.paused && fluencyEnabled && overlayEnabled && !originalPreviewHeld && videoFpsMeasured < 48 && getMaximumIntermediatesPerFrame() > 0 && gpuState && !gpuFailed;
      if (fluencyActive) {
        const state = gpuState;
        try { ensureInterpolationResources(state); }
        catch (error) {
          failFluency(error);
          await renderCurrentFrame(null, "real");
          return;
        }
        const expected = Number.isFinite(metadata?.expectedDisplayTime) ? metadata.expectedDisplayTime : now;
        const media = Number.isFinite(metadata?.mediaTime) ? metadata.mediaTime * 1000 : null;
        let interval = previousFrameTiming ? expected - previousFrameTiming.expected : frameBudgetMs;
        if ((!Number.isFinite(interval) || interval < 5 || interval > 200) && previousFrameTiming && media !== null && previousFrameTiming.media !== null) interval = media - previousFrameTiming.media;
        interval = Math.max(5, Math.min(200, Number.isFinite(interval) ? interval : frameBudgetMs));
        const timing = { expected, media, interval, latency: interval };
        const generation = fluencyGeneration;
        const record = acquireFluencySlot(state);
        if (!record) {
          skippedFrames += 1;
          void renderCurrentFrame(null, "real");
          refreshBadge();
          return;
        }
        record.presentationTime = expected;
        record.intervalMs = interval;
        record.latencyMs = interval;
        // Copiar el frame de video se hace dentro del callback para no perder
        // el frame mientras esperamos la estimación de movimiento.
        try { copyExternalToTexture(state, record); }
        catch (error) {
          releaseQueuedTexture(record);
          failFluency(error);
          await renderCurrentFrame(null, "real");
          return;
        }
        fluencyProcessing = fluencyProcessing.then(async () => {
          if (stopped || generation !== fluencyGeneration || gpuState !== state || !fluencyEnabled) { releaseQueuedTexture(record); return; }
          try {
            enqueuePresentation(record, expected + interval, "real");
            if (fluencyDegraded) {
              skippedFrames += 1;
              if (interpolationHistory && typeof interpolationHistory === "object") releaseQueuedTexture(interpolationHistory);
              interpolationHistory = record;
              previousFrameTiming = timing;
              refreshBadge();
              return;
            }
            if (!interpolationHistory) {
              if (interpolationHistory && typeof interpolationHistory === "object") releaseQueuedTexture(interpolationHistory);
              interpolationHistory = record;
              previousFrameTiming = timing;
              refreshBadge();
              return;
            }
            const previous = interpolationHistory;
            const previousTiming = previousFrameTiming;
            // Emitir los N−1 intermedios en posiciones uniformes del intervalo.
            record.presentationTime = expected;
            record.intervalMs = interval;
            record.latencyMs = interval;
            previous.presentationTime = previousTiming?.expected ?? expected - interval;
            const frameCount = nextOutputFrameCount();
            let generated = 0;
            for (let index = 1; index < frameCount; index += 1) {
              const fraction = index / frameCount;
              const queued = await renderInterpolatedFrame(state, previous, record, generation, fraction, expected + interval * fraction);
              if (queued) generated += 1;
            }
            if (generation !== fluencyGeneration || !fluencyEnabled) {
              releaseQueuedTexture(record);
              return;
            }
            if (generated < frameCount - 1) skippedFrames += frameCount - 1 - generated;
            releaseQueuedTexture(previous);
            interpolationHistory = record;
            previousFrameTiming = timing;
          } catch (error) {
            skippedFrames += 1;
            releaseQueuedTexture(record);
            failFluency(error);
            refreshBadge();
            await renderCurrentFrame(null, "real");
          }
        });
      } else {
        if (document.hidden || video.paused || videoFpsMeasured >= 48 || getMaximumIntermediatesPerFrame() <= 0) {
          resetInterpolationHistory(document.hidden ? "pestaña oculta" : video.paused ? "pausa" : videoFpsMeasured >= 48 ? "video de 48 fps o más" : "el objetivo no supera los fps del video");
        }
        await renderCurrentFrame(null, fluencyEnabled ? "real" : null);
      }
      refreshBadge();
    }

    say(video.requestVideoFrameCallback ? "Esperando un frame para iniciar WebGPU…" : "Este navegador no ofrece requestVideoFrameCallback");
    placeOverlay();
    if (fluencyEnabled) measureMonitorRefresh();
    if (video.requestVideoFrameCallback) callbackId = video.requestVideoFrameCallback(processFrame);
    else failGpu(new Error("requestVideoFrameCallback no está disponible"));

    const positionLoop = () => {
      if (stopped) return;
      placeOverlay();
      positionTimer = setTimeout(positionLoop, video.paused ? 250 : 33);
    };
    positionLoop();

    video.addEventListener("loadedmetadata", placeOverlay);
    video.addEventListener("loadedmetadata", scheduleGpuResize);
    video.addEventListener("resize", scheduleGpuResize);
    const resetOnSeek = () => {
      cancelAiImproveFrame(); resetVideoFpsHistory(); resetInterpolationHistory("seek");
    };
    const resetOnPause = () => {
      resetVideoFpsHistory(); resetInterpolationHistory("pausa"); redrawNow();
    };
    const resetOnPlay = () => { cancelAiImproveFrame(); resetVideoFpsHistory(); resetInterpolationHistory("reproducción"); };
    const resetOnVisibility = () => {
      resetVideoFpsHistory();
      resetInterpolationHistory(document.hidden ? "pestaña oculta" : "pestaña visible");
      if (!document.hidden && fluencyEnabled && overlayEnabled) redrawNow();
    };
    const resetOnMetadata = () => {
      resetVideoFpsHistory(true);
    };
    video.addEventListener("loadedmetadata", resetOnMetadata);
    video.addEventListener("seeking", resetOnSeek);
    video.addEventListener("seeked", resetOnSeek);
    video.addEventListener("pause", resetOnPause);
    video.addEventListener("play", resetOnPlay);
    video.addEventListener("loadstart", resetOnSeek);
    document.addEventListener("visibilitychange", resetOnVisibility);
    const handleEmptied = () => {
      cancelAiImproveFrame();
      resetVideoFpsHistory(true);
      resetInterpolationHistory("cambio o vaciado de video");
      const emptiedState = gpuState;
      releaseInterpolationResources(emptiedState);
      hasReadableFrame = false;
      restoreOriginal();
      canvas.style.display = "none";
      destroyDeviceAfterQueue(emptiedState);
      gpuState = null;
      gpuFailed = false;
      frameMilliseconds = null;
      say("Esperando un frame nuevo");
    };
    video.addEventListener("emptied", handleEmptied);
    document.addEventListener("fullscreenchange", syncFullscreenLayer);
    document.addEventListener("fullscreenchange", scheduleGpuResize);
    document.addEventListener("fullscreenchange", resetOnSeek);
    window.addEventListener("resize", scheduleGpuResize);
    const handleWindowScroll = () => placeOverlay();
    window.addEventListener("scroll", handleWindowScroll, { capture: true, passive: true });
    if (typeof ResizeObserver !== "undefined") {
      sizeObserver = new ResizeObserver(scheduleGpuResize);
      sizeObserver.observe(video);
    }
    function teardown() {
      if (stopped) return;
      cancelAiImproveFrame();
      stopped = true;
      refreshMeasurementId += 1;
      if (fluencyTargetWarningTimer !== null) clearTimeout(fluencyTargetWarningTimer);
      if (panelHideTimer !== null) clearTimeout(panelHideTimer);
      if (fluencyFailureNoticeTimer !== null) clearTimeout(fluencyFailureNoticeTimer);
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      if (callbackId !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(callbackId);
      if (positionTimer !== null) clearTimeout(positionTimer);
      sizeObserver?.disconnect();
      tabContentResizeObserver.disconnect();
      playerMutationObserver?.disconnect();
      video.removeEventListener("loadedmetadata", placeOverlay);
      video.removeEventListener("loadedmetadata", scheduleGpuResize);
      video.removeEventListener("loadedmetadata", resetOnMetadata);
      video.removeEventListener("resize", scheduleGpuResize);
      video.removeEventListener("seeking", resetOnSeek);
      video.removeEventListener("seeked", resetOnSeek);
      video.removeEventListener("pause", resetOnPause);
      video.removeEventListener("play", resetOnPlay);
      video.removeEventListener("loadstart", resetOnSeek);
      document.removeEventListener("visibilitychange", resetOnVisibility);
      video.removeEventListener("emptied", handleEmptied);
      document.removeEventListener("fullscreenchange", syncFullscreenLayer);
      document.removeEventListener("fullscreenchange", scheduleGpuResize);
      document.removeEventListener("fullscreenchange", resetOnSeek);
      window.removeEventListener("resize", scheduleGpuResize);
      window.removeEventListener("scroll", handleWindowScroll, true);
      playerContainer.removeEventListener("pointermove", revealPanel, true);
      playerContainer.removeEventListener("pointerdown", revealPanel, true);
      uiHost.removeEventListener("pointermove", revealPanel, true);
      uiHost.removeEventListener("pointerdown", revealPanel, true);
      restoreOriginal();
      syncControlStacking(false);
      const teardownState = gpuState;
      releaseInterpolationResources(teardownState);
      destroyDeviceAfterQueue(teardownState);
      gpuState = null;
      canvas.remove();
      uiHost.remove();
      compareHost.remove();
      for (const element of [...changedUiParentPositions.keys()]) restoreUiParentPosition(element);
      running.delete(video);
      if (diagnosticController) diagnostics.delete(diagnosticController);
    }
    diagnosticController = { setEnabled, setComparison, setComparisonLabels, setOriginalPreview, setPanelPosition, setFpsHudPosition, toggleFpsHud, improveAiFrame, setMode, setQuality, setScale, setDetail, setDetailIntensity, setDetailSize, setSharpening, setSharpeningIntensity, setLineEnhancementIntensity, setLineMaskDebug, setFluency, resetPerformanceAdjustment, toggleStats, applySettings, settingsReady, refreshShortcutLabels, setPanelManuallyHidden: applyPanelManualVisibility, isPanelVisible: () => panelVisible, deactivate: teardown };
    diagnostics.add(diagnosticController);
    if (settingsLoaded) settingsReady();
    logPlayerTree();
    playerMutationObserver = new MutationObserver((changes) => {
      const selector = "button,[role='button'],[role='slider'],input[type='range'],[class*='control' i],[id*='control' i],[aria-label*='volume' i]";
      const addedControls = changes.some((change) => [...change.addedNodes].some((node) => node instanceof Element && (node.matches(selector) || node.querySelector(selector))));
      if (addedControls && overlayEnabled) {
        logPlayerTree();
      }
    });
    playerMutationObserver.observe(playerContainer, { childList: true, subtree: true });
  }

  function scan(root = document) {
    if (!siteActivated || !settingsLoaded) return;
    const videos = [];
    if (root instanceof HTMLVideoElement) videos.push(root);
    if (root.querySelectorAll) videos.push(...root.querySelectorAll("video"));
    for (const video of videos) addDiagnostic(video);
  }

  scan();
  new MutationObserver((changes) => {
    for (const change of changes) for (const node of change.addedNodes) scan(node);
  }).observe(document.documentElement, { childList: true, subtree: true });
})();


