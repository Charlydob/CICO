import { fail, authorizedRooms } from "../../shared/hookbox/contract.mjs";
// URLs and secrets are operator configuration, never guest-supplied or visual design fields.
export function createCheckinProvider(
  config = process.env.HOOKBOX_PROVIDERS_JSON || "{}",
) {
  let providers;
  try { providers = JSON.parse(config); if(!providers || Array.isArray(providers) || typeof providers !== "object") throw Error(); }
  catch { return async () => fail("Invalid check-in provider configuration", 503); }
  return async (tenantId, action, body) => {
    const p = providers[tenantId];
    if (!p) fail("Check-in integration is not configured", 503);
    let url;
    try { url = new URL(p.url); } catch { fail("Invalid check-in provider URL",503); }
    if(url.username || url.password || typeof p.token !== "string" || p.token.length < 8) fail("Invalid check-in provider credentials",503);
    const mock = p.mock === true;
    if (
      url.protocol !== "https:" &&
      !(
        mock &&
        process.env.NODE_ENV !== "production" &&
        ["127.0.0.1", "localhost"].includes(url.hostname)
      )
    )
      fail("Provider must use HTTPS", 503);
    if (mock && process.env.NODE_ENV === "production")
      fail("MOCK is forbidden in production", 503);
    let response;
    try {
      response = await fetch(
        new URL(action, url.href.endsWith("/") ? url : new URL(url.href + "/")),
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(8000),
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${p.token}`,
          },
          body: JSON.stringify({ schemaVersion: 1, tenantId, ...body }),
        },
      );
    } catch {
      fail("Check-in provider unavailable", 503);
    }
    if (!response.ok) fail("Check-in verification failed", 403);
    const size = Number(response.headers.get("content-length"));
    if (size > 12288) fail("Provider response too large", 502);
    const reader = response.body.getReader();
    let total = 0,
      chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 12288) {
        await reader.cancel();
        fail("Provider response too large", 502);
      }
      chunks.push(value);
    }
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      fail("Invalid provider JSON", 502);
    }
    if (data.schemaVersion !== 1) fail("Unsupported provider schema", 502);
    if (action === "verify") authorizedRooms(data);
    return { ...data, mock };
  };
}

