/**
 * The bootstrap's two jobs: refuse an unsafe start, and start a safe one in order.
 *
 * The first test is the load-bearing one for this skeleton — it pins the fact that **today's build
 * refuses**, because its registry is empty. When someone lands APW-10 T6 and that test goes red,
 * that is the signal to update it, not to delete it.
 */
import { describe, expect, it, vi } from 'vitest';

import { APPS_TIER_MANAGED_ENABLED_ENV_VAR } from '@ever-works/contracts';

import { bootstrap, EXIT_CONFIGURATION_REFUSED } from '../bootstrap.js';
import { ZONE_ID_ENV_VAR } from '../config.js';
import { RECONCILERS } from '../reconcile/index.js';
import type { Reconciler, ReconcilerContext, ReconcilerLogger } from '../reconciler.port.js';

function silentLogger(): ReconcilerLogger {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function validEnv(): NodeJS.ProcessEnv {
	return { [APPS_TIER_MANAGED_ENABLED_ENV_VAR]: '1', [ZONE_ID_ENV_VAR]: 'eu-hel-1' };
}

/** A reconciler that records what it was asked to do. */
function fakeReconciler(
	name: string,
	watches = 'Work'
): Reconciler & { readonly calls: string[]; context?: ReconcilerContext } {
	const calls: string[] = [];
	const reconciler = {
		name,
		watches,
		calls,
		context: undefined as ReconcilerContext | undefined,
		async start(context: ReconcilerContext) {
			calls.push('start');
			reconciler.context = context;
		},
		async stop() {
			calls.push('stop');
		}
	};
	return reconciler;
}

describe('bootstrap — refusals', () => {
	it("refuses today's shipped registry, because it is empty", async () => {
		// This is the honest state of the component: the CRDs are installed, nothing reconciles them.
		const result = await bootstrap({ env: validEnv(), reconcilers: RECONCILERS, logger: silentLogger() });

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('unreachable');
		expect(result.exitCode).toBe(EXIT_CONFIGURATION_REFUSED);
		expect(result.refusals.map((refusal) => refusal.code)).toContain('NO_RECONCILERS_REGISTERED');
	});

	it('refuses a reconciler watching a kind no CRD defines', async () => {
		const result = await bootstrap({
			env: validEnv(),
			reconcilers: [fakeReconciler('ghost', 'Sandwich')],
			logger: silentLogger()
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('unreachable');
		expect(result.refusals.map((refusal) => refusal.code)).toContain('UNKNOWN_WATCHED_KIND');
	});

	it('refuses two reconcilers with the same name', async () => {
		const result = await bootstrap({
			env: validEnv(),
			reconcilers: [fakeReconciler('work'), fakeReconciler('work')],
			logger: silentLogger()
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('unreachable');
		expect(result.refusals.map((refusal) => refusal.code)).toContain('DUPLICATE_RECONCILER_NAME');
	});

	it('starts nothing when configuration is refused', async () => {
		const reconciler = fakeReconciler('work');

		const result = await bootstrap({ env: {}, reconcilers: [reconciler], logger: silentLogger() });

		expect(result.ok).toBe(false);
		expect(reconciler.calls).toEqual([]);
	});

	it('logs every refusal it returns', async () => {
		const logger = silentLogger();

		await bootstrap({ env: {}, reconcilers: RECONCILERS, logger });

		expect(logger.error).toHaveBeenCalled();
		expect(vi.mocked(logger.error).mock.calls.length).toBeGreaterThanOrEqual(2);
	});
});

describe('bootstrap — a valid start', () => {
	it('starts each reconciler with the resolved config and a live shutdown signal', async () => {
		const reconciler = fakeReconciler('work');

		const result = await bootstrap({ env: validEnv(), reconcilers: [reconciler], logger: silentLogger() });

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error('unreachable');
		expect(result.started).toEqual(['work']);
		expect(reconciler.calls).toEqual(['start']);
		expect(reconciler.context?.config.zoneId).toBe('eu-hel-1');
		expect(reconciler.context?.shutdown.aborted).toBe(false);
	});

	it('stops reconcilers in reverse order and aborts the signal', async () => {
		const first = fakeReconciler('first');
		const second = fakeReconciler('second', 'SelfCheck');
		const order: string[] = [];
		const track = (name: string, reconciler: Reconciler) => ({
			...reconciler,
			stop: async () => {
				order.push(name);
				await reconciler.stop();
			}
		});

		const result = await bootstrap({
			env: validEnv(),
			reconcilers: [track('first', first), track('second', second)],
			logger: silentLogger()
		});
		if (!result.ok) throw new Error('unreachable');
		await result.shutdown();

		expect(order).toEqual(['second', 'first']);
		expect(first.context?.shutdown.aborted).toBe(true);
	});

	it('is idempotent on shutdown', async () => {
		const reconciler = fakeReconciler('work');

		const result = await bootstrap({ env: validEnv(), reconcilers: [reconciler], logger: silentLogger() });
		if (!result.ok) throw new Error('unreachable');
		await result.shutdown();
		await result.shutdown();

		expect(reconciler.calls).toEqual(['start', 'stop']);
	});

	it('rolls back the loops it already started when a later one fails', async () => {
		const good = fakeReconciler('good');
		const bad: Reconciler = {
			name: 'bad',
			watches: 'SelfCheck',
			start: async () => {
				throw new Error('watch refused');
			},
			stop: async () => undefined
		};

		await expect(bootstrap({ env: validEnv(), reconcilers: [good, bad], logger: silentLogger() })).rejects.toThrow(
			'watch refused'
		);
		expect(good.calls).toEqual(['start', 'stop']);
	});

	it('survives a reconciler that throws while stopping', async () => {
		const stubborn: Reconciler = {
			name: 'stubborn',
			watches: 'Work',
			start: async () => undefined,
			stop: async () => {
				throw new Error('will not stop');
			}
		};
		const logger = silentLogger();

		const result = await bootstrap({ env: validEnv(), reconcilers: [stubborn], logger });
		if (!result.ok) throw new Error('unreachable');

		await expect(result.shutdown()).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalled();
	});
});
