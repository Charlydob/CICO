export async function handlePaymentsRoute({
  request,
  pathname,
  parsedUrl,
  body,
  session,
  service,
}) {
  if (
    pathname === "/api/tenant/payments/stripe/callback" &&
    request.method === "GET"
  )
    return {
      status: 302,
      payload: {},
      headers: {
        Location: await service.callback(
          session,
          Object.fromEntries(parsedUrl.searchParams),
        ),
      },
    };
  if (pathname !== "/api/tenant/payments") return;
  if (request.method === "GET")
    return { status: 200, payload: await service.status(session) };
  if (request.method === "POST" && body.action === "connect")
    return { status: 200, payload: await service.start(session) };
  if (request.method === "POST" && body.action === "disconnect")
    return { status: 200, payload: await service.disconnect(session) };
  throw Object.assign(Error("Payment action is not available."), {
    statusCode: 400,
  });
}
