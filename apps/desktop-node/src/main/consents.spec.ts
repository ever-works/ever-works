import { describe, expect, it } from 'vitest';
import { DEFAULT_DESKTOP_CONSENTS } from '../shared/ipc-contract';
import {
	describeDesktopConsents,
	loadDesktopConsents,
	normalizeDesktopConsents,
	runtimeConsentOptions,
	saveDesktopConsents
} from './consents';

/**
 * Fleet node link (FL-02 T-26, spec S13, FR-39) — the desktop app's consents:
 * stored beside the enrolment, defaulting to how the app always ran (work on,
 * the rest off), and passed through to the shared runtime with the link on.
 */
describe('desktop consents', () => {
	it('defaults to work only for an install older than consents', async () => {
		const fs = { readFile: async () => null, writeFile: async () => undefined };
		expect(await loadDesktopConsents(fs, '/u/node-consents.json')).toEqual(DEFAULT_DESKTOP_CONSENTS);
		expect(DEFAULT_DESKTOP_CONSENTS).toEqual({ work: true, attend: false, manage: false });
	});

	it('round-trips what the owner chose, and reads junk as the defaults', async () => {
		const files = new Map<string, string>();
		const fs = {
			readFile: async (path: string) => files.get(path) ?? null,
			writeFile: async (path: string, content: string) => {
				files.set(path, content);
			}
		};
		await saveDesktopConsents(fs, '/u/node-consents.json', { work: false, attend: true, manage: true });
		expect(await loadDesktopConsents(fs, '/u/node-consents.json')).toEqual({
			work: false,
			attend: true,
			manage: true
		});
		files.set('/u/node-consents.json', '{ broken');
		expect(await loadDesktopConsents(fs, '/u/node-consents.json')).toEqual(DEFAULT_DESKTOP_CONSENTS);
	});

	it('takes only literal booleans; a missing key keeps its default', () => {
		expect(normalizeDesktopConsents({ work: 'false', attend: 1, manage: true })).toEqual({
			work: true,
			attend: false,
			manage: true
		});
		expect(normalizeDesktopConsents(null)).toEqual(DEFAULT_DESKTOP_CONSENTS);
	});

	it('passes the consents through to the runtime with the node link on (S13)', () => {
		expect(runtimeConsentOptions({ work: true, attend: false, manage: true })).toEqual({
			workerEnabled: true,
			attendEnabled: false,
			manageEnabled: true,
			nodeLink: true
		});
		expect(runtimeConsentOptions({ work: false, attend: false, manage: false }).workerEnabled).toBe(false);
	});

	it('describes them in one line', () => {
		expect(describeDesktopConsents({ work: true, attend: false, manage: true })).toBe('work, manage');
		expect(describeDesktopConsents({ work: false, attend: false, manage: false })).toBe('none');
	});
});
