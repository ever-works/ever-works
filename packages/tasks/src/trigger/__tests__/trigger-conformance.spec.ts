/**
 * EW-742 P6 — Trigger.dev provider runs the shared
 * `IJobRuntimeProvider` conformance suite against itself.
 *
 * Mirrors the conformance specs the 4 non-Trigger plugin packages
 * ship under `packages/plugins/job-runtime-{bullmq,pgboss,temporal,
 * inngest}/src/__tests__/{provider}-conformance.spec.ts`. The shared
 * suite lives at `@ever-works/plugin/contracts-conformance` and
 * encodes the 11 contract invariants from
 * `docs/specs/architecture/job-runtime-providers.md` §7.
 *
 * The Trigger.dev provider is a NestJS-Injectable adapter wrapping
 * `TriggerService`. To exercise the contract surface in isolation we
 * inject a minimal stub `TriggerService` — same shape used by
 * `trigger-job-runtime.provider.spec.ts`.
 */

import { describe, vi } from 'vitest';
import { runJobRuntimeContractSuite } from '@ever-works/plugin/contracts-conformance';
import { TriggerJobRuntimeProvider } from '../trigger-job-runtime.provider';
import type { TriggerService } from '../trigger.service';

function buildStubService(): TriggerService {
    return {
        // IJobRuntimeProvider methods the adapter delegates to.
        // All return safe defaults — the conformance suite expects
        // cancel(unknownId)→false, getRunStatus(unknownId)→'unknown',
        // registerSchedules to no-op, isEnabled to return a boolean.
        isEnabled: vi.fn(() => true),
        cancel: vi.fn(async () => false),
        getRunStatus: vi.fn(async () => 'unknown' as const),
        registerSchedules: vi.fn(async () => undefined),
        startWorkerHost: vi.fn(async () => ({ stop: async () => undefined })),
        // `dispatchers` is a Record<string, unknown> on the real service —
        // the conformance suite probes property access (must not throw)
        // and treats undefined return values as valid.
        dispatchers: {} as Readonly<Record<string, unknown>>,
    } as unknown as TriggerService;
}

describe('TriggerJobRuntimeProvider — IJobRuntimeProvider conformance', () => {
    runJobRuntimeContractSuite(() => new TriggerJobRuntimeProvider(buildStubService()));
});
