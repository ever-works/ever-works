import { describe, expect, it } from 'vitest';

import {
	FLEET_DESKTOP_BLOCKERS,
	FLEET_DESKTOP_BLOCKER_CODES,
	FLEET_DESKTOP_MAX_DISPLAYS,
	FLEET_DESKTOP_REASONS,
	FLEET_DESKTOP_REASON_FIXES,
	FLEET_DESKTOP_WATCH_REASONS,
	FLEET_HELPER_TRUST_LEVELS,
	FLEET_SCREEN_SOURCES,
	fleetDesktopReasonHint,
	fleetDesktopWatermark,
	isFleetDesktopBlocker,
	isFleetDesktopReason,
	isFleetDesktopViewId,
	isFleetDisplayId,
	isFleetHelperTrust,
	isFleetScreenSource,
	normalizeFleetDesktopReasons,
	normalizeFleetDisplays,
	normalizeFleetHelperStatus,
	normalizeFleetHelperTrust,
	pickFleetDisplay,
	readFleetDesktopSourceParams,
	resolveFleetDesktopBlocker,
	type FleetDesktopAvailabilityFacts
} from '../fleet-desktop.types';
import { COMPUTER_UNWATCHABLE_REASONS } from '../../computer/computer-session.types';

describe('fleet desktop guards', () => {
	it.each([
		[FLEET_SCREEN_SOURCES, isFleetScreenSource],
		[FLEET_HELPER_TRUST_LEVELS, isFleetHelperTrust],
		[FLEET_DESKTOP_REASONS, isFleetDesktopReason],
		[FLEET_DESKTOP_BLOCKERS, isFleetDesktopBlocker]
	] as const)('accepts every member and refuses strangers', (members, guard) => {
		for (const member of members) expect(guard(member)).toBe(true);
		for (const stranger of ['', 'DESKTOP', 'none ', null, undefined, 3, {}]) {
			expect(guard(stranger)).toBe(false);
		}
	});

	it('names the eight reasons of FR-4 and leaves the browser reasons as they were', () => {
		expect([...FLEET_DESKTOP_REASONS].sort()).toEqual(
			[
				'helper-missing',
				'helper-unadmitted',
				'helper-untrusted',
				'permission-screen-recording',
				'permission-accessibility',
				'no-display-session',
				'wayland-unsupported',
				'kind-unsupported'
			].sort()
		);
		// The browser source (FR-12) is untouched: its nine reasons keep their order.
		expect(COMPUTER_UNWATCHABLE_REASONS).toEqual([
			'cluster',
			'disabled',
			'paused',
			'draining',
			'offline',
			'not-attended',
			'no-browser',
			'no-display',
			'no-terminal'
		]);
	});

	it('takes the accessibility permission away from control only', () => {
		expect(FLEET_DESKTOP_WATCH_REASONS).not.toContain('permission-accessibility');
		expect(FLEET_DESKTOP_WATCH_REASONS).toHaveLength(FLEET_DESKTOP_REASONS.length - 1);
		expect(FLEET_DESKTOP_BLOCKERS).not.toContain('permission-accessibility');
	});

	it('normalises trust fail-closed', () => {
		expect(normalizeFleetHelperTrust('hash-pinned')).toBe('hash-pinned');
		expect(normalizeFleetHelperTrust('signed')).toBe('signed');
		expect(normalizeFleetHelperTrust('trusted')).toBe('none');
		expect(normalizeFleetHelperTrust(undefined)).toBe('none');
	});
});

describe('desktop reasons', () => {
	it('keeps known reasons once, in precedence order', () => {
		expect(
			normalizeFleetDesktopReasons(['helper-missing', 'bogus', 'wayland-unsupported', 'helper-missing', 7])
		).toEqual(['wayland-unsupported', 'helper-missing']);
		expect(normalizeFleetDesktopReasons('helper-missing')).toEqual([]);
	});

	it('gives the commands and settings paths the unavailable card shows', () => {
		expect(FLEET_DESKTOP_REASON_FIXES['helper-missing'].command).toBe('ever-works-node helper install');
		expect(FLEET_DESKTOP_REASON_FIXES['helper-unadmitted'].command).toBe('ever-works-node helper admit');
		expect(FLEET_DESKTOP_REASON_FIXES['helper-untrusted'].command).toBe('ever-works-node helper status');
		expect(FLEET_DESKTOP_REASON_FIXES['permission-screen-recording'].settingsPath).toContain('Screen Recording');
	});

	it.each(FLEET_DESKTOP_REASONS.map((reason) => [reason]))('has a hint for %s', (reason) => {
		const hint = fleetDesktopReasonHint(reason, 'build-01');
		expect(hint.length).toBeGreaterThan(10);
		const fix = FLEET_DESKTOP_REASON_FIXES[reason];
		if (fix.command) expect(hint).toContain(fix.command);
	});
});

