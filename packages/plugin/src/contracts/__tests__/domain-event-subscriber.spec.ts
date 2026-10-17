import { describe, expect, it } from 'vitest';

import {
	DOMAIN_EVENT_SUBSCRIBER_CAPABILITY,
	isDomainEventSubscriberPlugin
} from '../capabilities/domain-event-subscriber.interface.js';
import { ALL_PLUGIN_CAPABILITIES, isValidPluginCapability, PLUGIN_CAPABILITIES } from '../facade-capabilities.js';

/** A minimal subscriber: the capability, its patterns and the handler. */
const subscriber = (overrides: Record<string, unknown> = {}) => ({
	id: 'slack-notifier',
	name: 'Slack notifier',
	version: '1.0.0',
	capabilities: ['domain-event-subscriber'],
	subscribes: ['task.transitioned', 'goal.*'],
	onDomainEvent: async () => undefined,
	...overrides
});

describe('the domain-event-subscriber capability (EW-P1-1)', () => {
	it('names the capability once, appended last to the table', () => {
		expect(DOMAIN_EVENT_SUBSCRIBER_CAPABILITY).toBe('domain-event-subscriber');
		expect(PLUGIN_CAPABILITIES.DOMAIN_EVENT_SUBSCRIBER).toBe(DOMAIN_EVENT_SUBSCRIBER_CAPABILITY);
		const keys = Object.keys(PLUGIN_CAPABILITIES);
		expect(keys[keys.length - 1]).toBe('DOMAIN_EVENT_SUBSCRIBER');
		expect(ALL_PLUGIN_CAPABILITIES.filter((value) => value === 'domain-event-subscriber')).toHaveLength(1);
		expect(isValidPluginCapability('domain-event-subscriber')).toBe(true);
		// Near misses stay invalid: manifests are validated against this guard.
		expect(isValidPluginCapability('domain-events')).toBe(false);
		expect(isValidPluginCapability('domain-event-subscribers')).toBe(false);
	});
});

describe('isDomainEventSubscriberPlugin', () => {
	it('accepts a plugin that declares the capability, lists patterns and handles events', () => {
		expect(isDomainEventSubscriberPlugin(subscriber())).toBe(true);
		expect(isDomainEventSubscriberPlugin(subscriber({ subscribes: [] }))).toBe(true);
	});

	it('refuses a plugin without the capability', () => {
		expect(isDomainEventSubscriberPlugin(subscriber({ capabilities: ['notification-channel'] }))).toBe(false);
	});

	it('refuses a plugin without a handler or without patterns', () => {
		expect(isDomainEventSubscriberPlugin(subscriber({ onDomainEvent: undefined }))).toBe(false);
		expect(isDomainEventSubscriberPlugin(subscriber({ subscribes: undefined }))).toBe(false);
		expect(isDomainEventSubscriberPlugin(subscriber({ subscribes: 'task.*' }))).toBe(false);
		expect(isDomainEventSubscriberPlugin(subscriber({ subscribes: ['task.*', ''] }))).toBe(false);
	});

	it('refuses things that are not plugins', () => {
		expect(isDomainEventSubscriberPlugin(null)).toBe(false);
		expect(isDomainEventSubscriberPlugin(undefined)).toBe(false);
		expect(isDomainEventSubscriberPlugin('domain-event-subscriber')).toBe(false);
	});
});
