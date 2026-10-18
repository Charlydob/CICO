# Hookbox + CICO: software integrado

## Uso

En CICO, seleccionar el hotel y abrir **Hookbox → Diseño de pantalla**. El selector permite editar el diseño general del hotel o una pantalla concreta. Una pantalla sin publicación propia sigue el diseño general. «Usar diseño general del hotel» elimina su excepción; conserva el historial. Cambiar de hotel reinicia el editor y las consultas permanecen restringidas al hotel autorizado.

Modificar textos, idiomas, colores, plantilla, QR e imágenes cambia inmediatamente el lienzo de 800 × 480. Las pantallas de inicio, identificación/teclado, búsqueda, verificación, habitación autorizada, entrega, final y error comparten geometría y métricas Montserrat con LVGL. La simulación interactiva permite recorrer el flujo; nunca acciona un dispositivo. La búsqueda y entrega de la preview tienen transiciones locales, y los tiempos de reposo/retorno siguen el tema.

Guardar borrador utiliza una revisión para detectar ediciones concurrentes. Publicar crea una versión inmutable con recursos y mapa de habitaciones. Restaurar carga una versión y su mapa para revisión y nueva publicación. Cada dispositivo informa versión deseada, aplicada, checksum y rechazo. Una publicación no se declara instalada hasta recibir ACK.

El diagnóstico muestra las últimas 50 peticiones/respuestas JSON reales del dispositivo, su ruta, fecha y estado HTTP. Tokens, apellidos, pruebas de identidad, reservas y habitaciones se ocultan **antes** de persistir la traza. Los permisos de hotel también se aplican a esas consultas.

## Backend y autorización

Backend Node con PostgreSQL/Prisma: endpoints reales, autenticación de dispositivo, sesión y rol de administrador del hotel, HTTPS, comprobación de Origin en escrituras, límites JSON, transacciones, bloqueo por hotel y dispositivo, operaciones caducables y reclamaciones persistentes por estancia/habitación.

Consultar un apellido o ID devuelve un desafío o un error; nunca autoriza una salida. La verificación exige `authorized:true`, `identityVerified:true`, `conditionsSatisfied:true`, una estancia estable y habitaciones válidas. La publicación fija qué gancho corresponde a cada habitación. Antes del primer pulso, `release/start` crea reclamaciones duraderas. Resultados y finalización admiten reenvíos idempotentes; ni un reinicio ni la caducidad permiten repetir una llave ya reclamada. La incertidumbre detiene la secuencia y exige revisión de recepción.

Contratos exactos: `hookbox-openapi.json` (implementado) y `hookbox-provider-openapi.json` (contrato requerido al adaptador externo). `JSON-INTERCAMBIOS-REALES.json` en la entrega contiene intercambios capturados en pruebas HTTP reales con PostgreSQL y núcleo C++ compilado; las salidas eléctricas de esa prueba están simuladas y figuran como tales.

## Steinbock y datos externos pendientes

La página pública `https://checkin.gasthaus-steinbock.ch/guest-login.php?lang=de` ofrece un formulario web. No demuestra que exista una API JSON compatible; no se han enviado datos de huéspedes, sorteado autenticación ni inventado endpoints de Steinbock.

El adaptador configurable está implementado y probado contra un servidor de contrato local. Configurar **en el backend** `HOOKBOX_PROVIDERS_JSON`, indexado por UUID del hotel:

```json
{"UUID_DEL_HOTEL":{"url":"https://adaptador-autorizado.example/","token":"SECRETO_EN_SERVIDOR","mock":false}}
```

El adaptador debe recibir POST `lookup` y `verify` relativos a esa URL, con Bearer y esquema 1. Es nuestro contrato requerido, no una afirmación sobre URLs del hotel. Faltan del operador externo: URL autorizada, autenticación/credenciales, formato real de respuesta, mecanismo de verificación de identidad y condiciones, y un identificador estable y único de estancia. Si su API difiere, el adaptador externo traduce a este contrato. Sin integración configurada se devuelve 503 y no se liberan llaves. La simulación HTTP sólo admite loopback fuera de producción.

## Firmware físico definitivo

Target **crowpanel_checkin_real**, versión **2.6.0**, build **20261018.checkin-real-25**. CrowPanel Elecrow DIS08070H 7 pulgadas V3, ESP32-S3, flash 4 MiB, PSRAM 8 MiB OPI, RGB 800 × 480. Cuatro drivers Adafruit 6318/MCP23017 en 0x20–0x23; ganchos 1–25 corresponden a A0–A7 de las tres primeras placas y A0 de la cuarta. I2C SDA19/SCL20 compartido con táctil, protegido por mutex. No conectar una placa en una dirección ya ocupada.

