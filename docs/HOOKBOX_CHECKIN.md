# Hookbox Check-in y diseño multi-hotel — implementación local

## Estado de la entrega

Se ha implementado una base integrada y comprobada en software para CICO y CrowPanel. **No es una versión certificada para vender o instalar con 25 solenoides reales.** La build de check-in suministrada es MOCK; la variante física conservada sigue limitada al banco de un gancho. No se ha instalado firmware, desplegado CICO ni enviado comandos a dispositivos.

Código: dos copias de trabajo independientes, basadas en CICO `6d75253` y firmware `e50fd08`, en ramas `feature/hookbox-checkin-design`. Los repositorios originales, sus cambios pendientes y el OTA existente se conservan.

## Qué está implementado

- Sección por hotel **Hookbox → Dispositivos → Diseño de pantalla**, accesible al administrador del hotel y al administrador de plataforma con hotel seleccionado. Acceso también desde la barra móvil.
- Dos plantillas horizontales 800 × 480, cuatro idiomas, textos editables, colores, nombre, logo PNG/JPG, decoración acotada, QR HTTPS con tres tamaños y posición según plantilla. SVG y fondos a pantalla completa se rechazan expresamente.
- Conversión de imágenes a RGB565 little endian antes de publicar. Límites: logo 160 × 64, decoración 160 × 96, cada recurso ≤32 KiB y conjunto ≤64 KiB. No se descargan URLs arbitrarias de imágenes en el ESP32.
- Previsualización interactiva: inicio, selección ID/apellido, formulario, teclado con mayúsculas/acentos/símbolos, verificación, habitación y resultado. Usa geometría compartida, la misma fuente Montserrat y anchos extraídos de los glifos del firmware. El antialiasing del navegador y la codificación del QR pueden variar; no se afirma identidad de píxeles con un panel físico sin comprobarlo.
- Guardar/restaurar borrador con control de revisión, versiones publicadas inmutables, restauración de una versión como nueva publicación, y versión deseada/aplicada/rechazada por dispositivo.
- Canal visual autenticado independiente de OTA y de `desiredConfig`/`appliedConfig` del servo/RFID. Descarga JSON y recursos, comprueba tamaño/hash/esquema/fuentes/memoria, guarda dos slots locales, aplica en el hilo LVGL, confirma tras dos segundos de funcionamiento y conserva la versión previa. Si hay un reinicio antes de confirmar, vuelve al slot anterior y bloquea la versión que falló hasta una nueva publicación.
- UI LVGL nativa; HTTPS/JSON en tarea separada; credenciales existentes y CA del cliente OTA; ningún navegador embebido.
- Consulta de reserva sin autorización de entrega. Verificación separada exige `authorized`, `identityVerified` y `conditionsSatisfied`. El adaptador falla cerrado sin proveedor configurado.
- Operaciones con UUID, caducidad de dos minutos, tres intentos de verificación, aislamiento del hotel propietario y bloqueo de fila del dispositivo contra cambios concurrentes de propietario/credenciales.
- Reclamaciones persistentes por hotel/estancia/habitación antes de iniciar la liberación. Resultados ordenados, reintentos idempotentes de mensajes y bloqueo de resultados contradictorios. No se repiten pulsos tras incertidumbre o reinicio.
- Cola de 25 ganchos MOCK, de uno en uno, con pausa entre ganchos; diario NVS antes de iniciar y de cada pulso. Conserva el driver Adafruit y HookManager existente. Registros persistentes en DeviceEvent; activación eléctrica, simulación y entrega física se distinguen.
- Servidor de reservas simulado para el contrato propuesto y simulador de dispositivo de escritorio con configuración persistente. Ninguno pretende ser la API real de Steinbock.
- Tema piloto opcional con colores y logo obtenidos del portal público. No se impone a otros hoteles.

## Qué falta para cerrar el producto

1. **Backend real de check-in:** acceso a su código/API y acuerdo sobre identidad y condiciones de entrega. Se entregan dos OpenAPI: CICO implementado y adaptador propuesto. El portal público usa formularios; no se ha supuesto una API compatible ni automatizado la búsqueda de huéspedes reales.
2. **Control físico de 25 salidas:** confirmar placa, cableado, direcciones, alimentación y corriente; integrar y validar la cola nueva con el corte físico dedicado de múltiples ganchos. El corte dedicado existente sólo cubre el banco A0. La UI nueva rechaza liberaciones cuando se compila con hardware real. No hay una variante de check-in físico de 25 ganchos habilitada en esta entrega.
3. **Pruebas en CrowPanel:** confirmar modelo, flash/PSRAM y firmware instalado por lectura del dispositivo; probar táctil, heap real, brillo, imágenes, reinicios y cortes de alimentación durante cada fase de configuración. Las pruebas host verifican el validador real y la política de commits; el simulador comprueba archivos, pero no sustituye probar LittleFS/NVS en la placa.
4. **OTA física:** repetir instalación y rollback reales con esta build y confirmar que no interfiere con recursos visuales. Se mantienen código y particiones; compilación y pruebas de protocolo no certifican una actualización sobre un equipo real.
5. **Entrega física:** no hay sensor de retirada confirmado. Un éxito sólo significa activación eléctrica o MOCK; nunca se marca retirada física.
6. **Operación de recepción:** una operación incierta conserva sus reclamaciones. La reconciliación requiere revisar estado/eventos y resolver presencialmente; no se incluye un botón de reintento que pueda duplicar una entrega. Falta cerrar el procedimiento administrativo de rearme y recarga de llaves con el modelo físico final.
7. No se recibieron capturas adjuntas: se utilizó la web pública y la descripción. El logotipo cuadrado original se reduce al espacio disponible; puede sustituirse por una variante horizontal autorizada.

