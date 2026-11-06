# Checkout Box: webhook por cada lectura RFID

## Comportamiento

Cuando `Settings → Checkout Box · Hotel API` tiene el webhook activado:

1. El ESP32 transmite un evento `RFID_READ` por cada lectura que no haya filtrado su antirrepetición local.
2. CICO comprueba que el dispositivo está asignado al hotel y que la llave es **activa, autorizada y tiene una habitación/identificador configurado** en el catálogo RFID del dispositivo.
3. CICO registra la lectura y **crea un envío propio en la outbox**, aunque Zico no tenga esa habitación registrada, no exista check-in o el checkout anterior ya esté registrado.
4. El trabajador de outbox envía el `POST` con el JSON configurado (por defecto `Key` y `Checkout at`), autenticación personalizada y **Idempotency-Key** estable por lectura; reintenta fallos HTTP.
5. En este modo, el servidor externo es la autoridad de checkout: no se crea un checkout interno de Zico ni se alteran sus ciclos de ocupación. Se evita que el estado interno bloquee o duplique el envío.

Las lecturas sin autorización, sin hotel asignado o sin identificador de habitación **no envían** un checkout al hotel.

Cuando el webhook está desactivado, el sistema conserva su comportamiento local de registros de checkout y notificaciones.

## Configuración de Bären

- Endpoint: `https://checkin.baerenkiental.ch/checkout?token=...` (token confidencial)
- Cabecera de autorización: `Authorization` / `Bearer ...` (mismo token si lo exige el servidor PHP)
- Plantilla JSON: `{"Key":"{{key}}","Checkout at":"{{checkout_at}}"}`
- La zona horaria: `Europe/Zurich`
- El identificador se obtiene del campo **Habitación** asociado al UID en los ajustes RFID del dispositivo. Se elimina el prefijo "Habitación " si existe.

## Límites y comprobación

- La antirrepetición de firmware evita eventos `RFID_READ` para el mismo UID dentro del período configurado (por defecto 1,5 s). **No se hace una supresión de webhook adicional en CICO**: dos eventos recibidos crean dos entregas, incluso cuando el historial local los marca como repetidos.
- CICO almacena un ID de entrega por lectura, pero el firmware actual no adjunta un identificador persistente a cada evento `RFID_READ`. Una retransmisión causada por pérdida de la respuesta del servidor puede volver a registrarse; el receptor debe tratar los checkouts repetidos de forma idempotente.
- Un reintento de red de **la misma entrega** reutiliza `Idempotency-Key`. No se envía POST desde `Preview JSON` ni desde `Test DNS + TLS`.
- En **Device → Keys and controls → Llaves RFID**, buscar `WEBHOOK_QUEUED`; después, en el hotel, **Settings → Latest deliveries**, revisar `SUCCEEDED` y HTTP 2xx. `PENDING` / `RETRY` / `FAILED` indican que debe revisarse la conexión o la respuesta del hotel.
- El cambio requiere ejecutar la migración PostgreSQL `20261106144000_rfid_per_read_checkout_webhook` y desplegar el backend. No exige flashear un firmware nuevo.
- Probar el primer POST con una habitación de pruebas autorizada en el hotel: un POST de verdad puede ejecutar un checkout real, y la API del hotel puede ignorar el ID de idempotencia.
