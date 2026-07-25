import { describe, expect, it } from 'vitest';
import {
	EventSourceNotConfiguredError,
	isEventSourcePlugin,
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
