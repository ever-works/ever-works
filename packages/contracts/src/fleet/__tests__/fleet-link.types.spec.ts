import { describe, expect, it } from 'vitest';
import {
	FLEET_CONSENT_KEYS,
	FLEET_LINK_ACTION_FAMILIES,
	FLEET_LINK_BACKOFF_BASE_MS,
	FLEET_LINK_BACKOFF_MAX_MS,
	FLEET_LINK_ERROR_CODES,
	FLEET_LINK_ERROR_HTTP_STATUS,
	FLEET_LINK_FAMILIES,
	FLEET_LINK_FAMILY_ACTION_FAMILY,
	FLEET_LINK_FAMILY_CONSENT,
	FLEET_LINK_FRAME_KINDS,
	FLEET_LINK_MAX_CHANNELS,
	FLEET_LINK_MAX_FRAME_BYTES,
	FLEET_LINK_PING_INTERVAL_MS,
	FLEET_LINK_SILENCE_MS,
	FLEET_LINK_STATE_CHANGING_FAMILIES,
	FLEET_LINK_TOKEN_TTL_SEC,
	FLEET_NO_CONSENTS,
	FLEET_OPERATION_RETENTION_MS,
	effectiveConsents,
	fleetConsentMissingHint,
	fleetConsentSatisfies,
	fleetConsentsDiffer,
	fleetLinkChannelOpenConsent,
	fleetLinkMachineVerbActionFamily,
	fleetLinkVerbConsent,
	FLEET_LINK_VERB_CONSENT_OVERRIDES,
	isFleetLinkEligible,
	isFleetLinkStateChangingFamily,
	isFleetLinkVerb,
	normalizeFleetConsents,
	isFleetLinkActionFamily
} from '../fleet-link.types.js';
import { FLEET_ACTION_FAMILIES } from '../fleet-access.types.js';

describe('fleet link constants match CONTRACTS §10', () => {
	it('fixes the frame, channel, ping, silence, backoff and token numbers', () => {
		expect(FLEET_LINK_MAX_FRAME_BYTES).toBe(16 * 1024 * 1024);
		expect(FLEET_LINK_MAX_CHANNELS).toBe(64);
		expect(FLEET_LINK_PING_INTERVAL_MS).toBe(15_000);
		expect(FLEET_LINK_SILENCE_MS).toBe(45_000);
		expect(FLEET_LINK_BACKOFF_BASE_MS).toBe(1_000);
		expect(FLEET_LINK_BACKOFF_MAX_MS).toBe(30_000);
		expect(FLEET_LINK_TOKEN_TTL_SEC).toBe(300);
		expect(FLEET_OPERATION_RETENTION_MS).toBe(60 * 60_000);
	});

	it('numbers the frame kinds exactly as CONTRACTS §3.2', () => {
		expect(FLEET_LINK_FRAME_KINDS).toEqual({
			DATA: 1,
			RESIZE: 2,
			EXIT: 3,
			JSON: 10,
			CLOSE: 11,
			FRAME: 20,
			INPUT: 21,
			TILES: 23,
			ACK: 30,
			END: 31,
			CLIP: 40
		});
	});
});

