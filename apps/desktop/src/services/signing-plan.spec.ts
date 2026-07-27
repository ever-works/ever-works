import { describe, expect, it } from 'vitest';
import {
	SIGNING_ENV_VARS,
	describeSigningPlan,
	platformToTargetOs,
	resolveSigningPlan,
	type SigningPlan
} from './signing-plan';

const WIN_SECRETS = {
	[SIGNING_ENV_VARS.windowsCertificate]: 'base64-cert-content',
	[SIGNING_ENV_VARS.windowsCertificatePassword]: 'pw'
};

const MAC_SECRETS = {
	[SIGNING_ENV_VARS.macCertificate]: 'base64-cert-content',
	[SIGNING_ENV_VARS.macCertificatePassword]: 'pw'
};

const NOTARIZE_SECRETS = {
	[SIGNING_ENV_VARS.appleId]: 'releases@example.com',
	[SIGNING_ENV_VARS.appleAppSpecificPassword]: 'abcd-efgh-ijkl-mnop',
	[SIGNING_ENV_VARS.appleTeamId]: 'TEAM123456'
};

/** No plan may ever echo a secret VALUE into its human-facing strings. */
function assertNoSecretLeak(plan: SigningPlan): void {
	const text = [plan.warning ?? '', describeSigningPlan(plan), ...plan.configArgs, ...plan.missing].join(' ');
	for (const secret of ['base64-cert-content', 'pw', 'abcd-efgh-ijkl-mnop', 'releases@example.com']) {
		expect(text).not.toContain(secret);
	}
}

describe('platformToTargetOs', () => {
	it('maps node platforms to packaging targets', () => {
		expect(platformToTargetOs('win32')).toBe('win');
		expect(platformToTargetOs('darwin')).toBe('mac');
		expect(platformToTargetOs('linux')).toBe('linux');
		expect(platformToTargetOs('freebsd')).toBe('linux');
	});
});

describe('resolveSigningPlan — Windows', () => {
	it('signs when both certificate secrets are present', () => {
		const plan = resolveSigningPlan('win', WIN_SECRETS);
		expect(plan.signed).toBe(true);
		expect(plan.env.WIN_CSC_LINK).toBe('base64-cert-content');
		expect(plan.env.WIN_CSC_KEY_PASSWORD).toBe('pw');
		expect(plan.warning).toBeUndefined();
		assertNoSecretLeak(plan);
	});

	it('degrades to an unsigned build with a loud warning when secrets are absent', () => {
		const plan = resolveSigningPlan('win', {});
		expect(plan.signed).toBe(false);
		expect(plan.missing).toEqual([
			SIGNING_ENV_VARS.windowsCertificate,
			SIGNING_ENV_VARS.windowsCertificatePassword
		]);
		expect(plan.warning).toContain('UNSIGNED BUILD (win)');
		expect(plan.warning).toContain(SIGNING_ENV_VARS.windowsCertificate);
		// Never let a certificate that happens to sit in the build machine's
		// store get picked up implicitly.
		expect(plan.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
		assertNoSecretLeak(plan);
	});

	it('treats a blank secret as absent (empty repository secret on a fork)', () => {
		const plan = resolveSigningPlan('win', { ...WIN_SECRETS, [SIGNING_ENV_VARS.windowsCertificate]: '   ' });
		expect(plan.signed).toBe(false);
		expect(plan.missing).toEqual([SIGNING_ENV_VARS.windowsCertificate]);
	});
});

describe('resolveSigningPlan — macOS', () => {
	it('signs and notarizes with the full secret set', () => {
		const plan = resolveSigningPlan('mac', { ...MAC_SECRETS, ...NOTARIZE_SECRETS });
		expect(plan.signed).toBe(true);
		expect(plan.notarize).toBe(true);
		expect(plan.configArgs).toEqual(['-c.mac.notarize=true']);
		expect(plan.env.CSC_LINK).toBe('base64-cert-content');
		expect(plan.env.APPLE_TEAM_ID).toBe('TEAM123456');
		expect(plan.warning).toBeUndefined();
		assertNoSecretLeak(plan);
	});

	it('signs without notarizing when the Apple credentials are missing, and says so', () => {
		const plan = resolveSigningPlan('mac', MAC_SECRETS);
		expect(plan.signed).toBe(true);
		expect(plan.notarize).toBe(false);
		expect(plan.configArgs).toEqual(['-c.mac.notarize=false']);
		expect(plan.env.APPLE_ID).toBeUndefined();
		expect(plan.warning).toContain('SIGNED BUT NOT NOTARIZED');
		expect(plan.missing).toEqual([
			SIGNING_ENV_VARS.appleId,
			SIGNING_ENV_VARS.appleAppSpecificPassword,
			SIGNING_ENV_VARS.appleTeamId
		]);
		assertNoSecretLeak(plan);
	});

	it('degrades to unsigned (notarization forced off) without a certificate', () => {
		const plan = resolveSigningPlan('mac', NOTARIZE_SECRETS);
		expect(plan.signed).toBe(false);
		expect(plan.notarize).toBe(false);
		expect(plan.configArgs).toEqual(['-c.mac.notarize=false']);
		expect(plan.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
		expect(plan.warning).toContain('UNSIGNED BUILD (mac)');
		assertNoSecretLeak(plan);
	});
});

describe('resolveSigningPlan — Linux', () => {
	it('is unsigned by design and never warns', () => {
		const plan = resolveSigningPlan('linux', { ...WIN_SECRETS, ...MAC_SECRETS });
		expect(plan.supported).toBe(false);
		expect(plan.signed).toBe(false);
		expect(plan.warning).toBeUndefined();
		expect(plan.env).toEqual({});
		expect(describeSigningPlan(plan)).toContain('does not apply');
	});
});

describe('describeSigningPlan', () => {
	it('summarizes each outcome without leaking values', () => {
		expect(describeSigningPlan(resolveSigningPlan('win', WIN_SECRETS))).toBe(
			'[win] signing: ENABLED, notarization: DISABLED.'
		);
		expect(describeSigningPlan(resolveSigningPlan('mac', { ...MAC_SECRETS, ...NOTARIZE_SECRETS }))).toBe(
			'[mac] signing: ENABLED, notarization: ENABLED.'
		);
		expect(describeSigningPlan(resolveSigningPlan('win', {}))).toBe(
			'[win] signing: DISABLED (degraded to an unsigned build).'
		);
	});
});
