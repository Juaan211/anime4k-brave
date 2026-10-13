# Anime4K hecho por juanito0211 — WebGPU con modos y calidad

## Descargar e instalar

En GitHub, elegí **Code → Download ZIP** y extraelo en una carpeta. En Brave, abrí `brave://extensions`, activá **Modo desarrollador**, elegí **Cargar desempaquetada** y seleccioná la carpeta extraída que contiene `manifest.json`. La extensión todavía no está publicada en Chrome Web Store ni tiene un paquete en Releases; este método permite probarla desde el repositorio.

Por seguridad, cada hostname empieza desactivado: no aparece la interfaz ni se procesa ningún video. Presioná **F1** una vez para activar Anime4K en ese sitio. En sitios activados aparece un panel translúcido dentro del reproductor, con Shadow DOM para aislarlo del CSS del sitio. Se muestra al mover el mouse y se oculta tras 3 segundos sin actividad. La **X** activa el modo manual persistente; el panel solo vuelve con F1 o con el indicador casi transparente de la esquina. El botón **Desactivar en este sitio** borra la activación y retira el canvas, restaura el video y detiene el procesamiento. El panel intenta colocarse en una esquina libre de controles y subtítulos. Al entrar en pantalla completa, se mueve dentro del elemento que ocupa la pantalla.

La extensión detecta el `<video>`, importa cada frame con `requestVideoFrameCallback` e `importExternalTexture`, lo procesa con los presets de `anime4k-webgpu` y lo dibuja en un canvas superpuesto. Al cambiar modo, calidad o escala, reconstruye el preset si hace falta y vuelve a dibujar el frame actual; eso también funciona si el video está pausado.

## Atajos

- **A**: activar/desactivar el canvas. No cambia el modo.
- **1 / 2 / 3**: elegir Modo A / B / C.
- **Q**: alternar Fast y HQ.
- **S**: recorrer 1× → 1,5× → 2× → Auto. Auto elige 2× hasta 480p, 1,5× entre 481p y 900p, y 1× desde 901p; se recalcula si cambia la resolución.
- **F2**: abrir o plegar la sección de estadísticas. En el modo automático, el panel se oculta tras 3 segundos sin actividad y vuelve al mover el mouse o cambiar una opción.
- **F1**: en un sitio nuevo, activa Anime4K; en un sitio activado, alterna mostrar/ocultar el panel. En sitios activados también cancela la ayuda del navegador.
- **E**: intenta mejorar el frame actual con IA (se puede personalizar desde Atajos).

Los atajos no actúan mientras escribís en un campo de texto. El cartel muestra modo, calidad, escala, resoluciones, tiempo por frame y presupuesto estimado según la cadencia observada. Se pone rojo si el procesamiento supera el presupuesto. Si la carga se mantiene alta, puede bajar automáticamente un nivel la escala fuera de pantalla completa; la calidad no cambia sin que la elijas. No cambia el modo A/B/C automáticamente.

Los botones hacen lo mismo que los atajos. `chrome.storage.local` usa el hostname exacto (`location.hostname`) como clave del sitio para guardar activación, filtro, ocultado manual con X/F1, modo, calidad y escala. Los modos, calidad y escala globales anteriores se usan como valores iniciales para los sitios que todavía no tienen una preferencia propia. Al desactivar, se borra la clave del sitio. Los cambios automáticos por bajo rendimiento no se guardan como preferencia.

## Generación de fotogramas experimental

La sección plegable **Generación de fotogramas** está apagada por defecto y guarda su estado y modo en la configuración del hostname. **G** la alterna (también se puede personalizar desde Atajos). **Mezcla** promedia dos frames; **Movimiento** busca un desplazamiento en bloques de 8×8 usando luminancia y una búsqueda limitada, y vuelve a mezcla cuando la coincidencia local es dudosa. Frames casi idénticos se repiten sin crear un intermedio; un cambio grande entre frames se trata como corte y se muestra el frame real. El frame sintético entra al pipeline antes de Anime4K y los filtros.

La extensión usa `requestVideoFrameCallback` para capturar cada frame y registra el callback siguiente antes de iniciar el trabajo GPU. La salida usa una cola ordenada con los tiempos `expectedDisplayTime` (y `mediaTime` como respaldo): el frame real se agenda con un retraso de un intervalo y el intermedio de cada pareja se agenda exactamente a mitad de ese intervalo, también con el retraso. Esa latencia de un frame permite conocer los dos dibujos antes de calcular el intermedio y mantener el orden real → intermedio → real. La cola no elimina frames por ir tarde; pausa, seek, corte de escena y cambio de pestaña limpian el historial/cola.

