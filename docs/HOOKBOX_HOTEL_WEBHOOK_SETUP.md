# Hotel authorization webhook retired

PR #32's inbound authorization architecture is superseded by per-device PIN validation. Its webhook and secret-rotation routes return HTTP 410 and are absent from the interface.

Use [PIN delivery and HTTP integration](PIN_DELIVERY.md) for hook configuration, outbound JSON, security, reliability and rollout instructions.
