# Trigger.dev Integration

This document explains how long-running directory generation is delegated to Trigger.dev while keeping all database writes inside the API service. It covers the runtime flow, the code that glues the two runtimes together, required environment configuration, and the release automation that deploys our Trigger.dev project.

## Runtime Architecture Overview

1. **API request enters `DirectoryGenerationService`.** When a user kicks off a generation via the API (`packages/agent/src/services/directory-generation.service.ts`), the service calls `dispatchGenerationTask()`.
2. **Optional Trigger.dev dispatch.** `TriggerService` (`packages/agent/src/trigger/trigger.service.ts`) checks `config.trigger.shouldUseTrigger()`. If the feature flag is enabled and credentials are present, it calls `tasks.trigger()` for the `directory-generation` task. Otherwise it falls back to the in-process `processGeneration()` path.
3. **Trigger task fetches execution context.** The task definition (`packages/agent/src/tasks/trigger/directory-generation.task.ts`) boots a Nest application using `TriggerWorkerModule`, fetches the directory + user context through the internal API, and runs the orchestrator.
4. **Worker performs generation locally.** `TriggerGenerationOrchestrator` (`packages/agent/src/trigger/trigger-generation.orchestrator.ts`) drives `DataGeneratorService`, `MarkdownGeneratorService`, and `WebsiteGeneratorService` inside the worker, updating state via the remote directory operations gateway instead of hitting the database directly.
5. **Database writes happen through the API.** `TriggerInternalApiClient` forwards updates back to the API, which exposes a set of signed endpoints in `TriggerInternalController` (`apps/api/src/trigger/trigger-internal.controller.ts`). That controller uses the standard `DirectoryRepository` to persist state, keeping all DB access on the API host.

The diagram below summarizes the happy path:

```
Client → API (DirectoryGenerationService) → TriggerService ──▶ Trigger.dev task
                                         ▲          │
                                         │          ▼
                               fallback generation   Trigger worker (Nest)
                                         │          │
                                         ▼          ▼
                                      Database ◀── Internal API (signed)
```

## Key Code Components

### Trigger configuration

- **`packages/agent/trigger.config.ts`** defines the Trigger.dev project, retry profile, and build customizations (including the TypeScript decorator metadata extension required by Nest/TypeORM).
- The config only scans `./src/tasks/trigger`, so any new task must live under that directory to be bundled automatically.

### Trigger worker runtime

- **`TriggerWorkerModule` (`packages/agent/src/trigger/trigger-worker.module.ts`)** wires together:
    - `TriggerItemsGeneratorModule` and `TriggerAiModule` (a trimmed Nest module exposing only the services the worker needs).
    - `TriggerInternalApiClient` and `RemoteDirectoryOperationsService`, which adapt the `DirectoryOperations` interface to HTTP calls back into the API.
    - The existing generator services (`DataGeneratorService`, `MarkdownGeneratorService`, `WebsiteGeneratorService`).

- **`directory-generation.task.ts`** creates a Nest application context per run, fetches the latest directory + user snapshot using `TriggerInternalApiClient.fetchDirectoryContext()`, and then calls `TriggerGenerationOrchestrator.run()`.

- **`TriggerGenerationOrchestrator`** mirrors the in-process `DirectoryGenerationService.processGeneration()` logic, but replaces direct repository calls with `DirectoryOperations` methods that the remote service implements. That lets us reuse the same generator services without letting the worker touch TypeORM directly.

### API ↔ worker bridge

- **`DirectoryOperations` interface (`packages/agent/src/directory-operations/directory-operations.interface.ts`)** abstracts mutating operations on the `directories` table. There is a database-backed implementation (`DatabaseDirectoryOperationsService`) used inside the API and CLI, and a remote implementation (`RemoteDirectoryOperationsService`) used inside the worker.

- **`TriggerInternalController` (`apps/api/src/trigger/trigger-internal.controller.ts`)** provides two signed routes:
    - `GET /internal/trigger/directories/:id/context` returns a serialized directory plus its owner (including OAuth tokens for Git access).
    - `POST /internal/trigger/directories/:id/commands` accepts typed commands derived from `DirectoryCommandPayloads` and applies them using the database-backed `DirectoryOperations` implementation.

- **Security**: every request from the worker must supply the shared secret via the `x-trigger-secret` header. The controller checks it against `config.trigger.getInternalSecret()` before serving data or accepting mutations.

### Agent service integration

- `DirectoryGenerationService.dispatchGenerationTask()` builds a `DirectoryGenerationPayload` and calls `TriggerService.dispatchDirectoryGeneration()`. When dispatching succeeds, the method returns immediately and lets Trigger.dev complete the work asynchronously. If dispatch fails (feature disabled or Trigger.dev unavailable) it logs a warning and reverts to `processGeneration()` so users are not blocked.

