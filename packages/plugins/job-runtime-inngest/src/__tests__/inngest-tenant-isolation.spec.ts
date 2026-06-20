import { describe, expect, it, vi } from 'vitest';
import type { IJobRuntimeProvider, TenantCredentialSnapshot } from '@ever-works/plugin';
import { InngestJobRuntimePlugin } from '../inngest-job-runtime.plugin.js';
import {
	tenantAwareInngestFunctionHandler,
	type InngestFunctionContext
} from '../inngest-tenant-aware-handler.js';
import type { InngestSendEvent } from '../inngest-types.js';

/**
 * EW-742 P4 T26/T30/T32 — tenant-isolation contract for the Inngest
 * tenant-aware handler wrapper. No Inngest SDK is required — we call the
 * wrapped handler with crafted `InngestFunctionContext` objects.
 */

const TENANT_A_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function ctxWithTenant(
	tenantId: string | undefined,
	eventName = 'ever.works/test',
	extra: Readonly<Record<string, unknown>> = {}
): InngestFunctionContext {
	const data: Record<string, unknown> = { ...extra };
	if (tenantId !== undefined) {
		data['_ew'] = { tenantId };
	}
	const event: InngestSendEvent = { name: eventName, data };
	return { event, runId: `run-${tenantId ?? 'none'}` };
}

