import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * EW-742 P6 T32/T37 — REAL-INFRA integration spec for the Inngest plugin.
 *
 * Mocks-free: connects to the Inngest dev server running as a CI service
 * container (`inngest/inngest:latest`) and exercises `inngest.send()` →
 * REST verification through the real `inngest` v4 SDK. Companion to the
 * mocks-only `inngest-dispatcher-factory.spec.ts` / `inngest-tenant-*`
 * specs — together they cover both the structural contract and
 * wire-level behaviour (event-id assignment, idempotency dedup,
 * tenant-overlay carrier preservation, batched sends).
 *
 * # Design trade-off — events-only, no `serve()` mount
 *
 * The dev server pulls function definitions from a long-lived SDK
 * `serve()` HTTP endpoint via the `-u` flag. Wiring a vitest-driven
 * Node process as that endpoint inside a GitHub Actions service-container
 * topology is fragile (port advertise + ngrok-style tunnel back into the
 * service network). We therefore intentionally test the **outbound**
 * half of the SDK end-to-end (event POST → dev server REST verification)
 * and leave function-execution path coverage to the mocks-only suites,
 * which already exercise the registered-function plumbing via the
 * structural `InngestClient.createFunction` seam.
 *
 * # Gating
 *
 * Skips entirely when `EW_TEST_REAL_INNGEST_URL` is unset, so `pnpm test`
 * is silent on operator dev boxes without Docker. CI exports the URL
 * inside the `job-runtime-real-infra` job, where the dev server runs as
 * a service container on `:8288`.
 *
 * # Concurrency safety
 *
 * Each test creates fresh per-event ids via `randomUUID()` so parallel
 * vitest workers + repeated CI reruns don't collide on the dev server's
 * shared in-memory event log. The dev server is per-job (no persistence
 * across CI jobs), so an `afterEach` scrub is unnecessary.
 */

const INNGEST_URL = process.env['EW_TEST_REAL_INNGEST_URL'];
const realInfra = INNGEST_URL ? describe : describe.skip;

import { InngestDispatcherFactory } from '../inngest-dispatcher-factory.js';
import type { InngestClient } from '../inngest-types.js';

interface InngestCtor {
	new (opts: Record<string, unknown>): InngestClient;
}

/**
 * Lazy-load the real `inngest` SDK only when the gate is open. It's a
 * devDep gated behind `EW_TEST_REAL_INNGEST_URL`, so when an operator
 * runs `pnpm test` without the env we never try to import it.
 */
async function loadRealInngest(): Promise<InngestCtor> {
	const mod = (await import('inngest')) as unknown as { Inngest: InngestCtor };
	return mod.Inngest;
}

/**
 * Poll the dev server's REST API until the event with the given id is
 * visible (it can lag the `send()` ack by a few ms because the SDK
 * acks on HTTP 200 and ingestion is async on the server side).
 */