describe('channel families', () => {
	it('lists the nine families of CONTRACTS §3.3', () => {
		expect([...FLEET_LINK_FAMILIES].sort()).toEqual(
			['clip', 'command', 'desktop', 'files', 'logs', 'machine', 'schedule', 'session', 'tunnel'].sort()
		);
	});

	it("names the Fleet hub's action families, not a copy of them", () => {
		// One list for the hub's policy and the link's authorisation: a family
		// FL-01 adds is one the link can be asked about the same day.
		expect(FLEET_LINK_ACTION_FAMILIES).toBe(FLEET_ACTION_FAMILIES);
		for (const family of FLEET_ACTION_FAMILIES) expect(isFleetLinkActionFamily(family)).toBe(true);
		expect(isFleetLinkActionFamily('constructor')).toBe(false);
		expect(isFleetLinkActionFamily('lifecycle')).toBe(false);
	});

	it('gives every family a consent requirement and an action family', () => {
		for (const family of FLEET_LINK_FAMILIES) {
			expect(FLEET_LINK_FAMILY_CONSENT[family]).toBeDefined();
			expect(FLEET_LINK_ACTION_FAMILIES).toContain(FLEET_LINK_FAMILY_ACTION_FAMILY[family]);
		}
	});

	it('needs manage for every machine-management family and attend for watching', () => {
		expect(FLEET_LINK_FAMILY_CONSENT.logs).toBe('manage');
		expect(FLEET_LINK_FAMILY_CONSENT.files).toBe('manage');
		expect(FLEET_LINK_FAMILY_CONSENT.command).toBe('manage');
		expect(FLEET_LINK_FAMILY_CONSENT.schedule).toBe('manage');
		expect(FLEET_LINK_FAMILY_CONSENT.tunnel).toBe('manage');
		expect(FLEET_LINK_FAMILY_CONSENT.desktop).toBe('attend');
		expect(FLEET_LINK_FAMILY_CONSENT.clip).toBe('attend');
		expect(FLEET_LINK_FAMILY_CONSENT.session).toBe('work-or-manage');
		expect(FLEET_LINK_FAMILY_CONSENT.machine).toBe('manage');
	});

	it('keeps the per-verb exceptions in one table: health.now on any link, every other verb manage (R-31)', () => {
		expect(FLEET_LINK_VERB_CONSENT_OVERRIDES).toEqual({ 'health.now': 'link' });
		expect(fleetLinkVerbConsent('health.now')).toBe('link');
		expect(fleetLinkVerbConsent('services.list')).toBe('manage');
		expect(fleetLinkVerbConsent('constructor')).toBe('manage');
		expect(fleetLinkVerbConsent('__proto__')).toBe('manage');
		// So the machine channel itself opens on any link; every other family needs its own consent to open.
		expect(fleetLinkChannelOpenConsent('machine')).toBe('link');
		expect(fleetLinkChannelOpenConsent('logs')).toBe('manage');
		expect(fleetLinkChannelOpenConsent('desktop')).toBe('attend');
	});

	it('audits a command channel on open and never a logs channel (ACC-FL02-11)', () => {
		expect(isFleetLinkStateChangingFamily('command')).toBe(true);
		expect(isFleetLinkStateChangingFamily('logs')).toBe(false);
		expect(isFleetLinkStateChangingFamily('machine')).toBe(false);
		expect(FLEET_LINK_STATE_CHANGING_FAMILIES).not.toContain('desktop');
	});

	it('maps machine verbs to the CONTRACTS §2.1 action families, strictest by default', () => {
		expect(fleetLinkMachineVerbActionFamily('health.now')).toBe('view');
		expect(fleetLinkMachineVerbActionFamily('ports.list')).toBe('view');
		expect(fleetLinkMachineVerbActionFamily('ports.open')).toBe('ports');
		expect(fleetLinkMachineVerbActionFamily('services.action')).toBe('services');
		expect(fleetLinkMachineVerbActionFamily('docker.container.start')).toBe('docker');
		expect(fleetLinkMachineVerbActionFamily('compose.up')).toBe('docker');
		expect(fleetLinkMachineVerbActionFamily('git.setIdentity')).toBe('commands');
		expect(fleetLinkMachineVerbActionFamily('wake.send')).toBe('machines');
		expect(fleetLinkMachineVerbActionFamily('something.new')).toBe('machines');
		expect(fleetLinkMachineVerbActionFamily('logs.sources')).toBe('logs');
		// Never a prototype key.
		expect(fleetLinkMachineVerbActionFamily('constructor')).toBe('machines');
		expect(fleetLinkMachineVerbActionFamily('toString.x')).toBe('machines');
	});

	it('accepts dotted lower-camel verbs only', () => {
		expect(isFleetLinkVerb('health.now')).toBe(true);
		expect(isFleetLinkVerb('docker.container.start')).toBe(true);
		expect(isFleetLinkVerb('Health.now')).toBe(false);
		expect(isFleetLinkVerb('health..now')).toBe(false);
		expect(isFleetLinkVerb('__proto__')).toBe(false);
		expect(isFleetLinkVerb('a'.repeat(40))).toBe(false);
	});
});

