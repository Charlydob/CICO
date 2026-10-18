import { defaultTheme } from "./shared/hookbox/contract.mjs";
import { writeFileSync } from "node:fs";
const manifest = JSON.stringify({
  schemaVersion: 1,
  tenantId: "test",
  version: "test",
  theme: defaultTheme(),
  assets: [],
});
writeFileSync(
  "../HOOKBOX-FIRMWARE/test/test_remote_theme/Fixture.h",
  '#pragma once\nconstexpr const char* kThemeFixture=R"FIXTURE(' +
    manifest +
    ')FIXTURE";\n',
);
