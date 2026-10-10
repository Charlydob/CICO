import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root=new URL("../../",import.meta.url);

test("device administration keeps RFID forms and histories collapsed until requested",async()=>{
  const [checkout,detail]=await Promise.all([
    readFile(new URL("src/modules/admin/CheckoutBoxDevicePanel.tsx",root),"utf8"),
    readFile(new URL("src/modules/admin/DeviceDetailPanel.tsx",root),"utf8"),
  ]);
  assert.match(checkout,/keyFormOpen&&<form/);
  assert.match(checkout,/<details className="rfid-entry"/);
  assert.match(checkout,/UID distintos detectados recientemente/);
  assert.match(checkout,/Historial cronológico de lecturas/);
  assert.match(checkout,/if\(saved\)\{setKeyFormOpen\(false\)/);
  assert.match(checkout,/\|\|\/\\d\/\.test\(room\)\?`Habitación/);
  assert.match(detail,/Ver historial de comandos/);
  assert.match(detail,/device\.hardwareModel==="ESP32_DEVKIT_CHECKOUT_V1"\?<CheckoutBoxDevicePanel/);
  assert.doesNotMatch(detail,/ota-modal/);
});

test("device administration defines compact iPhone layouts without desktop table overflow",async()=>{
  const css=await readFile(new URL("src/styles.css",root),"utf8");
  assert.match(css,/@media \(max-width:640px\)/);
  assert.match(css,/\.device-summary-grid[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css,/\.device-section-tabs[^}]*overflow-x:auto/);
  assert.match(css,/\.rfid-key-list article[^}]*display:grid/);
  assert.match(css,/\.vertical-slider[^}]*writing-mode:vertical-lr/);
  assert.match(css,/\.inline-checks input[^}]*min-height:16px/);
  assert.match(css,/\.platform-main \{\s*overflow-x: clip/);
});