describe('consents', () => {
	it('lists the four consents of CONTRACTS §1.1', () => {
		expect(FLEET_CONSENT_KEYS).toEqual(['work', 'attend', 'manage', 'usageScan']);
	});

	it('normalizes only literal true; null for a non-object', () => {
		expect(normalizeFleetConsents(null)).toBeNull();
		expect(normalizeFleetConsents('yes')).toBeNull();
		expect(normalizeFleetConsents([true])).toBeNull();
		expect(normalizeFleetConsents({ work: 'true', manage: 1, attend: true })).toEqual({
			work: false,
			attend: true,
			manage: false,
			usageScan: false
		});
	});

	describe('effectiveConsents', () => {
		it('takes a reported set at its word', () => {
			expect(
				effectiveConsents({
					consents: { work: false, attend: false, manage: true, usageScan: true },
					capabilities: ['attended'],
					workerState: 'idle'
				})
			).toEqual({ work: false, attend: false, manage: true, usageScan: true });
		});

		it('infers work and attend for a daemon older than the field, and never manage (U12)', () => {
			expect(
				effectiveConsents({ consents: null, capabilities: ['attended', 'managed'], workerState: 'idle' })
			).toEqual({ work: true, attend: true, manage: false, usageScan: false });
		});

		it('reads a partial set as the keys it carried', () => {
			expect(effectiveConsents({ consents: { manage: true } })).toEqual({
				work: false,
				attend: false,
				manage: true,
				usageScan: false
			});
		});

		it('answers nothing for no node and for an undescribed node', () => {
			expect(effectiveConsents(null)).toEqual(FLEET_NO_CONSENTS);
			expect(effectiveConsents({})).toEqual(FLEET_NO_CONSENTS);
		});
	});

	it('opens the link for work, attend or manage — never for usage-scan alone', () => {
		expect(isFleetLinkEligible({ ...FLEET_NO_CONSENTS })).toBe(false);
		expect(isFleetLinkEligible({ ...FLEET_NO_CONSENTS, usageScan: true })).toBe(false);
		expect(isFleetLinkEligible({ ...FLEET_NO_CONSENTS, work: true })).toBe(true);
		expect(isFleetLinkEligible({ ...FLEET_NO_CONSENTS, attend: true })).toBe(true);
		expect(isFleetLinkEligible({ ...FLEET_NO_CONSENTS, manage: true })).toBe(true);
		expect(isFleetLinkEligible(null)).toBe(false);
	});

	it('checks each requirement against the right consent', () => {
		const workOnly = { ...FLEET_NO_CONSENTS, work: true };
		expect(fleetConsentSatisfies(workOnly, 'manage')).toBe(false);
		expect(fleetConsentSatisfies(workOnly, 'work')).toBe(true);
		expect(fleetConsentSatisfies(workOnly, 'work-or-manage')).toBe(true);
		expect(fleetConsentSatisfies(workOnly, 'attend')).toBe(false);
		expect(fleetConsentSatisfies(workOnly, 'link')).toBe(true);
		expect(fleetConsentSatisfies({ ...FLEET_NO_CONSENTS, manage: true }, 'work-or-manage')).toBe(true);
		expect(fleetConsentSatisfies(FLEET_NO_CONSENTS, 'link')).toBe(false);
		expect(fleetConsentSatisfies(null, 'link')).toBe(false);
	});

	it('names the flag to run in the consent_missing hint (spec S4)', () => {
		expect(fleetConsentMissingHint('manage', 'build-01')).toBe('start the node with --manage on build-01');
		expect(fleetConsentMissingHint('work-or-manage', 'build-01')).toBe(
			'start the node with --work or --manage on build-01'
		);
		expect(fleetConsentMissingHint('link', 'build-01')).toBe(
			'start the node with --work, --attend or --manage on build-01'
		);
	});

	it('tells a changed consent set from an unchanged one', () => {
		const a = { work: true, attend: false, manage: true, usageScan: false };
		expect(fleetConsentsDiffer(a, { ...a })).toBe(false);
		expect(fleetConsentsDiffer(a, { ...a, manage: false })).toBe(true);
		expect(fleetConsentsDiffer(null, a)).toBe(true);
		expect(fleetConsentsDiffer(null, null)).toBe(false);
	});
});

describe('error codes', () => {
	it('carries every CONTRACTS §8 code plus resume_failed, each with an HTTP status', () => {
		expect(FLEET_LINK_ERROR_CODES).toEqual(
			expect.arrayContaining([
				'not_found',
				'invalid',
				'unreachable',
				'consent_missing',
				'permission_denied',
				'confirmation_required',
				'root_required',
				'kill_switch',
				'limit_exceeded',
				'unsupported_on_node',
				'busy',
				'operation_failed',
				'internal',
				'resume_failed'
			])
		);
		for (const code of FLEET_LINK_ERROR_CODES) {
			expect(FLEET_LINK_ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
		}
		expect(FLEET_LINK_ERROR_HTTP_STATUS.kill_switch).toBe(423);
		expect(FLEET_LINK_ERROR_HTTP_STATUS.consent_missing).toBe(409);
		expect(FLEET_LINK_ERROR_HTTP_STATUS.permission_denied).toBe(403);
		expect(FLEET_LINK_ERROR_HTTP_STATUS.unreachable).toBe(503);
		expect(FLEET_LINK_ERROR_HTTP_STATUS.limit_exceeded).toBe(429);
		expect(FLEET_LINK_ERROR_HTTP_STATUS.unsupported_on_node).toBe(422);
	});
});
