# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Build and Development Commands

```bash
# Install dependencies (Bun is the package manager)
bun install

# Development — runs all apps via Turborepo
bun run dev

# Build all packages and apps
bun run build

# Run k6 load tests (requires API to be running)
bun run test

# Run k6 load tests with HTML report
bun run test:report
```

### App-specific commands

```bash
# NestJS API (Fastify) — runs on http://localhost:3001
cd apps/api && bun run dev

# k6 load tests (configurable via BASE_URL env var)
cd apps/k6 && bun run test
cd apps/k6 && K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=report.html k6 run load-test.js
```

## Code Quality Commands

```bash
# Type checking (runs tsc --noEmit via Turborepo)
bun run check-types

# Lint (oxlint)
bun run lint
bun run lint:fix

# Format (oxfmt)
bun run format
bun run format:fix
```

## Git Hooks

Pre-commit hooks are managed by [Lefthook](https://github.com/evilmartians/lefthook) and run automatically on `git commit`:

- **typecheck** — `bun run check-types` (full project)
- **lint** — `oxlint` on staged `*.{js,ts}` files
- **format** — `oxfmt --check` on staged `*.{js,ts,json}` files

All three run in parallel. To skip hooks in exceptional cases: `git commit --no-verify`.

## Architecture

Bun + Turborepo monorepo with a NestJS REST API and k6 load testing suite.

```
apps/
├── api/          # NestJS 11 REST API (Fastify platform, port 3001, in-memory storage)
└── k6/           # k6 load tests with custom metrics, thresholds, and HTML reporting

packages/
└── typescript-config/  # Shared tsconfig (base.json, nestjs.json with decorator support)
```

### API

- **Platform:** Fastify (not Express) via `@nestjs/platform-fastify`
- **Storage:** In-memory (no database)
- **Endpoints:** CRUD on `/users` (GET list, GET by id, POST, PUT, DELETE)
- **Module structure:** `src/app.module.ts` → `src/users/` (module, controller, service, DTOs)

### k6 Load Tests

- 3-stage load profile: ramp up (10s, 10 VUs) → steady state (20s) → ramp down (10s)
- Custom metrics: `user_list_duration` (Trend), `user_creation_success` (Rate)
- Per-endpoint thresholds via tagged `name` params
- Lifecycle: `setup()` creates test data → `default()` runs per VU → `teardown()` cleans up

## Prerequisites

- Bun 1.3.5+
- k6 CLI (for load testing)
