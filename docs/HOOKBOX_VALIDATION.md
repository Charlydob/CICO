# Validación — Hookbox / CICO, 18 octubre 2026

| Comprobación | Resultado |
|---|---|
| Tests nativos firmware | **56/56 correctos**, incluidos validación real del tema, límites/fuentes/recursos, política de slots, autorización, fallo y secuencia de 25 ganchos MOCK |
| CICO `npm test`, con PostgreSQL para Hookbox | **141 correctos, 0 fallos, 2 suites antiguas omitidas** en esta ejecución principal |
| Suite específica Hookbox | **7/7 correctos**, incluido PostgreSQL real, autenticación HTTP real, roles, origen, aislamiento, idempotencia, reclamaciones concurrentes y simulador de archivos |
| Migraciones | **19 migraciones aplicadas** desde una base PostgreSQL desechable vacía, incluida la nueva |
| Prisma | Esquema válido; comparación contra BD sin diferencias nuevas en tablas Hookbox |
| Frontend | TypeScript + Vite compilados correctamente; advertencia existente de bundle >500 KB |
| Navegador | Editor renderizado y revisado visualmente; cambios, borrador, publicación simulada, idiomas, teclado y carga/conversión del logo correctos |
| OpenAPI | Ambos contratos validados con Swagger Parser |
| Builds firmware | `crowpanel_checkin_mock`, `crowpanel_solenoid_bench`, `native` y `native_checkin_simulator`: correctas |
| Simulador nativo | 25 resultados consecutivos MOCK, sin concurrencia; termina COMPLETE con physicallyConfirmed=false |
| Imagen ESP32-S3 | Checksum y validation hash del binario correctos mediante esptool, sin conexión a hardware |
| Código | `git diff --check` limpio; no se ha publicado ni desplegado |

Los tests del navegador interceptan las respuestas para probar la interfaz. Los tests HTTP separados utilizan sesiones y tokens del sistema real con PostgreSQL de laboratorio. Las pruebas de configuración persistente en archivos son del simulador; las de slots prueban la misma política usada por firmware. **No certifican la escritura y recuperación de NVS/LittleFS en un CrowPanel físico.**

## Binarios preparados

| Artefacto | Bytes | Margen sobre slot OTA de 1.835.008 bytes |
|---|---:|---:|
| Hookbox-2.5.0-CHECKIN-MOCK.bin | 1.692.832 | 142.176 |
| Hookbox-2.4.13-SOLO-BANCO-A0.bin | 1.615.264 | 219.744 |
| Hookbox-simulador-MOCK-25.exe | 717.102 | No aplica |

SHA-256 en `SHA256SUMS.txt` y `binarios/manifest.json`. El binario de banco mantiene su capacidad física manual A0; **no se ha instalado ni ejecutado** y no habilita el nuevo check-in real de 25 ganchos. El simulador Windows se ha ejecutado en este ordenador con su runtime MinGW disponible; no es una aplicación gráfica ni se garantiza que funcione en otro PC sin sus dependencias de compilación.

## Fallos heredados reproducidos, fuera de la suite nueva

Se habilitaron también las dos suites antiguas de PostgreSQL de OTA/checkout. La ejecución ampliada mostró cuatro fallos contabilizados (incluido un test padre), con estas causas:

1. Checkout espera HTTP 410 para una habitación archivada; el servicio responde 404.
2. El test de aprovisionamiento compara permisos POSIX `0600`; en Windows obtiene `0666` (438 decimal frente a 384). El test falla antes de actualizar sus credenciales locales.
3. El siguiente subtest OTA usa las credenciales previas y obtiene 401: consecuencia del fallo anterior.

Se ejecutaron las mismas pruebas contra la copia original `6d75253`, sin los cambios nuevos de Hookbox, y se reprodujeron exactamente. No se han cambiado contratos ni seguridad de checkout/OTA para ocultar esos fallos. Los logs de ambas ejecuciones están en `validacion/`.

La comparación completa de migraciones/esquema muestra además diferencias antiguas de un índice de rooms, defaults de updated_at de push y el índice único de username. No hay diferencias de Hookbox después de ajustar su nueva migración. No se ha aplicado el SQL de diferencias sobre ninguna BD de usuario.

## Pendientes de validación física y externa

- No hay puertos serie detectados. No se ha leído flash/PSRAM del dispositivo ni identificado el binario instalado físicamente.
- No se ha probado la pantalla táctil, el consumo real de heap, LittleFS/NVS o cortes de alimentación en el panel.
- No se ha ejecutado una OTA real ni un rollback real de esta versión.
- La nueva cola física de 25 ganchos está bloqueada y requiere cerrar su integración con el corte dedicado y validar alimentación/cableado. Sólo existe la variante física previa de un gancho.
- No hay backend privado de Steinbock accesible ni API de autorización confirmada. Se entrega adaptador propuesto y mock; sin proveedor real configurado no se liberan llaves.
- No hay sensor de retirada confirmado. Nunca se declara entrega física.

Consultar `LEEME.md` para configuración, alcance exacto y procedimientos preparados. No hay autorización implícita de producción por el hecho de que una build compile.