async function waitForEvent(
	devUrl: string,
	eventId: string,
	timeoutMs = 5000
): Promise<{ id: string; name: string; data: unknown } | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${devUrl}/v1/events/${eventId}`, {
				headers: { Authorization: 'Bearer dev' }
			});
			if (res.ok) {
				const body = (await res.json()) as { data?: { id?: string; name?: string; data?: unknown } };
				if (body.data?.id) {
					return {
						id: body.data.id,
						name: body.data.name ?? '',
						data: body.data.data
					};
				}
			}
		} catch {
			// Server may not be ready yet — retry until the deadline.
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	return null;
}

realInfra('Inngest real-infra (EW-742 P6 T32/T37)', () => {
	let Inngest: InngestCtor;
	const baseUrl = INNGEST_URL!;

	beforeAll(async () => {
		Inngest = await loadRealInngest();
	}, 30_000);

	afterEach(async () => {
		// No-op: dev server state is per-job, randomUUID per-test event
		// ids isolate parallel workers. Kept for symmetry with the
		// bullmq / pg-boss specs.
	});

	function freshClient(appId: string): InngestClient {
		// `eventKey: 'dev'` matches the dev-server's default key. Dev
		// server treats `baseUrl` as both event-API ingest and REST host.
		return new Inngest({
			id: appId,
			eventKey: 'dev',
			isDev: true,
			baseUrl
		});
	}

	it('single-event send returns a non-empty Inngest-assigned id', async () => {
		const appId = `ew-it-single-${randomUUID().slice(0, 8)}`;
		const client = freshClient(appId);
		const factory = new InngestDispatcherFactory({ client, eventNamespace: 'ever.works' });

		const id = await factory.send('kb-embed-document', { workId: `w-${randomUUID()}` });
		expect(id).toBeTruthy();
		expect(typeof id).toBe('string');
	}, 30_000);

	it('event-by-id is retrievable from the dev server REST API after send', async () => {
		const appId = `ew-it-roundtrip-${randomUUID().slice(0, 8)}`;
		const client = freshClient(appId);
		const factory = new InngestDispatcherFactory({ client, eventNamespace: 'ever.works' });

		const workId = `w-${randomUUID()}`;
		const id = await factory.send('kb-embed-document', { workId });
		expect(id).toBeTruthy();

		const event = await waitForEvent(baseUrl, id!);
		expect(event).not.toBeNull();
		expect(event!.id).toBe(id);
		expect(event!.name).toBe('ever.works/kb-embed-document');
		expect(event!.data).toMatchObject({ workId });
	}, 30_000);

	it('JobEnqueueOptions.idempotencyKey is preserved as event.id (dedup carrier)', async () => {
		const appId = `ew-it-idem-${randomUUID().slice(0, 8)}`;
		const client = freshClient(appId);
		const factory = new InngestDispatcherFactory({ client, eventNamespace: 'ever.works' });

		const idemKey = `idem-${randomUUID()}`;
		const first = await factory.enqueue(
			'kb-embed-document',
			{ n: 1 },
			{ idempotencyKey: idemKey, tenantId: 'tenant-a' }
		);
		const second = await factory.enqueue(
			'kb-embed-document',
			{ n: 2 },
			{ idempotencyKey: idemKey, tenantId: 'tenant-a' }
		);

		expect(first).toBeTruthy();
		expect(second).toBeTruthy();

		// Dev server normalises `event.id` → `<seed>-<hash>` server-side,
		// so two sends with the same client-supplied `id` return the
		// SAME canonical server id (dedup invariant). The exact suffix is
		// dev-server internal — assert equality between the two responses.
		expect(second).toBe(first);
	}, 30_000);

	it('T31 carrier: enqueue stamps _ew.tenantId / _ew.tags into event.data', async () => {
		const appId = `ew-it-t31-${randomUUID().slice(0, 8)}`;
		const client = freshClient(appId);
		const factory = new InngestDispatcherFactory({ client, eventNamespace: 'ever.works' });

		const tenantId = `tenant-${randomUUID().slice(0, 8)}`;
		const id = await factory.enqueue(
			'kb-embed-document',
			{ workId: 'w-1' },
			{ tenantId, idempotencyKey: `idem-${randomUUID()}`, tags: ['kb', 'embed'] }
		);
		expect(id).toBeTruthy();

		const event = await waitForEvent(baseUrl, id!);
		expect(event).not.toBeNull();
		const data = event!.data as { workId?: string; _ew?: { tenantId?: string; tags?: readonly string[] } };
		expect(data.workId).toBe('w-1');
		expect(data._ew?.tenantId).toBe(tenantId);
		expect(data._ew?.tags).toEqual(['kb', 'embed']);
	}, 30_000);

	it('sendBatch round-trips every event with its own id', async () => {
		const appId = `ew-it-batch-${randomUUID().slice(0, 8)}`;
		const client = freshClient(appId);
		const factory = new InngestDispatcherFactory({ client, eventNamespace: 'ever.works' });

		const ids = await factory.sendBatch([
			{ name: 'kb-embed-document', data: { which: 'A', nonce: randomUUID() } },
			{ name: 'kb-embed-document', data: { which: 'B', nonce: randomUUID() } },
			{ name: 'kb-embed-document', data: { which: 'C', nonce: randomUUID() } }
		]);

		expect(ids).toHaveLength(3);
		expect(new Set(ids).size).toBe(3); // all unique
		for (const id of ids) expect(typeof id).toBe('string');

		// Spot-check one of the events landed end-to-end.
		const event = await waitForEvent(baseUrl, ids[1]!);
		expect(event).not.toBeNull();
		expect(event!.name).toBe('ever.works/kb-embed-document');
	}, 30_000);
});
