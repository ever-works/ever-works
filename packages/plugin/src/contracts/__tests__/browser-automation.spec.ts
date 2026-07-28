import { describe, expect, it } from 'vitest';
import {
	BrowserAutomationNotProvisionedError,
	BrowserNavigationBlockedError,
	isBrowserAutomationPlugin,
	type BrowserBlockReason
} from '../capabilities/browser-automation.interface.js';
import { ALL_PLUGIN_CAPABILITIES, PLUGIN_CAPABILITIES } from '../facade-capabilities.js';
import type { IPlugin } from '../plugin.interface.js';

describe('browser-automation capability (audit item G22)', () => {
	it('registers `browser-automation` in the capability registry', () => {
		expect(PLUGIN_CAPABILITIES.BROWSER_AUTOMATION).toBe('browser-automation');
		expect(ALL_PLUGIN_CAPABILITIES).toContain('browser-automation');
	});

	it('isBrowserAutomationPlugin guards on the declared capability', () => {
		const yes = { capabilities: ['browser-automation'] } as unknown as IPlugin;
		const no = { capabilities: ['screenshot'] } as unknown as IPlugin;
		expect(isBrowserAutomationPlugin(yes)).toBe(true);
		expect(isBrowserAutomationPlugin(no)).toBe(false);
	});

	it('BrowserNavigationBlockedError keeps its stable cross-package name and code', () => {
		const err = new BrowserNavigationBlockedError('not_allowlisted', 'https://evil.test/');
		expect(err.name).toBe('BrowserNavigationBlockedError');
		expect(err.code).toBe('not_allowlisted');
		expect(err.url).toBe('https://evil.test/');
		expect(err.message).toContain('not_allowlisted');
	});

	it('BrowserNavigationBlockedError honours a caller-supplied message', () => {
		const err = new BrowserNavigationBlockedError('dns_private_ip', 'https://a.test/', 'resolved to 127.0.0.1');
		expect(err.message).toBe('resolved to 127.0.0.1');
		expect(err.code).toBe('dns_private_ip');
	});

	it('covers every documented block reason', () => {
		const reasons: BrowserBlockReason[] = [
			'invalid_url',
			'scheme_blocked',
			'credentials_in_url',
			'private_address',
			'not_allowlisted',
			'dns_private_ip',
			'dns_lookup_failed'
		];
		for (const reason of reasons) {
			expect(new BrowserNavigationBlockedError(reason, 'https://a.test/').code).toBe(reason);
		}
	});

	it('BrowserAutomationNotProvisionedError keeps its stable cross-package name', () => {
		const err = new BrowserAutomationNotProvisionedError();
		expect(err.name).toBe('BrowserAutomationNotProvisionedError');
		expect(err.message).toContain('not provisioned');
		expect(new BrowserAutomationNotProvisionedError('no chromium').message).toBe('no chromium');
	});
});
