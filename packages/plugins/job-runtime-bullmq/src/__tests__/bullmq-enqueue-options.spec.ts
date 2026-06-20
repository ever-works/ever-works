import { describe, expect, it } from 'vitest';
import type { JobEnqueueOptions } from '@ever-works/plugin';
import { mapEnqueueOptions } from '../bullmq-enqueue-options.js';

describe('mapEnqueueOptions (EW-742 P4 T31 BullMQ stamping)', () => {
	it('translates idempotencyKey → jobId', () => {
		expect(mapEnqueueOptions({ idempotencyKey: 'idem-1' })).toEqual({ jobId: 'idem-1' });
	});

	it('translates tenantId → tenantId (custom JobsOptions field)', () => {
		expect(mapEnqueueOptions({ tenantId: 't-acme' })).toEqual({ tenantId: 't-acme' });
	});

	it('translates concurrencyKey → concurrencyKey (custom field, worker honours)', () => {
		expect(mapEnqueueOptions({ concurrencyKey: 'work-42' })).toEqual({
			concurrencyKey: 'work-42'
		});
	});

	it('translates tags / maxDurationSeconds / machineHint as custom passthroughs', () => {
		expect(
			mapEnqueueOptions({ tags: ['kb', 'embed'], maxDurationSeconds: 900, machineHint: 'small-2x' })
		).toEqual({ tags: ['kb', 'embed'], maxDurationSeconds: 900, machineHint: 'small-2x' });
	});

	it('omits fields that are undefined (no noisy keys)', () => {
		const out = mapEnqueueOptions({ tenantId: 't' });
		expect(Object.keys(out)).toEqual(['tenantId']);
	});

	it('returns an empty object for empty input', () => {
		expect(mapEnqueueOptions({})).toEqual({});
	});

	it('translates all fields together', () => {
		const opts: JobEnqueueOptions = {
			idempotencyKey: 'idem-A',
			tenantId: 'tenant-A',
			concurrencyKey: 'work-A',
			tags: ['kb'],
			maxDurationSeconds: 600,
			machineHint: 'medium-1x'
		};
		expect(mapEnqueueOptions(opts)).toEqual({
			jobId: 'idem-A',
			tenantId: 'tenant-A',
			concurrencyKey: 'work-A',
			tags: ['kb'],
			maxDurationSeconds: 600,
			machineHint: 'medium-1x'
		});
	});
});
