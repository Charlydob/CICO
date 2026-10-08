BEGIN;

ALTER TABLE "devices"
  ADD COLUMN "servo_diagnostic_state" TEXT,
  ADD COLUMN "servo_diagnostic_remaining" INTEGER;

ALTER TABLE "device_commands" DROP CONSTRAINT "device_commands_type";
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_type" CHECK ("type" IN (
  'OPEN_TRAP','CLOSE_TRAP','CYCLE_TRAP','SET_SERVO_CONFIG',
  'SERVO_DIAG_START','SERVO_DIAG_STOP','SERVO_RAW_PWM_TEST','SERVO_RAW_PIN25_TEST',
  'CHECK_RFID','RESTART','CHECK_UPDATE'
));

COMMIT;