describe('tenantAwareInngestFunctionHandler — tenant isolation', () => {
	it("routes event with tenant A's id to tenant A's binding", async () => {
		const plugin = new InngestJobRuntimePlugin();
		const captured: IJobRuntimeProvider[] = [];

		const wrap = tenantAwareInngestFunctionHandler({ plugin });
		const wrapped = wrap(async (_ctx, binding) => {
			captured.push(binding);
		});

		await wrapped(ctxWithTenant(TENANT_A_ID));

		expect(captured).toHaveLength(1);
		const bindingA = captured[0];
		expect(bindingA).not.toBe(plugin);
		expect(
			bindingA.bindToTenant?.({
				tenantId: TENANT_A_ID,
				providerId: 'inngest',
				credentialVersion: 1,
				credentials: {}
			})
		).toBe(bindingA);
	});

	it('routes tenant B to a distinct binding from A', async () => {
		const plugin = new InngestJobRuntimePlugin();
		const captured: IJobRuntimeProvider[] = [];

		const wrap = tenantAwareInngestFunctionHandler({ plugin });
		const wrapped = wrap(async (_ctx, binding) => {
			captured.push(binding);
		});

		await wrapped(ctxWithTenant(TENANT_A_ID));
		await wrapped(ctxWithTenant(TENANT_B_ID));

		expect(captured).toHaveLength(2);
		const [bindingA, bindingB] = captured;
		expect(bindingA).not.toBe(bindingB);
		expect(bindingA).not.toBe(plugin);
		expect(bindingB).not.toBe(plugin);
	});

	it("two concurrent invocations from different tenants don't cross contexts", async () => {
		const plugin = new InngestJobRuntimePlugin();
		const observed: { runId: string; binding: IJobRuntimeProvider }[] = [];

		let releaseA: () => void = () => undefined;
		let releaseB: () => void = () => undefined;
		const aReady = new Promise<void>((r) => (releaseA = r));
		const bReady = new Promise<void>((r) => (releaseB = r));

		const wrap = tenantAwareInngestFunctionHandler({ plugin });
		const wrapped = wrap(async (ctx, binding) => {
			if (ctx.runId?.includes('A')) {
				await aReady;
			} else {
				await bReady;
			}
			observed.push({ runId: ctx.runId ?? '', binding });
		});

		const ctxA: InngestFunctionContext = {
			event: { name: 'ever.works/test', data: { _ew: { tenantId: TENANT_A_ID } } },
			runId: 'runA'
		};
		const ctxB: InngestFunctionContext = {
			event: { name: 'ever.works/test', data: { _ew: { tenantId: TENANT_B_ID } } },
			runId: 'runB'
		};

		const pA = wrapped(ctxA);
		const pB = wrapped(ctxB);

		// Release in reversed order to maximise interleaving.
		releaseB();
		releaseA();
		await Promise.all([pA, pB]);

		expect(observed).toHaveLength(2);
		const aObs = observed.find((o) => o.runId === 'runA');
		const bObs = observed.find((o) => o.runId === 'runB');
		expect(aObs).toBeDefined();
		expect(bObs).toBeDefined();
		expect(aObs!.binding).not.toBe(bObs!.binding);

		expect(
			aObs!.binding.bindToTenant?.({
				tenantId: TENANT_A_ID,
				providerId: 'inngest',
				credentialVersion: 1,
				credentials: {}
			})
		).toBe(aObs!.binding);
		expect(
			bObs!.binding.bindToTenant?.({
				tenantId: TENANT_B_ID,
				providerId: 'inngest',
				credentialVersion: 1,
				credentials: {}
			})
		).toBe(bObs!.binding);
	});

	it('event without _ew.tenantId falls back to plugin default binding', async () => {
		const plugin = new InngestJobRuntimePlugin();
		const captured: IJobRuntimeProvider[] = [];

		const wrap = tenantAwareInngestFunctionHandler({ plugin });
		const wrapped = wrap(async (_ctx, binding) => {
			captured.push(binding);
		});

		await wrapped(ctxWithTenant(undefined));

		expect(captured).toHaveLength(1);
		expect(captured[0]).toBe(plugin);
	});

	it('resolveSnapshot is called per tenantId; downstream bindings are memoised by plugin.bindToTenant', async () => {
		const plugin = new InngestJobRuntimePlugin();
		const captured: IJobRuntimeProvider[] = [];

		const resolveSnapshot = vi.fn(
			async (tenantId: string): Promise<TenantCredentialSnapshot> => ({
				tenantId,
				providerId: 'inngest',
				credentialVersion: 1,
				credentials: { eventKey: `key-${tenantId.slice(0, 1)}` }
			})
		);

		const wrap = tenantAwareInngestFunctionHandler({ plugin, resolveSnapshot });
		const wrapped = wrap(async (_ctx, binding) => {
			captured.push(binding);
		});

		await wrapped(ctxWithTenant(TENANT_A_ID));
		await wrapped(ctxWithTenant(TENANT_A_ID));
		await wrapped(ctxWithTenant(TENANT_B_ID));

		// resolveSnapshot fires once per invocation (the wrapper does NOT
		// cache snapshots — that's the operator's resolveSnapshot impl's job).
		expect(resolveSnapshot).toHaveBeenCalledTimes(3);
		expect(resolveSnapshot.mock.calls.map((c) => c[0])).toEqual([
			TENANT_A_ID,
			TENANT_A_ID,
			TENANT_B_ID
		]);

		// But plugin.bindToTenant memoises by (tenantId, credentialVersion):
		// the two A-tenant invocations share a binding identity.
		expect(captured).toHaveLength(3);
		expect(captured[0]).toBe(captured[1]);
		expect(captured[0]).not.toBe(captured[2]);
	});

	it("preserves the operator handler's return value", async () => {
		const plugin = new InngestJobRuntimePlugin();
		const wrap = tenantAwareInngestFunctionHandler({ plugin });
		const wrapped = wrap(async (_ctx, _binding) => {
			return { ok: true, value: 42 } as const;
		});

		const result = await wrapped(ctxWithTenant(TENANT_A_ID));
		expect(result).toEqual({ ok: true, value: 42 });
	});

	it('propagates handler errors', async () => {
		const plugin = new InngestJobRuntimePlugin();
		const wrap = tenantAwareInngestFunctionHandler({ plugin });
		const boom = new Error('handler exploded');
		const wrapped = wrap(async () => {
			throw boom;
		});

		await expect(wrapped(ctxWithTenant(TENANT_A_ID))).rejects.toBe(boom);
	});
});
