import { describe, expect, it } from 'vitest';

import * as connections from '../index.js';
import {
	CONNECTION_CREDENTIAL_ERROR_CODES,
	CONNECTION_HEALTH_ERROR_CODES,
	CONNECTION_HEALTH_STATES,
	CONNECTION_UNREACHABLE_AFTER_FAILURES,
	connectionHealthNeedsAttention,
	isConnectionHealth,
	isConnectionHealthErrorCode
} from '../connection-health.types.js';

describe('connection health vocabulary', () => {
	it('has exactly the five states', () => {
		expect(CONNECTION_HEALTH_STATES).toEqual(['unknown', 'healthy', 'degraded', 'expired', 'unreachable']);
	});

	it('guards take unknown input', () => {
		expect(isConnectionHealth('healthy')).toBe(true);
		expect(isConnectionHealth('blocked')).toBe(false);
		expect(isConnectionHealth(undefined)).toBe(false);
		expect(isConnectionHealthErrorCode('credential_missing')).toBe(true);
		expect(isConnectionHealthErrorCode('401')).toBe(false);
	});

	it('only credential problems are credential codes', () => {
		for (const code of CONNECTION_CREDENTIAL_ERROR_CODES) {
			expect(CONNECTION_HEALTH_ERROR_CODES).toContain(code);
		}
		expect(CONNECTION_CREDENTIAL_ERROR_CODES).not.toContain('timeout');
		expect(CONNECTION_UNREACHABLE_AFTER_FAILURES).toBe(3);
	});

	it('expired and unreachable need attention; the rest do not', () => {
		expect(connectionHealthNeedsAttention('expired')).toBe(true);
		expect(connectionHealthNeedsAttention('unreachable')).toBe(true);
		expect(connectionHealthNeedsAttention('degraded')).toBe(false);
		expect(connectionHealthNeedsAttention('unknown')).toBe(false);
		expect(connectionHealthNeedsAttention(null)).toBe(false);
	});

	it('the barrel surfaces the runtime exports', () => {
		for (const name of [
			'CONNECTION_HEALTH_STATES',
			'CONNECTION_SCOPE_PRESET_ORDER',
			'applyConnectionScopePresetToToolGrant',
			'resolveEffectiveConnectionScopePreset',
			'normalizeConnectionScopePresets'
		]) {
			expect(connections).toHaveProperty(name);
		}
	});
});