El contador HUD se alterna con `F3` (personalizable en el popup), aparece oculto al cargar, puede arrastrarse y recuerda su posición por dominio. `Salida` cuenta pasadas del canvas observadas con `requestAnimationFrame`; el callback ocurre antes de la composición física y por eso es una medición aproximada, no una confirmación de lo que el monitor mostró. La temporización ordenada apunta a duplicar 24 fps cerca de 48 fps en una pantalla de 60 Hz o más, pero el resultado real depende del tiempo de Anime4K, WebGPU y el compositor.

Esto intenta duplicar la cadencia visual, pero no es interpolación óptica de alta calidad: movimientos complejos, oclusiones y compresión pueden producir fantasmas. En el modo Movimiento la búsqueda puede ser costosa. A 48 fps o más la opción queda deshabilitada. Si el promedio de Generación de fotogramas queda por encima del presupuesto durante varios segundos, el panel sugiere bajar calidad o escala y no cambia esos ajustes solo. Al apagar Generación de fotogramas se destruyen las texturas de historial; al pausar, buscar, cambiar de video, ocultar la pestaña o entrar/salir de pantalla completa se reinicia el historial. CORS puede impedir la lectura reducida que detecta duplicados y cortes; en ese caso se omite el intermedio afectado. La función no elude DRM.

## Modos y variantes de la librería

Revisé los exports reales del bundle instalado (`anime4k-webgpu` 1.0.0). Tiene seis presets completos, y los seis están disponibles en la extensión:

| Preset | Disponible en la extensión como | En pocas palabras |
|---|---|---|
| `ModeA` | A + Fast | Modo A normal. Buen comienzo para muchos videos 1080p y anime borroso o comprimido. |
| `ModeAA` | A + HQ | Variante secundaria A+A: más reconstrucción, más lenta y puede exagerar el enfoque. |
| `ModeB` | B + Fast | Modo B normal. Suele encajar mejor con 720p o fuentes con menos desenfoque. |
| `ModeBB` | B + HQ | Variante secundaria B+B: más procesamiento y más lenta. |
| `ModeC` | C + Fast | Modo C normal. Puede convenir para fuentes reducidas, con ruido, o limpias. |
| `ModeCA` | C + HQ | Variante secundaria C+A: añade reconstrucción al modo C; también es más lenta. |



