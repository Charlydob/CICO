> Informe histórico de la primera entrega. El estado actual y las instrucciones están en HOOKBOX_CHECKIN.md (CICO) / CHECKIN_DESIGN.md (firmware) y en VALIDACION-FINAL.md.

# Auditoría previa — 18 octubre 2026

No se ha conectado al hardware, desplegado, enviado comandos ni energizado salidas.

## Bases seleccionadas

- CICO: copia limpia local de `2026-10-11/cico-hotelapp-correcci-n-del-flujo`, commit `6d75253`, coincidente con GitHub main consultado hoy. La copia antigua `Documents/Codex/CICO` tiene modificaciones OTA pendientes; se conserva íntegra.
- Firmware: `2026-10-06/files-pasted-by-the-user-trabaja/work/HOOKBOX-FIRMWARE`, commit `e50fd08`, versión 2.4.13, 7 octubre. Más reciente que GitHub main `37ce1a7` (2.3.0) y feature/cico-ota-client `4e88e72` (2.4.2). Árbol limpio. No hay evidencia suficiente para certificar aquí qué binario está instalado actualmente en el panel.
- Copias de trabajo de esta entrega: `../work/CICO` y `../work/HOOKBOX-FIRMWARE`. Se preservan todos los originales. También se localizaron firmware 1.4.x, copia CrowPanel 3 octubre, CHECKOUTBOX y backup main.cpp del escritorio. No sustituyen la base posterior.

## Hardware determinado por código, pendiente de lectura física

`CrowPanelBoard.cpp`, JSON de placa y tabla de particiones: DIS08070H V3.0, ESP32-S3 N4R8, RGB 800×480, flash 4 MiB, PSRAM OPI 8 MiB. No se deriva del README antiguo. RGB D0–D15: 15,7,6,5,4,9,46,3,8,16,1,14,21,47,48,45. DE41 VSYNC40 HSYNC39 PCLK0; backlight2. I²C SDA19/SCL20 400 kHz; PCA9557 y touch existente. SD MOSI11/MISO13/CLK12/CS10.

Particiones: NVS 0x9000/0x5000; otadata 0xE000/0x2000; ota_0 0x10000/0x1C0000; ota_1 0x1D0000/0x1C0000; spiffs 0x390000/0x60000; coredump 0x3F0000/0x10000. Cada app 1.835.008 bytes; almacenamiento visual comparte 384 KiB. No cambiar tabla para una OTA convencional.

## Integraciones que se conservan

- LVGL 8.3.6 + LovyanGFX 1.1.12, fonts Montserrat Latin 14/20/28/40, reset touch V3, buffers DMA internos y heap LVGL PSRAM.
- CrowPanelWifi: selección, password y provisioning. CicoOtaClient: identidad en Preferences, bearer + X-Device-Id, HTTPS con raíces CA, hora NTP, heartbeat, comandos, validación tamaño/hash/slot, estado NVS y confirmación de salud. CrowPanelOta mantiene rollback A/B. Su validación física actual no se ha repetido.
- Adafruit6318HookDriver usa Adafruit MCP23X17 2.3.2: 4 placas I²C 0x20–0x23, 8 salidas/placa, 25 ganchos mapeados (slot−1)/8 y (slot−1)%8. HookManager rechaza concurrencia y distingue COMMAND_SUCCEEDED de físicamente confirmado. El target físico existente es banco: una placa, gancho1/A0, 250 ms, corte500 ms y cooldown750 ms en tarea dedicada. Target normal MOCK. No se habilitarán 25 salidas físicas sin validar cableado, potencia y pruebas físicas.
- CICO usa HTTP Node, React, Prisma/PostgreSQL, tenants y autenticación existente. Device tenantId es el hotel propietario. desiredConfig/appliedConfig y checksum/version actuales están dedicados a configuración de servo/RFID de Checkoutbox. No reutilizar ese esquema para UI ni sobrescribir sus ACK. OTA usa advisory locks de PostgreSQL por dispositivo y autorización propia.
- Los proveedores de reservas existentes normalizan datos operativos; no constituyen comprobación de identidad ni autorización para llaves. El demo check-in tampoco autoriza hardware. Se requiere adaptador explícito que falle cerrado sin backend configurado.

## Referencia externa

La herramienta web no pudo abrir inicialmente el portal, pero una descarga HTTPS de sólo lectura sí devolvió HTTP 200. Se revisaron HTML y CSS públicos: fondo #080706, panel #2f2922, acento #c4a574, texto #ebe4d7, fuente Georgia. Se obtuvo el logotipo público img/logo-dark.png. El tema piloto adapta estos colores al layout horizontal y usa Montserrat disponible en firmware. Sólo se recibió el adjunto de texto, sin capturas. El portal usa formularios POST; no existe evidencia de una API JSON compatible. Se entregan contrato propuesto y mock independiente de producción, sin enviar datos de huéspedes ni formularios reales.

Inventario final de puertos: Win32_SerialPort vacío y PlatformIO device list devolvió `[]`. No hay CrowPanel serie accesible en esta sesión. No se ha abierto ni reiniciado ningún puerto.