El código físico está implementado y compilado. Verifica ACK y lectura de latch de la salida. Una tarea independiente de LVGL/HTTP corta el pulso a 250 ms, con límite lógico de 500 ms y separación mínima de 750 ms. No se permiten dos salidas simultáneas. Fallos de conexión, ON/OFF incierto o emergencia apagan y bloquean nuevos pulsos; OFF fallido se sigue reintentando. Un bus averiado o un MOSFET cortocircuitado no puede garantizarse eléctricamente mediante software: requiere protección de alimentación y validación física.

La versión real bloquea entregas y pruebas de la antigua demostración. Sólo la máquina de estados autenticada puede liberar. OTA/reinicio remoto se difieren durante una entrega y bloquean nuevas activaciones antes de instalar. El diario NVS se escribe antes de actuar; después de un reinicio no se repite un pulso incierto. Un resultado `ELECTRICAL_ACTIVATION` confirma orden/latch, nunca retirada física: `physicallyConfirmed:false`.

Temas independientes de OTA: HTTPS, checksum, límites de recursos, A/B en LittleFS, confirmación diferida y recuperación al tema anterior. No se reformatea contenido desconocido; una partición completamente borrada sí puede inicializarse. Límites reales: logo 160 × 64, decoración 160 × 96, RGB565, 32 KiB por recurso / 64 KiB total. SVG, vídeos y fondos fotográficos de pantalla completa no están soportados. El navegador y LVGL pueden diferir en antialiasing/QR; queda la inspección final en la pantalla física.

## OTA preparada, sin ejecutar sobre el dispositivo

Se conserva la tabla de 4 MiB: dos slots de aplicación de **1.835.008 bytes**, sin cambio de direcciones. CICO recibe `firmware.bin`, valida cabecera ESP32-S3, tamaño y SHA-256, permite borrador/publicación y asignación explícita. Descargar, verificar SHA y tamaño, escribir al slot inactivo, comprobar salud al arranque y rollback conservan el flujo existente. Nunca subir bootloader, particiones o imagen USB combinada como aplicación OTA.

La consulta de producción del 18/10/2026 mostró **Hookbox Lab**, modelo CROWPANEL_7_V3, versión **2.4.13**, build **20261007.ota-health-recovery-bench**, último contacto **10/10/2026 14:14 UTC**. El código correspondiente incorpora el cliente CICO OTA y la misma tabla; por tanto, ese build soporta la nueva app por diseño. La telemetría está desactualizada y no aporta una lectura actual de particiones: no se puede certificar que ese sea aún el firmware/tabla instalado. No se concluye que sea necesaria una instalación USB. Al reconectar, comprobar versión/build y tamaños de ambos slots en diagnóstico; USB sólo si la placa real carece de cliente compatible o tabla adecuada. No se ha actualizado, reiniciado ni accionado ningún dispositivo.

## Pruebas reproducibles

```powershell
# Firmware
pio test -e native
pio run -e crowpanel_checkin_real -e crowpanel_checkin_mock -e crowpanel_solenoid_bench -e native_checkin_simulator
# CICO: usar exclusivamente una PostgreSQL de laboratorio migrada
npm ci
npx prisma migrate deploy
$env:HOOKBOX_TEST_DATABASE_URL=$env:DATABASE_URL
$env:OTA_POSTGRES_TEST_DATABASE_URL=$env:DATABASE_URL
$env:CHECKOUT_POSTGRES_TEST_DATABASE_URL=$env:DATABASE_URL
$env:HOOKBOX_NATIVE_EXECUTABLE='RUTA_ABSOLUTA_AL_PROGRAM_NATIVE'
npm test
npm run build
npm run dev -- --port 4321
npm run test:hookbox:browser
```

El test nativo HTTP ejecuta el núcleo C++ compilado (CheckinSequence, HookManager y PulseSafety) contra rutas autenticadas y PostgreSQL, con proveedor y salidas físicas simulados. No emula la pila TLS/FreeRTOS/LittleFS del chip; éstos se compilan para el ESP32 y sus políticas se prueban en host. Las pruebas cubren 1/25 habitaciones, secuencia, autorización, ambigüedad, duplicados, persistencia, aislamiento, publicación/ACK, caída de conexión, integridad y rollback de protocolo. La certificación eléctrica y el OTA con cortes de alimentación requieren el equipo físico.

## Producción y recuperación

La migración añade tablas/columnas; conserva las rutas de servo/RFID y OTA. El despliegue comprueba tests, compilación y esquema; respalda PostgreSQL y los volúmenes antes de recrear servicios. El SHA anterior queda registrado para recuperación. No elimina datos ni envía comandos al panel. Los resultados del despliegue, commits, binarios y hashes se registran en el informe final de la entrega.
