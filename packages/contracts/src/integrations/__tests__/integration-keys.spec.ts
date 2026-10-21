import { describe, expect, it } from 'vitest';
import { FLEET_RUN_TOKEN_PREFIX, PERSONAL_API_KEY_KIND } from '../../fleet/fleet-run-credential.types.js';
import {
	EVER_GAUZY_PRESET_SCOPES,
	INTEGRATION_API_KEY_KIND,
	INTEGRATION_ERROR_CODES,
	INTEGRATION_KEY_PRESETS,
	INTEGRATION_KEY_PREFIX,
	INTEGRATION_MERGE_DECISION_SCOPE,
	INTEGRATION_OPT_IN_SCOPES,
	INTEGRATION_SCOPES,
	integrationActorLabel,
	isIntegrationKind,
	isIntegrationScope
} from '../integration-keys.types.js';

/**
 * EW-P1-2 — the integration-key vocabulary shared by the API guards, the
 * settings dialog and the integration contract (plan doc 02 §2–3).
 */
describe('integration keys — vocabulary v1', () => {
	it('uses a prefix distinct from ew_live_ and ew_run_ that fits the 12-char fingerprint', () => {
		expect(INTEGRATION_KEY_PREFIX).toBe('ew_int_');
		for (const other of ['ew_live_', FLEET_RUN_TOKEN_PREFIX]) {
			expect(INTEGRATION_KEY_PREFIX.startsWith(other)).toBe(false);
			expect(other.startsWith(INTEGRATION_KEY_PREFIX)).toBe(false);
		}
		expect(INTEGRATION_KEY_PREFIX.length + 4).toBeLessThanOrEqual(12);
		expect(INTEGRATION_API_KEY_KIND).not.toBe(PERSONAL_API_KEY_KIND);
	});

	it('has 27 unique scopes and never grants activation or build', () => {
		expect(new Set(INTEGRATION_SCOPES).size).toBe(INTEGRATION_SCOPES.length);
		expect(INTEGRATION_SCOPES).toHaveLength(27);
		for (const forbidden of ['goals:activate', 'missions:activate', 'ideas:build']) {
			expect(isIntegrationScope(forbidden)).toBe(false);
		}
		for (const scope of INTEGRATION_SCOPES) {
			expect(scope).toMatch(/^[a-z]+:(read|write|manage|decide)$/);
		}
	});

	it('the Ever Gauzy preset is every scope except the opt-in org:write, email:write and merges:decide', () => {
		expect(INTEGRATION_OPT_IN_SCOPES).toEqual(['org:write', 'email:write', 'merges:decide']);
		expect(EVER_GAUZY_PRESET_SCOPES).toHaveLength(INTEGRATION_SCOPES.length - 3);
		expect(EVER_GAUZY_PRESET_SCOPES).not.toContain('org:write');
		expect(EVER_GAUZY_PRESET_SCOPES).not.toContain('email:write');
		// Works-security lane 3a — relaying a MERGE decision is never granted by default.
		expect(EVER_GAUZY_PRESET_SCOPES).not.toContain(INTEGRATION_MERGE_DECISION_SCOPE);
		expect(INTEGRATION_MERGE_DECISION_SCOPE).toBe('merges:decide');
		expect(EVER_GAUZY_PRESET_SCOPES).toContain('tasks:write');
		expect(INTEGRATION_KEY_PRESETS['ever-gauzy']).toEqual({
			integrationKind: 'ever-gauzy',
			scopes: EVER_GAUZY_PRESET_SCOPES
		});
	});

	it('guards kinds and scopes by value', () => {
		expect(isIntegrationKind('ever-gauzy')).toBe(true);
		expect(isIntegrationKind('generic')).toBe(true);
		expect(isIntegrationKind('gauzy')).toBe(false);
		expect(isIntegrationScope('tasks:read')).toBe(true);
		expect(isIntegrationScope(42)).toBe(false);
	});

	it('labels the actor the way activity rows and records show it', () => {
		expect(integrationActorLabel('ever-gauzy', 'Acme')).toBe('Ever Gauzy (Acme)');
		expect(integrationActorLabel('generic', 'CRM sync')).toBe('Integration (CRM sync)');
		expect(integrationActorLabel(null, 'x'.repeat(200))).toHaveLength(120);
	});

	it('lists the contract v1 error codes', () => {
		for (const code of ['invalid_key', 'scope_missing', 'org_not_pinned', 'act_as_forbidden', 'rate_limited']) {
			expect(INTEGRATION_ERROR_CODES).toContain(code);
		}
	});
});
