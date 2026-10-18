export function redactProtocol(value, key = "") {
  if (
    /token|secret|password|credential|authorization|cookie|proof|^value$|surname|guest|name|email|phone|document|reservationId|challengeId|^room$/i.test(
      key,
    )
  )
    return "[REDACTED]";
  if (key === "manifest" && typeof value === "string") {
    try {
      return JSON.stringify(redactProtocol(JSON.parse(value)));
    } catch {
      return "[REDACTED]";
    }
  }
  if (Array.isArray(value)) return value.map((v) => redactProtocol(v));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactProtocol(v, k)]),
    );
  return value;
}
