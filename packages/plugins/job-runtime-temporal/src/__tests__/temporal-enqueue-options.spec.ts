import { describe, expect, it } from 'vitest';
import type { JobEnqueueOptions } from '@ever-works/plugin';
import { mapEnqueueOptions } from '../temporal-enqueue-options.js';
import { TemporalDispatcherFactory } from '../temporal-dispatcher-factory.js';
import type {
	TemporalStartWorkflowOptions,
	TemporalWorkflowClient,
	TemporalWorkflowHandle
} from '../temporal-types.js';

describe('mapEnqueueOptions (EW-742 P4 T31 Temporal stamping)', () => {
	it('idempotencyKey surfaces as workflowIdFromIdempotency', () => {
		const out = mapEnqueueOptions({ idempotencyKey: 'kb-embed:work-7' });
		expect(out.workflowIdFromIdempotency).toBe('kb-embed:work-7');
		expect(out.startOptions).toEqual({});
	});

	it('tenantId → searchAttributes.tenantId (list-wrapped)', () => {
		const out = mapEnqueueOptions({ tenantId: 't-acme' });
		expect(out.startOptions.searchAttributes).toEqual({ tenantId: ['t-acme'] });
	});

	it('concurrencyKey + tags → searchAttributes (list-wrapped)', () => {
		const out = mapEnqueueOptions({ concurrencyKey: 'work-7', tags: ['kb', 'embed'] });
		expect(out.startOptions.searchAttributes).toEqual({
			concurrencyKey: ['work-7'],
			tags: ['kb', 'embed']
		});
	});

	it('omits empty tags array', () => {
		const out = mapEnqueueOptions({ tags: [] });
		expect(out.startOptions.searchAttributes).toBeUndefined();
	});

	it('maxDurationSeconds → workflowExecutionTimeout (string form)', () => {
		expect(mapEnqueueOptions({ maxDurationSeconds: 900 }).startOptions.workflowExecutionTimeout).toBe('900s');
	});

	it('machineHint → memo.machineHint', () => {
		expect(mapEnqueueOptions({ machineHint: 'medium-1x' }).startOptions.memo).toEqual({
			machineHint: 'medium-1x'
		});
	});

	it('all together', () => {
		const opts: JobEnqueueOptions = {
			idempotencyKey: 'idem-A',
			tenantId: 'tenant-A',
			concurrencyKey: 'work-A',
			tags: ['kb'],
			maxDurationSeconds: 600,
			machineHint: 'medium-1x'
		};
		expect(mapEnqueueOptions(opts)).toEqual({
			workflowIdFromIdempotency: 'idem-A',
			startOptions: {
				searchAttributes: {
					tenantId: ['tenant-A'],
					concurrencyKey: ['work-A'],
					tags: ['kb']
				},
				memo: { machineHint: 'medium-1x' },
				workflowExecutionTimeout: '600s'
			}
		});
	});

	it('empty input returns empty translation', () => {
		expect(mapEnqueueOptions({})).toEqual({
			workflowIdFromIdempotency: undefined,
			startOptions: {}
		});
	});
});

class FakeHandle implements TemporalWorkflowHandle {
	constructor(public readonly workflowId: string) {}
	async cancel() {
		// noop
	}
	async describe() {
		return { status: { name: 'RUNNING' } };
	}
}

class FakeClient implements TemporalWorkflowClient {
	startCalls: { type: string; options: TemporalStartWorkflowOptions }[] = [];
	async start(workflowType: string, options: TemporalStartWorkflowOptions) {
		this.startCalls.push({ type: workflowType, options });
		return new FakeHandle(options.workflowId);
	}
	getHandle(workflowId: string) {
		return new FakeHandle(workflowId);
	}
}

describe('TemporalDispatcherFactory.enqueue (EW-742 P4 T31)', () => {
	it('translates JobEnqueueOptions and starts the workflow', async () => {
		const client = new FakeClient();
		const factory = new TemporalDispatcherFactory({ client, defaultTaskQueue: 'ew' });
		const handle = await factory.enqueue('kbEmbedWorkflow', [{ workId: 'w7' }], {
			idempotencyKey: 'kb-embed:work-7',
			tenantId: 't-acme',
			concurrencyKey: 'work-7',
			tags: ['kb'],
			maxDurationSeconds: 900,
			machineHint: 'medium-1x'
		});
		expect(handle.workflowId).toBe('kb-embed:work-7');
		const call = client.startCalls[0];
		expect(call.type).toBe('kbEmbedWorkflow');
		expect(call.options.workflowId).toBe('kb-embed:work-7');
		expect(call.options.args).toEqual([{ workId: 'w7' }]);
		expect(call.options.taskQueue).toBe('ew');
		expect(call.options.searchAttributes).toEqual({
			tenantId: ['t-acme'],
			concurrencyKey: ['work-7'],
			tags: ['kb']
		});
		expect(call.options.memo).toEqual({ machineHint: 'medium-1x' });
		expect(call.options.workflowExecutionTimeout).toBe('900s');
	});

	it('extraOpts.workflowId wins over idempotencyKey', async () => {
		const client = new FakeClient();
		const factory = new TemporalDispatcherFactory({ client, defaultTaskQueue: 'ew' });
		await factory.enqueue('wf', [], { idempotencyKey: 'idem' }, { workflowId: 'explicit-id' });
		expect(client.startCalls[0].options.workflowId).toBe('explicit-id');
	});

	it('throws when neither idempotencyKey nor extraOpts.workflowId is set', async () => {
		const client = new FakeClient();
		const factory = new TemporalDispatcherFactory({ client, defaultTaskQueue: 'ew' });
		await expect(factory.enqueue('wf', [], {})).rejects.toThrow(/no workflowId available/);
	});

	it('extraOpts shallow-merge OVER translated startOptions', async () => {
		const client = new FakeClient();
		const factory = new TemporalDispatcherFactory({ client, defaultTaskQueue: 'ew' });
		await factory.enqueue(
			'wf',
			[],
			{ idempotencyKey: 'idem', tenantId: 't-from-platform' },
			{ searchAttributes: { tenantId: ['t-from-operator'] } }
		);
		expect(client.startCalls[0].options.searchAttributes).toEqual({
			tenantId: ['t-from-operator']
		});
	});
});
