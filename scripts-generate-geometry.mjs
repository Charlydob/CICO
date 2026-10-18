import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const firmware = process.argv[2];
if (!firmware)
  throw Error(
    "Usage: node scripts/generate-hookbox-geometry.mjs <firmware-directory>",
  );
const geometry = JSON.parse(
  readFileSync(
    new URL("./shared/hookbox/geometry.json", import.meta.url),
    "utf8",
  ),
);
let cpp =
  "#pragma once\n// Generated from CICO shared/hookbox/geometry.json. Do not hand-edit.\nnamespace hookbox::crowpanel::geometry {\n";
for (const [k, v] of Object.entries(geometry)) {
  if (typeof v === "number") cpp += `constexpr int ${k}=${v};\n`;
  else if (typeof v[0] === "number")
    cpp += `constexpr int ${k === "delete" ? "deleteKey" : k}[]={${v.join(",")}};\n`;
  else
    cpp += `constexpr const char* ${k}[]={${v.map((x) => JSON.stringify(x)).join(",")}};\n`;
}
cpp += "}\n";
writeFileSync(
  path.join(firmware, "lib/CrowPanelApp/src/crowpanel/HookboxGeometry.h"),
  cpp,
);
