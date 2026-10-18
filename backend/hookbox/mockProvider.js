// LOCAL integration fixture only. It implements our proposed adapter contract, not a Steinbock API.
import { createServer } from "node:http";
import { readHookboxJson } from "./routes.js";
export function mockProvider({ tenantId, token }) {
  return createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${token}`)
        throw Error("Unauthorized");
      const b = await readHookboxJson(req);
      if (b.tenantId !== tenantId || b.schemaVersion !== 1)
        throw Error("Wrong hotel/schema");
      let data;
      if (req.url === "/lookup") {
        const value = String(b.value).toLowerCase();
        data = {
          schemaVersion: 1,
          status:
            value === "ambiguous"
              ? "AMBIGUOUS"
              : value === "missing"
                ? "NOT_FOUND"
                : value === "insufficient"
                  ? "INSUFFICIENT"
                  : "CHALLENGE",
          challengeId: b.value === "MULTI" ? "fixture-multi" : "fixture-single",
        };
      } else if (req.url === "/verify" && b.proof === "123456")
        data = {
          schemaVersion: 1,
          authorized: true,
          identityVerified: true,
          conditionsSatisfied: true,
          reservationId: b.challengeId,
          rooms: b.challengeId === "fixture-multi" ? ["101", "102"] : ["101"],
        };
      else throw Error("Denied");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(403, { "content-type": "application/json" });
      res.end('{"error":"Denied"}');
    }
  });
}
if (process.argv.includes("--serve")) {
  if (process.env.NODE_ENV === "production")
    throw Error("MOCK forbidden in production");
  const tenantId = process.env.MOCK_HOTEL_ID,
    token = process.env.MOCK_PROVIDER_TOKEN;
  if (!tenantId || !token)
    throw Error("Set MOCK_HOTEL_ID and MOCK_PROVIDER_TOKEN");
  mockProvider({ tenantId, token }).listen(4319, "127.0.0.1", () =>
    console.log("MOCK check-in listening on 127.0.0.1:4319"),
  );
}
