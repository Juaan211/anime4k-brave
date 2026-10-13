import * as ort from "./vendor/ort.webgpu.min.mjs";

const CHANNEL = "anime4k-ai-offscreen";
const tasks = new Map();
const wasmBase = chrome.runtime.getURL("vendor/");
ort.env.wasm.proxy = false;
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = wasmBase;

function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function closeTask(taskId) {
  const task = tasks.get(taskId);
  if (!task) return;
  task.cancelled = true;
  if (task.runPromise) {
    try { await task.runPromise; } catch { /* El caller ya recibió el error. */ }
  }
  if (task.framePromise) {
    try { await task.framePromise; } catch { /* La solicitud de frame se canceló. */ }
  }
  if (task.session) {
    const session = task.session;
    task.session = null;
    try { await session.release(); } catch { /* La sesión pudo quedar inválida por pérdida del dispositivo. */ }
  }
  task.inputBuffer = null;
  tasks.delete(taskId);
}

async function openTask(message) {
  if (!navigator.gpu) throw new Error("WebGPU no está disponible en el documento de la extensión");
  const oldTask = tasks.get(message.taskId);
  if (oldTask) await closeTask(message.taskId);
  const task = { cancelled: false, session: null, runPromise: null, framePromise: null };
  tasks.set(message.taskId, task);
  const modelUrl = chrome.runtime.getURL("models/realesr-animevideov3.onnx");
  const response = await fetch(modelUrl, { cache: "no-store" });
  if (!response.ok) throw new Error("Falta el modelo models/realesr-animevideov3.onnx");
  const session = await ort.InferenceSession.create(modelUrl, { executionProviders: ["webgpu"] });
  if (task.cancelled) {
    await session.release();
    throw new Error("Mejora cancelada");
  }
  if (!session.inputNames.includes("input") || !session.outputNames.includes("output")) {
    await session.release();
    throw new Error(`Nombres ONNX inesperados; entrada: ${session.inputNames.join(", ")}; salida: ${session.outputNames.join(", ")}`);
  }
  // Los mosaicos live y pausados miden como máximo 288×288 (256 px + 16 px
  // de solapamiento por lado). Se reutiliza este plano NCHW entre inferencias.
  task.inputBuffer = new Float32Array(3 * 288 * 288);
  task.session = session;
  return { ok: true, input: session.inputNames[0], output: session.outputNames[0] };
}

async function runTile(message) {
  const task = tasks.get(message.taskId);
  if (!task?.session) throw new Error("La sesión IA no está inicializada");
  if (task.cancelled) throw new Error("Mejora cancelada");
  const imageBlob = await (await fetch(message.dataUrl)).blob();
  const bitmap = await createImageBitmap(imageBlob);
  const width = bitmap.width;
  const height = bitmap.height;
  if (width > 288 || height > 288) {
    bitmap.close();
    throw new Error(`Mosaico ONNX demasiado grande: ${width}×${height}; máximo 288×288`);
  }
  const inputCanvas = makeCanvas(width, height);
  const inputContext = inputCanvas.getContext("2d", { willReadFrequently: true });
  inputContext.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = inputContext.getImageData(0, 0, width, height).data;
  const plane = width * height;
  const nchw = task.inputBuffer.subarray(0, plane * 3);
  nchw.fill(0);
  for (let index = 0; index < plane; index++) {
    const source = index * 4;
    nchw[index] = rgba[source] / 255;
    nchw[plane + index] = rgba[source + 1] / 255;
    nchw[plane * 2 + index] = rgba[source + 2] / 255;
  }
  const tensor = new ort.Tensor("float32", nchw, [1, 3, height, width]);
  let output;
  try {
    const inference = task.session.run({ input: tensor });
    task.runPromise = inference;
    output = (await inference).output;
  } finally {
    task.runPromise = null;
    tensor.dispose?.();
  }
  if (task.cancelled) {
    output?.dispose?.();
    throw new Error("Mejora cancelada");
  }
  let nativeCanvas = null;
  let x2Canvas = null;
  try {
    const [, channels, outputHeight, outputWidth] = output.dims;
    if (channels !== 3 || outputWidth !== width * 4 || outputHeight !== height * 4) {
      throw new Error(`Forma de salida inesperada: ${output.dims.join("×")}`);
    }
    const rgbaOutput = new Uint8ClampedArray(outputWidth * outputHeight * 4);
    const outputPlane = outputWidth * outputHeight;
    for (let index = 0; index < outputPlane; index++) {
      const target = index * 4;
      rgbaOutput[target] = Math.max(0, Math.min(255, Math.round(output.data[index] * 255)));
      rgbaOutput[target + 1] = Math.max(0, Math.min(255, Math.round(output.data[outputPlane + index] * 255)));
      rgbaOutput[target + 2] = Math.max(0, Math.min(255, Math.round(output.data[outputPlane * 2 + index] * 255)));
      rgbaOutput[target + 3] = 255;
    }
    nativeCanvas = makeCanvas(outputWidth, outputHeight);
    const nativeContext = nativeCanvas.getContext("2d", { willReadFrequently: true });
    nativeContext.putImageData(new ImageData(rgbaOutput, outputWidth, outputHeight), 0, 0);
    const crop = message.crop;
    x2Canvas = makeCanvas(crop.width * 2, crop.height * 2);
    const x2Context = x2Canvas.getContext("2d");
    x2Context.imageSmoothingEnabled = true;
    x2Context.imageSmoothingQuality = "high";
    x2Context.drawImage(nativeCanvas, crop.x * 4, crop.y * 4, crop.width * 4, crop.height * 4,
      0, 0, crop.width * 2, crop.height * 2);
    return { ok: true, x: message.x, y: message.y, dataUrl: x2Canvas.toDataURL("image/png") };
  } finally {
    output.dispose?.();
    if (nativeCanvas) nativeCanvas.width = nativeCanvas.height = 0;
    if (x2Canvas) x2Canvas.width = x2Canvas.height = 0;
    inputCanvas.width = inputCanvas.height = 0;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.channel !== CHANNEL) return false;
  const taskId = message.taskId;
  if (message.action === "cancel") {
    const task = tasks.get(taskId);
    if (task) task.cancelled = true;
    sendResponse({ ok: true });
    return false;
  }
  const work = message.action === "start"
    ? openTask(message)
      : message.action === "tile"
      ? runTile(message)
        : message.action === "end"
        ? closeTask(taskId).then(() => ({ ok: true }))
        : Promise.reject(new Error("Acción IA desconocida"));
  work.then(sendResponse, async (error) => {
    if (message.action === "start" || message.action === "end") await closeTask(taskId);
    sendResponse({ ok: false, error: `${error?.name || "Error"}: ${error?.message || error}` });
  });
  return true;
});
