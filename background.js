const AI_CHANNEL = "anime4k-ai";
const ENGINE_CHANNEL = "anime4k-engine";
const ENGINE_SCRIPTS = {
  controller: "content.js",
  engine: "vendor/anime4k-webgpu-1.0.0.js"
};
const OFFSCREEN_CHANNEL = "anime4k-ai-offscreen";
const OFFSCREEN_PATH = "offscreen.html";
let offscreenCreation = null;
const activeTasks = new Set();

async function ensureAiOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
    if (contexts.length) return;
  } else if (typeof clients !== "undefined") {
    const existing = await clients.matchAll();
    if (existing.some((client) => client.url === url)) return;
  }
  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["BLOBS"],
      justification: "Ejecutar el modelo ONNX solo cuando el usuario solicita procesar un frame pausado para guardarlo como imagen."
    }).finally(() => { offscreenCreation = null; });
  }
  await offscreenCreation;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.channel === ENGINE_CHANNEL && sender.id === chrome.runtime.id) {
    (async () => {
      const script = ENGINE_SCRIPTS[message.action];
      if (!script || !Number.isInteger(sender.tab?.id) || !Number.isInteger(sender.frameId)) {
        throw new Error("No se pudo identificar la pestaña o el frame del reproductor");
      }
      const pageUrl = new URL(sender.url || sender.origin || "");
      if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") {
        throw new Error("Anime4K solo puede cargarse en páginas HTTP o HTTPS");
      }
      const hostname = pageUrl.hostname;
      const saved = await chrome.storage.local.get(hostname);
      if (saved?.[hostname]?.activated !== true) {
        throw new Error("Este sitio todavía no está activado en Anime4K");
      }
      await chrome.scripting.executeScript({
        target: { tabId: sender.tab.id, frameIds: [sender.frameId] },
        files: [script],
        world: "ISOLATED"
      });
      return { ok: true };
    })().then(sendResponse, (error) => {
      sendResponse({ ok: false, error: `${error?.name || "Error"}: ${error?.message || error}` });
    });
    return true;
  }
  if (message?.channel !== AI_CHANNEL || sender.id !== chrome.runtime.id) return false;
  (async () => {
    if (message.action === "cancel") {
      const url = chrome.runtime.getURL(OFFSCREEN_PATH);
      if (!chrome.runtime.getContexts || (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] })).length) {
        await chrome.runtime.sendMessage({ ...message, channel: OFFSCREEN_CHANNEL });
      }
      return { ok: true };
    }
    await ensureAiOffscreen();
    const result = await chrome.runtime.sendMessage({ ...message, channel: OFFSCREEN_CHANNEL });
    if (message.action === "start" && result?.ok) activeTasks.add(message.taskId);
    if (message.action === "end") {
      activeTasks.delete(message.taskId);
      if (activeTasks.size === 0) await chrome.offscreen.closeDocument();
    }
    return result;
  })().then(sendResponse, async (error) => {
    if (message.action === "end") activeTasks.delete(message.taskId);
    if ((message.action === "start" || message.action === "end") && activeTasks.size === 0) {
      try { await chrome.offscreen.closeDocument(); } catch { /* Ya se había cerrado. */ }
    }
    sendResponse({ ok: false, error: `${error?.name || "Error"}: ${error?.message || error}` });
  });
  return true;
});

