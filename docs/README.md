# Documentation Index

This folder holds the contributor-facing guides. Keep the root `README.md` short; put operational details here.

| Guide                                                                   | Purpose                                                              |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [Development](development.md)                                           | Local setup, stack lifecycle, API walkthrough, and seed data         |
| [Database](database.md)                                                 | DB access, migrations, schema changes, and data inspection           |
| [Testing](testing.md)                                                   | Static checks, integration tests, stress tests, and manual API calls |
| [Operations](operations.md)                                             | Logs, metrics, graceful shutdown, DLQ, and troubleshooting           |
| [Deployment](deployment.md)                                             | Local Compose deployment, scaling, and later AWS mapping             |
| [Versioning](versioning.md)                                             | Version updates, dependency updates, and release checklist           |
| [Architecture Decisions](architecture/decisions.md)                     | ADRs, options considered, pros/cons, and verification                |
| [Architecture Request Flow](architecture/request-flow.md)               | Request and event flow through the system                            |
| [Architecture Decision Deck](decks/backend-architecture-decisions.pptx) | Editable PowerPoint explaining the ADRs                              |

## Documentation Rules

- Update the guide that owns the workflow. Do not grow the root README for detailed procedures.
- When changing services or ports, update [Stack Summary](../STACK.md), [Deployment](deployment.md), and any affected commands.
- When changing schema, update [Database](database.md), add a migration under `infra/postgres/migrations/`, and update test expectations.
- When changing architecture decisions, update [Architecture Decisions](architecture/decisions.md) and the deck in `docs/decks/` if the decision story changes.
