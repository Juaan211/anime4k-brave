# Modelo para Foto con IA

## Archivos

- Checkpoint oficial: `models/realesr-animevideov3.pth`.
- Modelo que genera el convertidor: `models/realesr-animevideov3.onnx`.
- El checkpoint descargado del release oficial pesa 2.504.012 bytes y su SHA-256 es `b8a8376811077954d82ca3fcf476f1ac3da3e8a68a4f4d71363008000a18b75d`.
- URL del release: <https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-animevideov3.pth>.

## Preparación en Windows

Desde PowerShell, en la carpeta raíz de la extensión, ejecutá:

```powershell
py -3.12 -m venv --clear .venv-tools
.\.venv-tools\Scripts\python.exe -m pip install --upgrade pip
.\.venv-tools\Scripts\python.exe -m pip install torch onnx
.\.venv-tools\Scripts\python.exe tools\convert_model.py models\realesr-animevideov3.pth models\realesr-animevideov3.onnx
```

El convertidor define localmente la arquitectura `SRVGGNetCompact` que usa este checkpoint. No requiere `realesrgan` ni `basicsr`. Las instalaciones se hacen dentro de `.venv-tools`, no en el Python global. El script exporta ONNX clásico (opset 17 y alto/ancho dinámicos), comprueba el grafo y compara su salida con PyTorch usando un tensor de prueba. Solo al pasar la comprobación escribe el ONNX final.

El checkpoint es **x4 nativo**. Para que el costo y el tamaño de salida sean menores, la función procesa cada mosaico a x4 en ONNX Runtime y reduce esa salida a x2 en el documento offscreen (`offscreen.js`), usando un canvas 2D con `imageSmoothingQuality = "high"`. No se agregan pesos ni una segunda red.

## Runtime local

ONNX Runtime Web 1.30.0 para WebGPU está empaquetado en `vendor/`; el manifest expone los módulos, WASM y modelo al documento de la extensión. La sesión se abre únicamente cuando el usuario solicita procesar un frame pausado para guardarlo como PNG. La imagen se procesa en mosaicos secuenciales con solapamiento; al cancelar o terminar, se libera la sesión. Si falta el ONNX, el panel informa que falta `models/realesr-animevideov3.onnx` y el comando exacto es:

```powershell
.\.venv-tools\Scripts\python.exe tools\convert_model.py models\realesr-animevideov3.pth models\realesr-animevideov3.onnx
```

La conversión se probó con PyTorch frente al ejecutor de referencia ONNX. La ejecución con el proveedor WebGPU, captura de video protegida por CORS, cancelación y presentación en Brave deben probarse en un navegador real; esta sesión no tuvo un Brave interactivo disponible.