describe('resolveFleetDesktopBlocker', () => {
	const open: FleetDesktopAvailabilityFacts = {
		killSwitch: false,
		kind: 'node',
		online: true,
		attend: true,
		inDesktopAudience: true,
		reasons: [],
		helperTrust: 'hash-pinned',
		linkConnected: true
	};

	it('answers null when a view may open', () => {
		expect(resolveFleetDesktopBlocker(open)).toBeNull();
	});

	it('names the first thing in the way, in order', () => {
		expect(resolveFleetDesktopBlocker({ ...open, killSwitch: true, online: false })).toBe('kill-switch');
		expect(resolveFleetDesktopBlocker({ ...open, kind: 'desktop-node' })).toBe('kind-unsupported');
		expect(resolveFleetDesktopBlocker({ ...open, online: false, attend: false })).toBe('offline');
		expect(resolveFleetDesktopBlocker({ ...open, attend: false, inDesktopAudience: false })).toBe(
			'consent-missing'
		);
		expect(resolveFleetDesktopBlocker({ ...open, inDesktopAudience: false, reasons: ['helper-missing'] })).toBe(
			'permission-denied'
		);
		expect(resolveFleetDesktopBlocker({ ...open, reasons: ['helper-missing', 'wayland-unsupported'] })).toBe(
			'wayland-unsupported'
		);
		expect(resolveFleetDesktopBlocker({ ...open, linkConnected: false })).toBe('link-unavailable');
	});

	it('never lets the control-only permission stop watching', () => {
		expect(resolveFleetDesktopBlocker({ ...open, reasons: ['permission-accessibility'] })).toBeNull();
	});

	it('reads a node that reported no helper as helper-missing (fail-closed)', () => {
		expect(resolveFleetDesktopBlocker({ ...open, helperTrust: 'none' })).toBe('helper-missing');
	});

	it('maps every blocker to a CONTRACTS §8 code', () => {
		for (const blocker of FLEET_DESKTOP_BLOCKERS) expect(FLEET_DESKTOP_BLOCKER_CODES[blocker]).toBeTruthy();
		expect(FLEET_DESKTOP_BLOCKER_CODES['kill-switch']).toBe('kill_switch');
		expect(FLEET_DESKTOP_BLOCKER_CODES['helper-untrusted']).toBe('unsupported_on_node');
		expect(FLEET_DESKTOP_BLOCKER_CODES.offline).toBe('unreachable');
	});
});

describe('displays', () => {
	it('keeps usable displays, primary first, exactly one primary', () => {
		const displays = normalizeFleetDisplays([
			{ id: 'DP-1', name: 'External', width: 3840, height: 2160, scale: 1 },
			{ id: 'eDP-1', name: 'Built-in\u0007', width: 3024, height: 1964, scale: 2, primary: true },
			{ id: 'eDP-1', name: 'dup', width: 1, height: 1, scale: 1 },
			{ id: 'bad id!', width: 10, height: 10 },
			{ id: 'X', width: 0, height: 10 },
			'not an object'
		]);
		expect(displays.map((display) => display.id)).toEqual(['eDP-1', 'DP-1']);
		expect(displays[0]).toMatchObject({ primary: true, name: 'Built-in', scale: 2 });
		expect(displays[1].primary).toBe(false);
	});

	it('makes the first display primary when none claims it, and caps the list', () => {
		const many = Array.from({ length: 40 }, (_, index) => ({ id: `d${index}`, width: 100, height: 100 }));
		const displays = normalizeFleetDisplays(many);
		expect(displays).toHaveLength(FLEET_DESKTOP_MAX_DISPLAYS);
		expect(displays[0]).toMatchObject({ id: 'd0', primary: true, scale: 1, virtual: false });
	});

	it('falls back to the primary when the remembered display is gone (U14)', () => {
		const displays = normalizeFleetDisplays([
			{ id: 'a', width: 10, height: 10, primary: true },
			{ id: 'b', width: 10, height: 10 }
		]);
		expect(pickFleetDisplay(displays, 'b')).toEqual({ display: displays[1], fellBack: false });
		expect(pickFleetDisplay(displays, 'gone')).toEqual({ display: displays[0], fellBack: true });
		expect(pickFleetDisplay(displays, null)).toEqual({ display: displays[0], fellBack: false });
		expect(pickFleetDisplay([], 'b')).toEqual({ display: null, fellBack: false });
	});

	it('bounds display ids', () => {
		expect(isFleetDisplayId('\\\\.\\DISPLAY1')).toBe(false);
		expect(isFleetDisplayId('0')).toBe(true);
		expect(isFleetDisplayId('x'.repeat(65))).toBe(false);
	});
});

describe('helper status', () => {
	it('keeps only what it knows, never a full hash', () => {
		const status = normalizeFleetHelperStatus({
			trust: 'hash-pinned',
			present: true,
			admitted: true,
			version: '0.1.0',
			fingerprintPrefix: 'ABCDEF12',
			verifiedAt: '2026-10-26T01:02:03.000Z',
			published: false,
			sha256: 'f'.repeat(64)
		});
		expect(status).toEqual({
			trust: 'hash-pinned',
			present: true,
			admitted: true,
			version: '0.1.0',
			fingerprintPrefix: 'abcdef12',
			verifiedAt: '2026-10-26T01:02:03.000Z',
			published: false
		});
		expect(normalizeFleetHelperStatus({ fingerprintPrefix: 'f'.repeat(64) })?.fingerprintPrefix).toBeNull();
		expect(normalizeFleetHelperStatus([])).toBeNull();
	});
});

describe('channel params', () => {
	const viewId = '0f0e0d0c-0b0a-4908-8706-050403020100';

	it('reads the Desktop source open params', () => {
		expect(readFleetDesktopSourceParams({ source: 'desktop', viewId, display: 'DP-1', quality: 'steady' })).toEqual(
			{ source: 'desktop', viewId, display: 'DP-1', quality: 'steady' }
		);
		expect(readFleetDesktopSourceParams({ source: 'desktop', viewId, display: '../x', quality: 'ultra' })).toEqual({
			source: 'desktop',
			viewId
		});
		expect(readFleetDesktopSourceParams({ source: 'browser', viewId })).toBeNull();
		expect(readFleetDesktopSourceParams({ source: 'desktop', viewId: 'nope' })).toBeNull();
		expect(isFleetDesktopViewId(viewId)).toBe(true);
	});

	it('names the source in the watermark (FR-1)', () => {
		expect(fleetDesktopWatermark('design-mac')).toBe('EVER WORKS · LIVE VIEW · DESKTOP · design-mac');
	});
});
