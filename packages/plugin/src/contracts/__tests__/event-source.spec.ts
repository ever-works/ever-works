import { describe, expect, it } from 'vitest';
import {
	EventSourceNotConfiguredError,
	isEventSourcePlugin,
	supportsEventSourceBackfill,
	clampEventSourceBackfillDays,
	EVENT_SOURCE_BACKFILL_MAX_DAYS,
	type IEventSourcePlugin
} from '../capabilities/event-source.interface.js';
import { ALL_PLUGIN_CAPABILITIES, PLUGIN_CAPABILITIES } from '../facade-capabilities.js';
import type { IPlugin } from '../plugin.interface.js';

describe('event-source capability (Wave 6)', () => {
	it('registers `event-source` in the capability registry', () => {
		expect(PLUGIN_CAPABILITIES.EVENT_SOURCE).toBe('event-source');
		expect(ALL_PLUGIN_CAPABILITIES).toContain('event-source');
	});

	it('isEventSourcePlugin guards on the declared capability', () => {
		const yes = { capabilities: ['event-source'] } as unknown as IPlugin;
		const no = { capabilities: ['search'] } as unknown as IPlugin;
		expect(isEventSourcePlugin(yes)).toBe(true);
		expect(isEventSourcePlugin(no)).toBe(false);
	});

	it('EventSourceNotConfiguredError keeps its stable cross-package name', () => {
		const err = new EventSourceNotConfiguredError();
		expect(err.name).toBe('EventSourceNotConfiguredError');
		expect(err.message).toContain('not configured');
		const custom = new EventSourceNotConfiguredError('workspace not connected');
		expect(custom.message).toBe('workspace not connected');
		expect(custom.name).toBe('EventSourceNotConfiguredError');
	});

	it('pullEvents contract round-trips envelopes + cursor', async () => {
		const plugin: Pick<IEventSourcePlugin, 'pullEvents'> = {
			pullEvents: async ({ since, cursor }) => ({
				events: [
					{
						id: 'env-1',
						source: 'demo-source',
						sourceEventId: `after:${since}`,
						kind: 'demo.event',
						occurredAt: since,
						payload: { cursor: cursor ?? null }
					}
				],
				nextCursor: 'page-2'
			})
		};

		const result = await plugin.pullEvents({ since: '2026-07-01T00:00:00.000Z' });
		expect(result.events).toHaveLength(1);
		expect(result.events[0].sourceEventId).toBe('after:2026-07-01T00:00:00.000Z');
		expect(result.nextCursor).toBe('page-2');
	});
});

describe('event-source backfill (audit item (l))', () => {
	const pullOnly: IEventSourcePlugin = {
		id: 'pull-only',
		capabilities: ['event-source'],
		providerName: 'pull-only',
		pullEvents: async () => ({ events: [] })
	} as unknown as IEventSourcePlugin;

	const withBackfill: IEventSourcePlugin = {
		id: 'with-backfill',
		capabilities: ['event-source'],
		providerName: 'with-backfill',
		pullEvents: async () => ({ events: [] }),
		backfill: async ({ since, until, cursor }) => ({
			events: [
				{
					id: 'env-b1',
					source: 'with-backfill',
					sourceEventId: `${since}->${until ?? 'now'}`,
					kind: 'demo.historical',
					occurredAt: since,
					payload: { resumedFrom: cursor ?? null }
				}
			],
			nextCursor: cursor ? undefined : 'page-2',
			complete: cursor ? true : undefined
		})
	} as unknown as IEventSourcePlugin;

	it('`backfill` is OPTIONAL — a source without it is still a valid event source', () => {
		// The load path only ever checks the capability string, so a
		// connector with no history to offer keeps working untouched.
		expect(isEventSourcePlugin(pullOnly)).toBe(true);
		expect(supportsEventSourceBackfill(pullOnly)).toBe(false);
	});

	it('supportsEventSourceBackfill feature-detects the METHOD, not a capability string', () => {
		expect(supportsEventSourceBackfill(withBackfill)).toBe(true);
		// Declaring `event-source` alone is not enough...
		expect(supportsEventSourceBackfill({ capabilities: ['event-source'] } as never)).toBe(false);
		// ...and implementing `backfill` without the capability is not either.
		expect(
			supportsEventSourceBackfill({ capabilities: ['search'], backfill: async () => ({ events: [] }) } as never)
		).toBe(false);
	});

	it('backfill round-trips the window and pages through its own cursor', async () => {
		const first = await withBackfill.backfill!({
			since: '2026-06-01T00:00:00.000Z',
			until: '2026-07-01T00:00:00.000Z'
		});
		expect(first.events[0].sourceEventId).toBe('2026-06-01T00:00:00.000Z->2026-07-01T00:00:00.000Z');
		expect(first.nextCursor).toBe('page-2');
		expect(first.complete).toBeUndefined();

		const second = await withBackfill.backfill!({
			since: '2026-06-01T00:00:00.000Z',
			cursor: first.nextCursor
		});
		expect(second.events[0].payload).toEqual({ resumedFrom: 'page-2' });
		expect(second.nextCursor).toBeUndefined();
		expect(second.complete).toBe(true);
	});

	it('clampEventSourceBackfillDays: garbage and negatives mean OFF, never a wider window', () => {
		expect(clampEventSourceBackfillDays(undefined)).toBe(0);
		expect(clampEventSourceBackfillDays('nope')).toBe(0);
		expect(clampEventSourceBackfillDays(Number.NaN)).toBe(0);
		expect(clampEventSourceBackfillDays(-30)).toBe(0);
		expect(clampEventSourceBackfillDays(0)).toBe(0);
	});

	it('clampEventSourceBackfillDays: floors fractions and caps at the shared maximum', () => {
		expect(clampEventSourceBackfillDays(14.9)).toBe(14);
		expect(clampEventSourceBackfillDays('7')).toBe(7);
		expect(clampEventSourceBackfillDays(10_000)).toBe(EVENT_SOURCE_BACKFILL_MAX_DAYS);
		expect(EVENT_SOURCE_BACKFILL_MAX_DAYS).toBe(90);
		// A caller may tighten the bound but the clamp still applies.
		expect(clampEventSourceBackfillDays(60, 30)).toBe(30);
	});
});
