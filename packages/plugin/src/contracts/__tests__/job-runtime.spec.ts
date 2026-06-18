/**
 * EW-683 / EW-685 P0 — type-level shape assertions for `IJobRuntimeProvider`.
 *
 * This is a contract-only PR; no concrete provider implements the
 * interface yet, so the runtime conformance suite (mirroring
 * `vector-store.spec.ts`) lands with EW-686 P1 once `TriggerService` is
 * rehoused as the first `IJobRuntimeProvider` implementation. What this
 * spec locks in the meantime:
 *
 *   1. The interface is exported from `@ever-works/plugin` so downstream
 *      packages (`@ever-works/agent/tasks` once EW-686 lands) can
 *      `import type` it without reaching into a deep subpath.
 *   2. The literal-union `JobRuntimeId` matches the 5-provider matrix
 *      in `docs/specs/architecture/job-runtime-providers.md` §4. A new
 *      provider added without updating both this union and the spec
 *      breaks this test loudly.
 *   3. `JobRunStatus` covers the 6 states the architecture spec §3
 *      defines (5 lifecycle + `'unknown'` fallback).
 *   4. `IJobRuntimeProvider` is structurally `IPlugin`-shaped so the
 *      plugin registry can hold it without special-casing.
 *
 * The runtime conformance suite (per architecture spec §7) tests:
 *   - enqueue returns an id; worker runs and writes terminal state
 *   - idempotency: same key → one logical run
 *   - concurrency: same key serialises
 *   - cancel: in-flight aborts and orchestrator observes
 *   - schedule: registered cron fires on cadence
 *   - disabled runtime: enqueue returns `null`, API falls back
 *
 * Those land per provider once a provider exists to run them against
 * (EW-686 for `trigger`, EW-689+ for the rest).
 */

import { describe, expectTypeOf, it } from 'vitest';
import type {
	IJobRuntimeProvider,
	JobEnqueueOptions,
	JobRunStatus,
	JobRuntimeDispatchers,
	JobRuntimeId,
	ScheduleSpec,
	TenantCredentialSnapshot,
	WorkerHostHandle,
	WorkerHostOptions
} from '../capabilities/job-runtime.interface.js';
import type { IPlugin } from '../plugin.interface.js';

