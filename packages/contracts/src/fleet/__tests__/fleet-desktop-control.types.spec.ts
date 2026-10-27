import { describe, expect, it } from 'vitest';
import {
	fleetDesktopBlockedShortcutLabels,
	fleetDesktopControlAvailabilityOf,
	fleetDesktopControlReasonHint,
	FLEET_DESKTOP_CONTROL_REASONS,
	FLEET_DESKTOP_CONTROL_REASON_FIXES,
	FleetDesktopModifierTracker,
	fleetDesktopInputBlocked,
	fleetDesktopModifierOfCode,
	isFleetDesktopMode,
	isFleetHelperControlAllowed,
	normalizeFleetDesktopControllerName,
	normalizeFleetDesktopControlReasons,
	normalizeFleetDesktopInputRefusedCode,
	parseFleetHelperControlRecord,
	resolveFleetDesktopControlReasons
} from '../fleet-desktop-control.types.js';
import { fleetHelperEventAuditAction, normalizeFleetHelperEvent } from '../fleet-helper.types.js';
import { FLEET_AUDIT_ACTIONS } from '../fleet-panic.types.js';
import { normalizeFleetHelperStatus } from '../fleet-desktop.types.js';

const AT = '2026-10-27T02:00:00.000Z';

describe('desktop control reasons (FL-07 P2)', () => {
	it('keeps known reasons once, in the declared order', () => {
		expect(
			normalizeFleetDesktopControlReasons([
				'input-unavailable',
				'nope',
				'control-not-allowed',
				'input-unavailable'
			])
		).toEqual(['control-not-allowed', 'input-unavailable']);
		expect(normalizeFleetDesktopControlReasons('control-not-allowed')).toEqual([]);
	});

	it('never offers control on a status that does not say it is allowed', () => {
		expect(resolveFleetDesktopControlReasons(null)).toEqual(['control-not-allowed']);
		expect(resolveFleetDesktopControlReasons({})).toEqual(['control-not-allowed']);
		expect(resolveFleetDesktopControlReasons({ control: 'not-allowed' })).toEqual(['control-not-allowed']);
		expect(resolveFleetDesktopControlReasons({ control: 'allowed' })).toEqual([]);
		expect(
			resolveFleetDesktopControlReasons({ control: 'allowed', inputReasons: ['permission-accessibility'] })
		).toEqual(['permission-accessibility']);
	});

	it('names a fix and a hint for every reason, with the computer named', () => {
		for (const reason of FLEET_DESKTOP_CONTROL_REASONS) {
			expect(FLEET_DESKTOP_CONTROL_REASON_FIXES[reason]).toBeDefined();
			expect(fleetDesktopControlReasonHint(reason, 'build-01')).toContain('build-01');
		}
		expect(fleetDesktopControlReasonHint('control-not-allowed', 'build-01')).toContain(
			'ever-works-node helper control allow'
		);
	});

	it('assembles the availability with the blocked shortcuts named (FR-37)', () => {
		const blocked = fleetDesktopControlAvailabilityOf({ control: 'not-allowed' }, 'build-01');
		expect(blocked.available).toBe(false);
		expect(blocked.hint).toContain('build-01');
		const open = fleetDesktopControlAvailabilityOf({ control: 'allowed', inputReasons: [] }, 'build-01');
		expect(open).toMatchObject({ available: true, reasons: [], hint: null });
		expect(open.blockedShortcuts).toContain('Ctrl+Alt+Delete');
		expect(new Set(fleetDesktopBlockedShortcutLabels()).size).toBe(fleetDesktopBlockedShortcutLabels().length);
	});
});

describe('the owner’s on-machine permission (helper-control.json)', () => {
	it('parses exactly a record and nothing else', () => {
		const record = { schemaVersion: 1, allowed: true, admissionAt: AT, changedAt: AT };
		expect(parseFleetHelperControlRecord(record)).toEqual(record);
		expect(parseFleetHelperControlRecord({ ...record, schemaVersion: 2 })).toBeNull();
		expect(parseFleetHelperControlRecord({ ...record, allowed: 'yes' })).toBeNull();
		expect(parseFleetHelperControlRecord({ ...record, admissionAt: 'yesterday' })).toBeNull();
		expect(parseFleetHelperControlRecord([record])).toBeNull();
		expect(parseFleetHelperControlRecord(null)).toBeNull();
	});

	it('is void for any other admission of the helper', () => {
		const record = parseFleetHelperControlRecord({
			schemaVersion: 1,
			allowed: true,
			admissionAt: AT,
			changedAt: AT
		});
		expect(isFleetHelperControlAllowed(record, { acknowledgedAt: AT })).toBe(true);
		expect(isFleetHelperControlAllowed(record, { acknowledgedAt: '2026-10-28T00:00:00.000Z' })).toBe(false);
		expect(isFleetHelperControlAllowed(record, null)).toBe(false);
		expect(isFleetHelperControlAllowed({ ...record!, allowed: false }, { acknowledgedAt: AT })).toBe(false);
		expect(isFleetHelperControlAllowed(null, { acknowledgedAt: AT })).toBe(false);
	});
});

