# Configuración de la integración HOOKBOX ↔ Hotel (borrador)

Esta rama incorpora una pantalla de configuración por dispositivo en **Admin → Devices / Firmware → dispositivo CrowPanel → Conexión con hotel**, y en el detalle HOOKBOX del hotel.

## Configurar sin programar

1. Escribir la **URL HTTPS** que facilite el hotel, por ejemplo \`https://checkin.gasthaus-steinbock.ch/checkinguest.php\`. Es **un ejemplo, no se ha comprobado su existencia**.
2. Elegir formato de fecha y nombre de cada campo JSON.
3. Elegir de dónde sale cada valor: habitación, momento de check-in, estancia, solicitud, apellido, código de reserva o texto fijo.
4. Comprobar la vista previa, que utiliza únicamente datos ficticios.
5. Guardar. Esta versión **almacena la configuración**: **NO ejecuta POST salientes reales** hasta que Urs confirme cómo debe contestar su API. El estado «habilitar configuración» tampoco hace que se envíen peticiones automáticamente.

Ejemplo inicialmente propuesto (NO confirmado por el hotel):

\`\`\`json
{
  "key": "109",
  "check-in at": "28.10.2026 14:28",
  "request_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
}
\`\`\`

## Webhook entrante (hotel → CICO)

Endpoint propuesto, creado en código pero **aún sin URL pública comprobada**:

\`POST /api/integrations/hookbox/devices/{device-uuid}/webhook\`

Cabeceras:

- \`Content-Type: application/json\`
- \`X-Cico-Webhook-Secret: <secreto aleatorio del panel de administración>\`

El botón **Generar secreto** crea una credencial de 32 bytes aleatorios (representada en hexadecimal) y la muestra una sola vez al administrador. CICO almacena solamente su hash.

Propuesta de JSON entrante (NO confirmado por Urs):

\`\`\`json
{
  "action": "release",
  "request_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "stay_unit_id": "ABC123",
  "room": "109"
}
\`\`\`

\`request_id\` **no es un event_id generado por el hotel**. Es el \`operationId\` que CICO ya utiliza; Urs tendría que devolverlo para vincular la respuesta a la solicitud activa. Los datos definitivos se acordarán con Urs.

El servidor valida credencial y payload, comprueba que **existe una operación CICO todavía vigente** para ese dispositivo y que la habitación tiene un gancho publicado. Entonces autoriza la operación para que el CrowPanel continúe por el flujo habitual, que sigue exigiendo \`release/start\` y control de duplicados. **El webhook no acciona el solenoide por sí mismo.**

La prueba integral no debe realizarse con una habitación real sin autorización, y el receptor no es operativo públicamente hasta que se despliegue y pruebe HTTPS. Ningún firmware ni cableado Adafruit se modifica en esta rama.

## Pendiente de confirmación del hotel

- URL final y formato de campos del POST.
- Tipo de autenticación que exige el endpoint del hotel.
- Respuestas de identificación, necesidad de depósito y posibles coincidencias múltiples.
- JSON real de autorización (nombres de campos), reintentos y correlación de solicitudes.
- Momento exacto en que el hotel considera autorizada la llave.
