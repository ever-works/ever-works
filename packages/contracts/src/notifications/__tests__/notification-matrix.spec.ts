import { describe, expect, it } from 'vitest';

import * as root from '../../index.js';
import {
	ATTENTION_TARGET_CLASSES,
	NOTIFICATION_BUILT_IN_TARGETS,
	NOTIFICATION_MATRIX_GROUPS,
	NOTIFICATION_MATRIX_MAX_COLUMNS,
	NOTIFICATION_MATRIX_MAX_TARGETS,
	NOTIFICATION_TARGET_EMAIL,
	NOTIFICATION_TARGET_IN_APP
} from '../index.js';

describe('notifications contracts', () => {
	it('reaches consumers through the package root', () => {
		expect(root.NOTIFICATION_TARGET_EMAIL).toBe('email');
		expect(root.NOTIFICATION_TARGET_IN_APP).toBe('in-app');
		expect(root.NOTIFICATION_MATRIX_GROUPS).toBe(NOTIFICATION_MATRIX_GROUPS);
		expect(root.ATTENTION_TARGET_CLASSES).toBe(ATTENTION_TARGET_CLASSES);
	});

	it('lists the built-in targets in column order, in-app first', () => {
		expect(NOTIFICATION_BUILT_IN_TARGETS).toEqual([NOTIFICATION_TARGET_IN_APP, NOTIFICATION_TARGET_EMAIL]);
	});

	it('renders the four groups in the order the page reads them', () => {
		expect(NOTIFICATION_MATRIX_GROUPS).toEqual(['needsYou', 'signals', 'routine', 'digest']);
	});

	it('pins the limits the API enforces', () => {
		expect(NOTIFICATION_MATRIX_MAX_TARGETS).toBe(20);
		expect(NOTIFICATION_MATRIX_MAX_COLUMNS).toBe(6);
	});

	it('never budgets in-app', () => {
		expect(ATTENTION_TARGET_CLASSES).toEqual(['email', 'channel']);
		expect(ATTENTION_TARGET_CLASSES as readonly string[]).not.toContain('in-app');
	});
});
