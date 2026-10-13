# Avisos de terceros

## Anime4K-WebGPU

- Paquete: `anime4k-webgpu` versión 1.0.0
- Proyecto: https://github.com/Anime4KWebBoost/Anime4K-WebGPU
- Licencia: MIT
- Bundle distribuido en `vendor/anime4k-webgpu-1.0.0.js`
- Texto de licencia incluido en `vendor/ANIME4K-WEBGPU-LICENSE-MIT.txt`

El paquete implementa Anime4K en WebGPU y documenta los presets Mode A, B, C, AA, BB y CA. Se eligió Mode A para esta primera integración enfocada en anime de 1080p. La licencia MIT requiere conservar el aviso de copyright y permiso en las copias o partes sustanciales; por eso se incluye el archivo de licencia del paquete.

## Real-ESRGAN (modelo opcional)

- Proyecto y autores: Xintao Wang y colaboradores, https://github.com/xinntao/Real-ESRGAN
- Modelo: `realesr-animevideov3`; se incluyen el checkpoint oficial `models/realesr-animevideov3.pth` y el modelo convertido `models/realesr-animevideov3.onnx`.
- Licencia del proyecto: BSD-3-Clause, https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE
- La conversión/uso del checkpoint queda sujeta a los términos del proyecto. Conservar el copyright, las condiciones y el descargo de responsabilidad BSD-3-Clause junto con cualquier distribución que incluya el modelo convertido.

## ONNX Runtime Web (runtime opcional)

- Proyecto: https://github.com/microsoft/onnxruntime
- Paquete empaquetado: `onnxruntime-web` 1.30.0 (`vendor/ort.webgpu.min.mjs`, `vendor/ort-wasm-simd-threaded.asyncify.mjs` y `vendor/ort-wasm-simd-threaded.asyncify.wasm`); paquete descargado del registry oficial npm con integridad SHA-512 verificada.
- Licencia: MIT, https://github.com/microsoft/onnxruntime/blob/main/LICENSE
- Aviso de licencia de la versión incluido en `vendor/ONNXRUNTIME-WEB-LICENSE-MIT.txt`.