## Environment Variables

| Variable                   | Description                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `TRIGGER_ENABLED`          | Feature flag checked by `config.trigger.shouldUseTrigger()`. Set to `true` to enable Trigger.dev dispatches.      |
| `TRIGGER_SECRET_KEY`       | Trigger.dev secret key used by the worker to call the Trigger API. Required when `TRIGGER_ENABLED=true`.          |
| `TRIGGER_API_URL`          | Optional override of the Trigger.dev API base URL (defaults to the hosted service).                               |
| `TRIGGER_INTERNAL_API_URL` | Base URL the worker can reach for the API instance (`http(s)://host[:port]/internal/trigger`). No trailing slash. |
| `TRIGGER_INTERNAL_SECRET`  | Shared secret for the internal controller. Set the same value in the API environment and the worker environment.  |
| `TRIGGER_MACHINE`          | Optional machine preset (e.g. `standard-2x`, `large-1x`). Leave unset to use Trigger.dev's default dev preset.    |

**Where to configure:**

- `apps/api/.env.example` and `apps/cli/.env.example` list the variables and should be used as references for local setup.
- Production values belong in your deployment environment (e.g., platform secrets store). The worker needs `TRIGGER_SECRET_KEY`, `TRIGGER_API_URL` (if customized), and `TRIGGER_INTERNAL_*`. The API only needs the `TRIGGER_INTERNAL_*` pair plus `TRIGGER_ENABLED` if you want background dispatches by default.

## Local Development

1. Export the required environment variables (see above). For local testing you can point `TRIGGER_INTERNAL_API_URL` to `http://localhost:3100/internal/trigger` and reuse a shared secret between the Nest API and the Trigger worker.
2. Start the API (`pnpm --filter ever-works-api dev` or the equivalent command you typically use).
3. Run the Trigger worker in watch mode via the root script: `pnpm dev:trigger`. That delegates to Turbo and the `@trigger.dev/sdk` watch mode in `packages/agent`.
4. Trigger a generation through the API (e.g., `/api/directories/:id/generate`). Watch the Trigger.dev dashboard to ensure the task run appears. Tail API logs to confirm that command callbacks are updating directory state.

If you want to bypass Trigger.dev during development, either set `TRIGGER_ENABLED=false` or leave `TRIGGER_SECRET_KEY` unset. The agent service will fall back to the legacy in-process generation path.

## Creating New Trigger Tasks

1. Place the task definition under `packages/agent/src/tasks/trigger/` so it is included by `trigger.config.ts`.
2. Decide whether the task needs access to the database. If it does, expose the required operations through `DirectoryOperations` (or another abstraction) and implement them both locally (database-backed) and remotely (webhook-backed).
3. Register any additional providers in `TriggerWorkerModule`. Keep the worker lean—only import the modules the task actually needs.
4. Update API controllers or webhooks if new commands are required. Use `DirectoryCommandPayloads` to keep the request shape synchronized.
5. Add scripts/tests if necessary and run `pnpm --filter @packages/agent build` to verify bundling.

## Deployment Pipeline

- **Workflow:** `.github/workflows/release-trigger-prod.yml` runs after the “CI” workflow completes on `main` or `develop`. It checks out the repo, installs dependencies, and executes `npx trigger.dev@latest deploy` inside `packages/agent`.
- **Secrets:** The workflow expects `TRIGGER_ACCESS_TOKEN` to be present in the repository secrets. This token is distinct from the runtime `TRIGGER_SECRET_KEY` and is only used for deployments.
- **Manual deploys:** You can also run `pnpm deploy:trigger` locally, which delegates to the same Turbo+Trigger CLI pipeline used by the workflow.

## Monitoring & Troubleshooting

- Use the Trigger.dev dashboard to inspect task runs, logs, retries, and failures.
- API logs show inbound webhook calls in `TriggerInternalController`. Failures there usually mean the worker secret is misconfigured or the payload shape drifted.
- If a task is dispatched but never starts, double-check the project ID in `trigger.config.ts` and the `TRIGGER_SECRET_KEY` supplied to the worker.
- If the worker succeeds but the directory state remains unchanged, ensure the internal API base URL is reachable from the worker environment and that the controller is returning HTTP 200 for command requests.
- Review the **History** tab in the dashboard (Directories → Detail → History) to confirm each run produces metrics and to compare local vs. Trigger.dev executions.

Keeping this separation (Trigger.dev for long-running compute, API for persistence) lets us scale the heavy work off the API without relaxing our database access rules. When extending the system, continue funnelling all stateful operations through the internal controller and use strongly-typed payloads to guard against malformed requests.
