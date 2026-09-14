import { describe, expect, it } from 'vitest';

import * as connections from '../index.js';
import {
	CONNECTION_CREDENTIAL_ERROR_CODES,
	CONNECTION_HEALTH_ERROR_CODES,
	CONNECTION_HEALTH_STATES,
	CONNECTION_HEALTH_WARNING_CODES,
	CONNECTION_UNREACHABLE_AFTER_FAILURES,
	connectionHealthIsWarning,
	connectionHealthNeedsAttention,
	isConnectionHealth,
	isConnectionHealthErrorCode
} from '../connection-health.types.js';

describe('connection health vocabulary', () => {
	it('has exactly the five failure-or-success states plus the insecure-transport warning', () => {
		expect(CONNECTION_HEALTH_STATES).toEqual([
			'unknown',
			'healthy',
			'degraded',
			'expired',
			'unreachable',
			'insecure_transport'
		]);
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

	it('a refused credential transport is a credential code; sending over plain http is only a warning', () => {
		expect(CONNECTION_CREDENTIAL_ERROR_CODES).toContain('https_required');
		expect(CONNECTION_CREDENTIAL_ERROR_CODES).not.toContain('insecure_transport');
		expect(CONNECTION_HEALTH_WARNING_CODES).toEqual(['insecure_transport']);
		for (const code of CONNECTION_HEALTH_WARNING_CODES) {
			expect(CONNECTION_HEALTH_ERROR_CODES).toContain(code);
			expect(CONNECTION_CREDENTIAL_ERROR_CODES).not.toContain(code);
		}
	});

	it('insecure_transport is a warning that never needs the attention banner', () => {
		expect(isConnectionHealth('insecure_transport')).toBe(true);
		expect(connectionHealthIsWarning('insecure_transport')).toBe(true);
		expect(connectionHealthNeedsAttention('insecure_transport')).toBe(false);
		expect(connectionHealthIsWarning('expired')).toBe(false);
		expect(connectionHealthIsWarning(null)).toBe(false);
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
			'CONNECTION_HEALTH_WARNING_CODES',
			'CONNECTION_SCOPE_PRESET_ORDER',
			'applyConnectionScopePresetWithOwnership',
			'assessCredentialTransport',
			'sanitizeOrganizationConnectionPolicy',
			'applyConnectionScopePresetToToolGrant',
			'resolveEffectiveConnectionScopePreset',
			'normalizeConnectionScopePresets'
		]) {
			expect(connections).toHaveProperty(name);
		}
	});
});
