import { describe, expect, it } from 'vitest';

import {
	COMPUTER_BLOCKED_SHORTCUTS,
	COMPUTER_CONTROL_CEILING_MS_DEFAULT,
	COMPUTER_CONTROL_DECISIONS,
	COMPUTER_CONTROL_DISCONNECT_MS,
	COMPUTER_CONTROL_IDLE_MS_DEFAULT,
	COMPUTER_CONTROL_IDLE_WARNING_MS,
	COMPUTER_CONTROL_REFUSALS,
	COMPUTER_CONTROL_REQUEST_TIMEOUT_MS,
	COMPUTER_VIEWER_ROLES,
	isComputerControlDecision,
	isComputerControlRefusal,
	isComputerShortcutBlocked,
	isComputerViewerRole
} from '../computer-control.types.js';
import * as contracts from '../../index.js';

describe('computer control numbers', () => {
	it('pins the defaults the arbiter, the relay and the surface share', () => {
		expect(COMPUTER_CONTROL_IDLE_MS_DEFAULT).toBe(10 * 60_000);
		expect(COMPUTER_CONTROL_IDLE_WARNING_MS).toBe(30_000);
		expect(COMPUTER_CONTROL_CEILING_MS_DEFAULT).toBe(60 * 60_000);
		expect(COMPUTER_CONTROL_DISCONNECT_MS).toBe(30_000);
		expect(COMPUTER_CONTROL_REQUEST_TIMEOUT_MS).toBe(60_000);
	});

	it('is reachable from the package root', () => {
		expect(contracts.COMPUTER_CONTROL_REQUEST_TIMEOUT_MS).toBe(COMPUTER_CONTROL_REQUEST_TIMEOUT_MS);
		expect(contracts.isComputerControlRefusal).toBe(isComputerControlRefusal);
	});
});

describe('computer control guards', () => {
	it('accepts exactly the closed sets and nothing else', () => {
		for (const role of COMPUTER_VIEWER_ROLES) expect(isComputerViewerRole(role)).toBe(true);
		for (const refusal of COMPUTER_CONTROL_REFUSALS) expect(isComputerControlRefusal(refusal)).toBe(true);
		for (const decision of COMPUTER_CONTROL_DECISIONS) expect(isComputerControlDecision(decision)).toBe(true);
		for (const junk of ['', 'OWNER', 'admin', null, undefined, 1, {}, ['owner']]) {
			expect(isComputerViewerRole(junk)).toBe(false);
			expect(isComputerControlRefusal(junk)).toBe(false);
			expect(isComputerControlDecision(junk)).toBe(false);
		}
	});

	it('lists the refusals the surface renders, including the hand-over ones', () => {
		expect([...COMPUTER_CONTROL_REFUSALS]).toEqual([
			'policy',
			'held',
			'not-live',
			'session-ended',
			'not-holder',
			'not-held',
			'already-requested',
			'no-request',
			'already-extended'
		]);
		expect([...COMPUTER_CONTROL_DECISIONS]).toEqual(['hand-over', 'keep']);
	});
});

describe('isComputerShortcutBlocked', () => {
	const ALT = 1;
	const CTRL = 2;
	const META = 4;
	const SHIFT = 8;

	it('blocks clipboard, window and tab combinations with Ctrl or ⌘, by physical key', () => {
		for (const code of ['KeyC', 'KeyX', 'KeyV', 'KeyW', 'KeyT', 'KeyN', 'KeyQ']) {
			expect(isComputerShortcutBlocked({ code, modifiers: CTRL })).toBe(true);
			expect(isComputerShortcutBlocked({ code, modifiers: META | SHIFT })).toBe(true);
			// The same key on its own, or with Shift, is ordinary typing.
			expect(isComputerShortcutBlocked({ code, modifiers: 0 })).toBe(false);
			expect(isComputerShortcutBlocked({ code, modifiers: SHIFT })).toBe(false);
		}
	});

	it('blocks switching windows, closing them, and the operating system keys', () => {
		expect(isComputerShortcutBlocked({ code: 'Tab', modifiers: ALT })).toBe(true);
		expect(isComputerShortcutBlocked({ code: 'Tab', modifiers: CTRL })).toBe(true);
		expect(isComputerShortcutBlocked({ code: 'Tab', modifiers: 0 })).toBe(false);
		expect(isComputerShortcutBlocked({ code: 'F4', modifiers: ALT })).toBe(true);
		expect(isComputerShortcutBlocked({ code: 'Delete', modifiers: CTRL | ALT })).toBe(true);
		expect(isComputerShortcutBlocked({ code: 'Delete', modifiers: 0 })).toBe(false);
		// Ctrl+Delete (delete a word) is editing, not the operating system.
		expect(isComputerShortcutBlocked({ code: 'Delete', modifiers: CTRL })).toBe(false);
		expect(isComputerShortcutBlocked({ code: 'F4', modifiers: 0 })).toBe(false);
		expect(isComputerShortcutBlocked({ code: 'MetaLeft', modifiers: 0 })).toBe(true);
	});

	it('lets ordinary keys through and never throws on junk', () => {
		expect(isComputerShortcutBlocked({ code: 'KeyA', modifiers: CTRL })).toBe(false);
		expect(isComputerShortcutBlocked({ code: 'Enter', modifiers: 0 })).toBe(false);
		expect(isComputerShortcutBlocked({})).toBe(false);
		expect(isComputerShortcutBlocked(null as never)).toBe(false);
		expect(COMPUTER_BLOCKED_SHORTCUTS.every((shortcut) => shortcut.label.length > 0)).toBe(true);
	});
});
