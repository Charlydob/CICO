# Validación final de software — 18/10/2026

- CICO: 157 pruebas satisfactorias, 0 fallos y 0 omitidas, con PostgreSQL aislado. Incluye rutas HTTP/autenticación, publicación por hotel/dispositivo, ACK, bloqueo concurrente, persistencia, fallos, OTA y rollback de protocolo.
- Integración nativa: backend real + PostgreSQL + proveedor de contrato HTTP + ejecutable C++ compilado. Casos de 1 y 25 ganchos, pruebas de autorización, resultados y duplicados. Salidas físicas simuladas.
- Firmware host: 62 casos, todos correctos. Corte de pulso independiente, desconexión/OTA, fallo ON/OFF ambiguo, reintento OFF, exclusión y cooldown, más políticas de tema/OTA/reinicio.
- Cuatro targets compilados correctamente: crowpanel_checkin_real, crowpanel_checkin_mock, crowpanel_solenoid_bench, native_checkin_simulator.
- Editor Playwright: edición, cambio inmediato del lienzo, estados, teclado, idioma, selección de dispositivo, guardar y publicar. Se realizará también comprobación autenticada sobre el despliegue; resultado en el informe de entrega.
- Frontend de producción y TypeScript compilados; 20 migraciones aplicadas en PostgreSQL de laboratorio. El bundle mantiene un aviso de tamaño, sin errores.

## Binario físico

Versión 2.6.0 / 20261018.checkin-real-25. Tamaño 1697312 bytes; slot 1.835.008; margen 137696 bytes.

SHA-256: `6ca73ae02a7858fa5b4e567be76f0ffd919d92fa557e4c3d44ba65b9e5ae852d`.

`firmware.bin` es el único archivo para subir como aplicación OTA. Bootloader y particiones son evidencia de compilación; no subirlos como aplicación. No se cambia la tabla de particiones. No se ha enviado OTA ni activado solenoides.

## Límites de lo comprobado

No se ha probado eléctricamente en un CrowPanel conectado. La pila ESP32/TLS, FreeRTOS, NVS/LittleFS y los drivers físicos se han compilado; sus políticas se prueban en host, lo que no sustituye una prueba de alimentación/rollback real. El proveedor de Steinbock no está conectado: faltan su API/autenticación y contrato real. Sin proveedor verificado no se permite entregar.

La última telemetría disponible del CrowPanel registra 2.4.13 bench (10/10/2026). Su código admite CICO OTA y la tabla compilada es compatible. La fecha y falta de lectura actual de particiones impiden certificar el estado físico actual o decidir que USB sea necesario.