describe('the channel', () => {
	it('knows its two modes', () => {
		expect(isFleetDesktopMode('controlling')).toBe(true);
		expect(isFleetDesktopMode('watching')).toBe(true);
		expect(isFleetDesktopMode('driver')).toBe(false);
	});

	it('prints a controller name on one bounded, clean line', () => {
		expect(normalizeFleetDesktopControllerName('Ada\nLovelace\u202e')).toBe('Ada Lovelace');
		expect(normalizeFleetDesktopControllerName('x'.repeat(200))).toHaveLength(64);
		expect(normalizeFleetDesktopControllerName('  ')).toBeNull();
		expect(normalizeFleetDesktopControllerName(42)).toBeNull();
	});

	it('maps whatever the helper answered to a known refusal code', () => {
		expect(normalizeFleetDesktopInputRefusedCode('blocked-shortcut')).toBe('blocked-shortcut');
		expect(normalizeFleetDesktopInputRefusedCode('wayland-unsupported')).toBe('inject-failed');
	});
});

describe('the machine half on the wire', () => {
	it('carries control and input reasons inside `helper`, only when the node said them', () => {
		const base = { trust: 'hash-pinned', present: true, admitted: true };
		expect(normalizeFleetHelperStatus(base)).not.toHaveProperty('control');
		expect(
			normalizeFleetHelperStatus({ ...base, control: 'allowed', inputReasons: ['permission-accessibility', 'x'] })
		).toMatchObject({
			control: 'allowed',
			inputReasons: ['permission-accessibility']
		});
		expect(normalizeFleetHelperStatus({ ...base, control: 'yes' })).not.toHaveProperty('control');
	});

	it('audits the owner allowing or withdrawing control on the machine', () => {
		expect(fleetHelperEventAuditAction('control-allow')).toBe('node.helper.control-allow');
		expect(fleetHelperEventAuditAction('control-deny')).toBe('node.helper.control-deny');
		expect(FLEET_AUDIT_ACTIONS).toEqual(
			expect.arrayContaining(['node.helper.control-allow', 'node.helper.control-deny'])
		);
		expect(
			normalizeFleetHelperEvent({
				id: '0f0e0d0c-0b0a-4908-8706-050403020100',
				kind: 'control-allow',
				at: '2026-10-27T03:00:00Z'
			})
		).toMatchObject({ kind: 'control-allow' });
	});
});

describe('blocked shortcuts split across presses (FR-37)', () => {
	it('refuses Ctrl then V sent with no declared modifiers, and text while Alt is held', () => {
		const held = new FleetDesktopModifierTracker();
		held.apply({ kind: 'key', action: 'down', code: 'ControlLeft' });
		expect(held.bits()).toBe(2);
		expect(
			fleetDesktopInputBlocked({ kind: 'key', action: 'down', key: 'v', code: 'KeyV', modifiers: 0 }, held.bits())
		).toBe(true);
		expect(
			fleetDesktopInputBlocked({ kind: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers: 0 }, held.bits())
		).toBe(false);
		held.apply({ kind: 'key', action: 'up', code: 'ControlLeft' });
		expect(
			fleetDesktopInputBlocked({ kind: 'key', action: 'down', key: 'v', code: 'KeyV', modifiers: 0 }, held.bits())
		).toBe(false);
		held.apply({ kind: 'key', action: 'down', code: 'AltRight' });
		expect(fleetDesktopInputBlocked({ kind: 'text', text: '\t' }, held.bits())).toBe(true);
		expect(
			fleetDesktopInputBlocked({ kind: 'key', action: 'down', key: 'F4', code: 'F4', modifiers: 0 }, held.bits())
		).toBe(true);
		held.reset();
		expect(fleetDesktopInputBlocked({ kind: 'text', text: 'hello' }, held.bits())).toBe(false);
	});

	it('knows the modifier keys by their physical code only', () => {
		expect(fleetDesktopModifierOfCode('ShiftRight')).toBe(8);
		expect(fleetDesktopModifierOfCode('OSLeft')).toBe(4);
		expect(fleetDesktopModifierOfCode('KeyC')).toBe(0);
		expect(fleetDesktopModifierOfCode(undefined)).toBe(0);
	});
});
