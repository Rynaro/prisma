# infra/

Phase 4 scaffold placeholder. Operator-facing infrastructure config (OTel
collector config, Redis tuning, etc.) lives here. The MVP does not pin a
specific telemetry backend per ADR consequences and `docs/observability.md`;
operators supply their own collector via `OTEL_EXPORTER_OTLP_ENDPOINT`.

For local development, `docker-compose.yml` boots a Redis instance only. An
optional local OTel collector can be added here when needed.
