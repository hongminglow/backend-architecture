# Container Security Exceptions

The MVP uses official infrastructure images for Postgres, Redis, RabbitMQ, HAProxy, Prometheus, and Grafana.

Custom application containers (`api-service`, `outbox-publisher`, `worker-service`) run as the non-root `node` user and do not require additional Linux capabilities.

Official infrastructure images may require image-specific users, entrypoints, filesystem permissions, or startup behavior. For the MVP, these images are accepted as official upstream defaults. A later hardening phase can replace them with pinned, rebuilt, non-root images after the local architecture behavior is stable.