La guía oficial explica que A, B y C tratan degradaciones diferentes y recomienda comparar visualmente. También advierte que las variantes secundarias son más lentas y están pensadas para escalados de 2× o más. Por eso Fast/HQ son nombres simples de los dos niveles en esta extensión; los nombres oficiales de los presets son los de la primera columna. [Guía avanzada oficial de Anime4K](https://github.com/bloc97/Anime4K/blob/master/md/GLSL_Instructions_Advanced.md). La extensión ofrece los seis presets completos que exporta esta versión y una composición Máxima propia basada en etapas disponibles. El bundle también exporta bloques de shader y utilidades de bajo nivel, pero no son modos completos adicionales para elegir.

**Elección rápida:** empezá por A para 1080p; probá B si A se ve demasiado fuerte o el video es 720p; probá C en fuentes muy reducidas o ruidosas. Cambiá a HQ si querés comparar una variante más trabajada y tu GPU tiene margen. A 1080p de entrada, Fast suele ser la opción más prudente: la guía advierte que A+A puede sobreenfocar si no se escala al menos 2×. [Documentación de `ModeAA` en el port WebGPU](https://github.com/Anime4KWebBoost/Anime4K-WebGPU/blob/main/src/pipelines/presets/ModeAA/index.ts).

## Diseño del panel

El panel usa cristal oscuro, el logo transparente `assets/logo-perro.png` y mascotas decorativas locales de `assets/poodle-sprites.png`. Los adornos no reciben clics ni ejecutan animaciones continuas. En reproductores pequeños se ocultan los adornos y se compacta el panel, conservando el scroll interno. La sección de foto IA se despliega para mostrar sus acciones; al usar su atajo, se abre para mostrar el progreso.

## Archivos principales

- `manifest.json`: configura Manifest V3, inyecta scripts en los frames y carga el bundle local.
- `content.js`: detecta videos, maneja atajos, procesa Anime4K y filtros con WebGPU, e incluye las funciones experimentales documentadas en este archivo.
- `tools/convert_model.py`: convierte el checkpoint oficial `.pth` a ONNX sin inventar pesos.
- `models/README.md`: instrucciones de conversión y uso de los modelos incluidos.
- `popup.html`, `popup.css` y `popup.js`: muestran el hostname, activan o desactivan Anime4K y permiten elegir Fast, HQ o Máxima para ese dominio.
- `icons/icon16.png`, `icons/icon32.png`, `icons/icon48.png` y `icons/icon128.png`: íconos de la extensión y del popup.\n- `assets/logo-perro.png`: logo con fondo transparente para el panel y el popup.
- `vendor/anime4k-webgpu-1.0.0.js`: bundle de la librería.
- `vendor/ANIME4K-WEBGPU-LICENSE-MIT.txt`: licencia MIT incluida con el bundle.
- `THIRD_PARTY_NOTICES.md`: aviso de terceros.

## Cómo probar en Brave (Windows)

1. Abrí `brave://extensions`.
2. En la extensión, pulsá **Recargar**.
3. Abrí el popup desde el ícono de Anime4K: debe mostrar el dominio de la pestaña y su estado; probá activarlo y desactivarlo. También podés activar un sitio con **F1**.
4. Abrí JKAnime: al principio no debe aparecer panel ni canvas. Presioná **F1** para activar el dominio y esperá a que aparezca Anime4K.
5. Mové el mouse sobre el reproductor: aparece el panel; dejalo quieto 3 segundos y se oculta.
6. Pausá el video y usa los botones o **1/2/3**, **Q** y **S**: el frame debe actualizarse sin reanudarlo.
7. Abrí/cerrá **Estadísticas** con **F2**. Verificá resolución y milisegundos por frame.
8. Cambiá un modo y recargá la página: los botones deben recordar la selección.
9. Probá **A**, seek, volumen y pantalla completa como antes. Cerrá el panel con **×** y mové el mouse: se vuelve a mostrar. Recargá el sitio: debe seguir activado. Elegí **Desactivar en este sitio**: debe desaparecer el panel y el canvas; al recargar, el sitio empieza desactivado.
10. En un video de menos de 48 fps, abrí **Generación de fotogramas**, activala y alterná **Mezcla/Movimiento**. Probá pausa, seek, cambio de pestaña y pantalla completa; revisá en Estadísticas los milisegundos y los contadores. En un video de 48 fps o más, el interruptor debe indicar que está deshabilitado.

Los milisegundos son el tiempo observado desde la preparación del frame hasta que termina el trabajo enviado a la cola GPU. El presupuesto se estima a partir de la cadencia reciente del video; cerca de 24 fps debería rondar 41,7 ms. La cola GPU ocupada también puede influir.

Si WebGPU falla, la extensión oculta el canvas y restaura el video original. No intenta eludir CORS ni DRM; esos bloqueos pueden impedir la lectura del video.

chrome.storage necesita el permiso storage en el manifiesto y está disponible en los content scripts. Usamos su área local para conservar los ajustes en este navegador. [Documentación oficial de chrome.storage](https://developer.chrome.com/docs/extensions/reference/api/storage).

## Foto de alta calidad con IA

En **Imagen**, pausá el video en un frame nítido y tocá **Procesar foto con IA** (atajo E). La extensión divide la imagen en mosaicos con solapamiento, muestra el progreso y deja cancelar el trabajo. Al terminar, podés alternar con **Ver Anime4K** y descargar el resultado con **Guardar PNG**. El modelo Real-ESRGAN animevideov3 genera x4 internamente y la extensión lo reduce a x2 para guardar un archivo más manejable.

**Ejemplo para sacar una captura cuidada:** pausá en el instante más enfocado; para comparar, poné Anime4K en **Máxima** y elegí **2×** o **Auto**; activá **Detalle** y ajustá **Nitidez** con moderación si querés que esos filtros también afecten la vista IA; procesá la foto, compará con Anime4K y guardá el PNG. La calidad y escala de Anime4K solo afectan la vista Anime4K; el modelo de foto produce x2 fijo. Detalle y Nitidez sí se aplican a la salida IA cuando están activados.

La sesión ONNX se inicia solo cuando pedís procesar una imagen pausada; no procesa video en vivo ni reserva la sesión durante la reproducción. Si el navegador bloquea la lectura del video por CORS/DRM o falta el modelo/WebGPU, el panel muestra un aviso. La inferencia WebGPU y la presentación final deben confirmarse en Brave real.