## Configuración de CICO para pruebas

Usar una copia y una base PostgreSQL desechable. No aplicar estas instrucciones a producción sin revisión y autorización.

```powershell
npm ci
$env:DATABASE_URL = 'postgresql://usuario:password@127.0.0.1:5432/hookbox_lab'
npx prisma generate
npx prisma migrate deploy
npm run build
```

La migración `20261018180000_hookbox_checkin` añade tablas de hoteles/diseños/recursos/operaciones/reclamaciones y cuatro campos `ui_*` a Device. No cambia las tablas ni versiones OTA y no sobrescribe el esquema del servo. Realizar copia de seguridad antes de una futura migración de producción. Para retirar la función, volver al código anterior manteniendo las tablas nuevas; no borrar reclamaciones de operaciones inciertas.

Configurar `APP_ORIGIN` con el origen del frontend, `OTA_PUBLIC_ORIGIN` con HTTPS y la confianza de proxy conforme al despliegue existente. Las rutas nuevas reutilizan la protección de transporte OTA. Para un laboratorio local exclusivamente: `NODE_ENV=test` y `OTA_DEV_ALLOW_HTTP=true`; no habilitar la excepción en producción.

El adaptador se define con una variable de entorno **del servidor**, sin secretos en el diseño:

```json
{
  "UUID_DEL_HOTEL": {
    "url": "https://proveedor-autorizado.example/adapter/",
    "token": "SECRETO_SOLO_EN_SERVIDOR",
    "mock": false
  }
}
```

Guardar ese JSON en `HOOKBOX_PROVIDERS_JSON`. Cada hotel tiene su propia URL/token. El adaptador recibe POST `/lookup` y `/verify`, con token del proveedor, `tenantId` y `operationId`. No configurar la página `guest-login.php` como URL de API: no implementa el contrato entregado.

Para MOCK local:

```powershell
$env:NODE_ENV='test'
$env:MOCK_HOTEL_ID='UUID_REAL_DEL_HOTEL_DE_PRUEBA'
$env:MOCK_PROVIDER_TOKEN='SECRETO_LOCAL_DE_PRUEBA'
node backend/hookbox/mockProvider.js --serve
```

En otra consola del backend, `HOOKBOX_PROVIDERS_JSON` debe apuntar para ese hotel a `http://127.0.0.1:4319/`, con el mismo token y `mock:true`. El mock escucha sólo en loopback y se prohíbe en producción. ID `MULTI` devuelve habitaciones 101/102 tras código `123456`; otros IDs válidos devuelven 101. Valores `ambiguous`, `insufficient` y `missing` prueban sus estados. Es exclusivamente una fixture.

Crear/asignar el dispositivo `CROWPANEL_7_V3` al hotel mediante administración existente. Usar su aprovisionamiento seguro existente, con `base_url`, `device_id` y token individual. No imprimir ni adjuntar tokens a informes.

Elegir el hotel en CICO, abrir Hookbox, configurar habitaciones como `101:1` y `102:25`, cargar el tema piloto o personalizarlo, guardar, revisar y publicar. Comprobar la versión aplicada por cada panel: publicar no significa que ya se haya aplicado.

## Firmware e instalación preparada

```powershell
pio test -e native
pio run -e native
pio run -e native_checkin_simulator
pio run -e crowpanel_checkin_mock
pio run -e crowpanel_solenoid_bench
```

La build nueva es `crowpanel_checkin_mock`, versión 2.5.0, build `20261018.checkin-design-mock`. El artefacto OTA es únicamente `firmware.bin`; no subir bootloader ni particiones como app. No se cambia la tabla de particiones existente de 4 MiB ni el límite de 1.835.008 bytes por app.

Una partición visual totalmente borrada se inicializa como LittleFS tras verificar todos sus bytes. Un contenido previo no reconocido **no se formatea automáticamente**: registrar `FILESYSTEM_NOT_INITIALIZED`, respaldar/identificar su contenido y preparar la partición en un procedimiento de instalación autorizado. No ejecutar `uploadfs` sobre recursos existentes sin respaldo.