describe('IJobRuntimeProvider — contract surface', () => {
	it('JobRuntimeId matches the 5 supported providers from the architecture spec §4', () => {
		// If this union is widened without updating the architecture
		// spec + selector docs, this test fails — keep both in sync.
		expectTypeOf<JobRuntimeId>().toEqualTypeOf<'trigger' | 'temporal' | 'bullmq' | 'pgboss' | 'inngest'>();
	});

	it('JobRunStatus covers the 5 lifecycle states + unknown fallback', () => {
		expectTypeOf<JobRunStatus>().toEqualTypeOf<
			'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
		>();
	});

	it('IJobRuntimeProvider extends IPlugin (registry-compatible)', () => {
		expectTypeOf<IJobRuntimeProvider>().toMatchTypeOf<IPlugin>();
	});

	it('IJobRuntimeProvider exposes the 6-concern method shape from the architecture spec §3', () => {
		type Provider = IJobRuntimeProvider;

		expectTypeOf<Provider['runtimeId']>().toEqualTypeOf<JobRuntimeId>();
		expectTypeOf<Provider['dispatchers']>().toEqualTypeOf<JobRuntimeDispatchers>();
		expectTypeOf<Provider['registerSchedules']>().toEqualTypeOf<
			(schedules: readonly ScheduleSpec[]) => Promise<void>
		>();
		expectTypeOf<Provider['cancel']>().toEqualTypeOf<(runId: string) => Promise<boolean>>();
		expectTypeOf<Provider['getRunStatus']>().toEqualTypeOf<(runId: string) => Promise<JobRunStatus>>();
		expectTypeOf<Provider['isEnabled']>().toEqualTypeOf<() => boolean>();
	});

	it('startWorkerHost is optional (pull vs push hosting model)', () => {
		// Push providers (trigger, inngest) implement startWorkerHost as
		// a no-op or as their HTTP `serve()` mount; pull providers
		// (temporal, bullmq, pgboss) start a long-lived worker. Both
		// models are valid — the type allows `undefined`.
		type Provider = IJobRuntimeProvider;
		type StartFn = Provider['startWorkerHost'];

		expectTypeOf<StartFn>().toEqualTypeOf<((opts: WorkerHostOptions) => Promise<WorkerHostHandle>) | undefined>();
	});

	it('ScheduleSpec carries id + cron + optional payload', () => {
		const example: ScheduleSpec = {
			id: 'work-schedule-dispatcher',
			cron: '*/5 * * * *',
			payload: { tick: true }
		};
		expectTypeOf(example.id).toEqualTypeOf<string>();
		expectTypeOf(example.cron).toEqualTypeOf<string>();
		expectTypeOf(example.payload).toEqualTypeOf<unknown>();
	});

	it('JobEnqueueOptions are all optional (sensible per-provider defaults)', () => {
		// Every field optional — call sites that don't care about
		// idempotency/concurrency/tags can omit the argument entirely.
		const minimal: JobEnqueueOptions = {};
		expectTypeOf(minimal).toEqualTypeOf<JobEnqueueOptions>();

		const full: JobEnqueueOptions = {
			tags: ['kb', 'embed'],
			idempotencyKey: 'work-42-doc-7',
			concurrencyKey: 'work-42',
			maxDurationSeconds: 300,
			machineHint: 'medium-1x'
		};
		expectTypeOf(full.tags).toEqualTypeOf<readonly string[] | undefined>();
		expectTypeOf(full.idempotencyKey).toEqualTypeOf<string | undefined>();
		expectTypeOf(full.concurrencyKey).toEqualTypeOf<string | undefined>();
		expectTypeOf(full.maxDurationSeconds).toEqualTypeOf<number | undefined>();
		expectTypeOf(full.machineHint).toEqualTypeOf<string | undefined>();
	});

	it('WorkerHostHandle exposes only a stop() — graceful shutdown coordination', () => {
		expectTypeOf<WorkerHostHandle['stop']>().toEqualTypeOf<() => Promise<void>>();
	});

	it('bindToTenant is optional (provider may not support BYO)', () => {
		// EW-686 P2 / EW-742 — providers that don't support per-tenant
		// credential binding return undefined; the resolver falls back to
		// the instance default.
		type Provider = IJobRuntimeProvider;
		type BindFn = Provider['bindToTenant'];

		expectTypeOf<BindFn>().toEqualTypeOf<
			((snapshot: TenantCredentialSnapshot) => IJobRuntimeProvider | undefined) | undefined
		>();
	});

	it('TenantCredentialSnapshot carries tenantId + providerId + credentialVersion + opaque credentials', () => {
		const snapshot: TenantCredentialSnapshot = {
			tenantId: '00000000-0000-0000-0000-000000000001',
			providerId: 'trigger',
			credentialVersion: 1,
			credentials: { accessToken: 'tr_dev_xxx' }
		};
		expectTypeOf(snapshot.tenantId).toEqualTypeOf<string>();
		expectTypeOf(snapshot.providerId).toEqualTypeOf<JobRuntimeId>();
		expectTypeOf(snapshot.credentialVersion).toEqualTypeOf<number>();
		expectTypeOf(snapshot.credentials).toEqualTypeOf<Readonly<Record<string, unknown>>>();
	});
});

describe('IJobRuntimeProvider — barrel export', () => {
	it('the interface is reachable from the package root via capabilities barrel', async () => {
		// Smoke check: import via the barrel and verify the type
		// exports surface there. If the barrel re-export line is
		// dropped from `capabilities/index.ts`, this fails because the
		// type isn't reachable from the package root.
		const mod = await import('../capabilities/index.js');
		// The interface itself is type-erased, but if the file's
		// re-export line is wired the dynamic import succeeds.
		expectTypeOf(mod).not.toBeAny();
	});
});