No se ha ejecutado upload, flash, OTA de instalación ni ningún comando de solenoide. La build de banco conservada puede accionar A0 si se instala y se ordena una prueba: requiere tu confirmación antes de hacerlo. No sirve para el nuevo check-in de 25 llaves.

## Pruebas reproducibles

```powershell
npm test
$env:HOOKBOX_TEST_DATABASE_URL=$env:DATABASE_URL
npm run test:hookbox
npm run dev -- --port 4321
# En otra consola, con el navegador de Playwright instalado:
npx playwright install chromium
npm run test:hookbox:browser
```

Las pruebas PostgreSQL sólo deben apuntar a una base de laboratorio. Crean y eliminan sus propias fixtures. El test de navegador intercepta la API: valida el editor y sus interacciones, mientras las pruebas HTTP separadas usan autenticación y PostgreSQL reales. El simulador de archivos es de escritorio; no acciona hardware.

Simulador de sincronización opcional:

```powershell
$env:HOOKBOX_SIM_IDENTITY_FILE='RUTA_PRIVADA_A_IDENTIDAD_DE_PRUEBA.json'
$env:HOOKBOX_SIM_STATE_DIR='work/simulador-panel'
node backend/hookbox/deviceSimulator.mjs --run
```

La identidad contiene `base_url`, `device_id` y `token`. El CLI exige HTTPS. La excepción loopback sólo se activa explícitamente desde las pruebas.

## Contratos y ejemplo del proceso

Consultar `docs/hookbox-openapi.json` y `docs/hookbox-provider-openapi.json` dentro del código CICO. Todas las rutas de dispositivo requieren `Authorization: Bearer <token>` y `X-Device-Id: <device_id>`. Los ejemplos omiten credenciales.

```http
POST /api/device/v1/hookbox/lookup
{"schemaVersion":1,"operationId":"638e4194-8b43-4fc4-b9bd-68c8963127a0","method":"id","value":"ABC-123","language":"de"}

{"schemaVersion":1,"operationId":"638e4194-8b43-4fc4-b9bd-68c8963127a0","expiresAt":"2026-10-18T18:02:00.000Z","status":"CHALLENGE","challenge":"verification_code","results":[],"mock":true}
```

```http
POST /api/device/v1/hookbox/verify
{"schemaVersion":1,"operationId":"638e4194-8b43-4fc4-b9bd-68c8963127a0","proof":"123456"}

{"schemaVersion":1,"operationId":"638e4194-8b43-4fc4-b9bd-68c8963127a0","expiresAt":"2026-10-18T18:02:00.000Z","status":"AUTHORIZED","rooms":[{"room":"101","hook":1},{"room":"102","hook":25}],"results":[],"mock":true}
```

Después: `release/start` con el mismo `operationId`; por cada índice, `release/result` con `result:"MOCK_ACTIVATION"`, `mock:true` y `physicallyConfirmed:false`; finalmente `complete`. No interpretar `AUTHORIZED` como permiso para saltarse `release/start`. Tras incertidumbre, consultar `operations/{id}` y acudir a recepción; no repetir el pulso. Un `409` puede indicar una reclamación previa o un resultado contradictorio. `410` indica sesión caducada. Un proveedor sin configurar devuelve `503` y no crea ninguna reclamación.

## Seguridad y límites operativos

Las protecciones eléctricas siguen siendo código/configuración del controlador, sin campos en el tema que puedan modificarlas. Las reclamaciones impiden duplicar una estancia/habitación incluso si el dispositivo se reinicia o la sesión caduca. El proveedor debe utilizar un `reservationId` único por estancia y estable frente a reintentos, y comprobar fechas, identidad y condiciones reales de entrega.

Los recursos y diseños se conservan para permitir versiones históricas; hay que definir cuotas y retención operativa antes de escalar a muchos hoteles. Las reclamaciones inciertas nunca se eliminan por caducidad. El prototipo limita el historial retornado a las 100 publicaciones más recientes; el resto continúa en la base. El QR admite URL HTTPS; no HTML, JavaScript ni motor de composición libre. Se dispone de una única familia tipográfica soportada: Montserrat Latin en tamaños compilados.

## Simulador nativo compilado

El target `native_checkin_simulator` usa CheckinSequence y HookManager reales sobre MockHookDriver. Ejecutar `.pio/build/native_checkin_simulator/program.exe --all-25` para recorrer los 25 ganchos secuencialmente. Imprime una línea JSON por gancho y termina con COMPLETE; `physicallyConfirmed` siempre es false. También acepta una línea JSON por stdin con operationId, identityVerified, conditionsSatisfied y rooms [{room,hook}]. No conecta al backend; para el protocolo HTTPS y persistencia de diseños se usa el simulador Node descrito arriba.
