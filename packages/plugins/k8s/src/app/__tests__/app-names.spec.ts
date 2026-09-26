/**
 * T4 — `app-names.ts` (plan §4.1, spec FR-38/FR-40/FR-41).
 *
 * Every pin the task line asks for:
 * - the 63-character cap on every name this module can produce,
 * - slug truncation at 30,
 * - a deterministic 8-hex suffix (same input → same name, different input → different suffix),
 * - the verification suffix `-v<first 6 hex of provisioningId>-<attempt ≤ 9>` staying ≤ 63 characters
 *   and ≤ 52 in practice, deterministic, and distinct for two provisionings (APW06-G09),
 * - labels that never contain `ever-works.io/managed` or `app.kubernetes.io/name` (plan §1.2 #6),
 * - Job name ≤ 45 and CronJob name ≤ 37 for a 32-character `Name`.
 *
 * No clock, no I/O, no fixtures from a live cluster: RFC 2606 hosts only.
 */
import { describe, expect, it } from 'vitest';

import {
	APP_BASELINE_NETWORK_POLICY_NAMES,
	APP_CRONJOB_NAME_MAX_LENGTH,
	APP_DEPLOYMENT_NETWORK_POLICY_NAMES,
	APP_FORBIDDEN_LABEL_KEYS,
	APP_JOB_NAME_MAX_LENGTH,
	APP_NAME_MAX_LENGTH,
	APP_NAMESPACE_MAX_LENGTH,
	APP_SLUG_MAX_LENGTH,
	APP_VERIFICATION_MAX_ATTEMPT,
	APP_VERIFICATION_NAMESPACE_MAX_LENGTH,
	appLabels,
	appNamespaceName,
	componentObjectName,
	componentSelector,
	cronJobName,
	dependencyNetworkPolicyName,
	envSecretName,
	hexSuffix,
	internalUrl,
	jobName,
	manualJobName,
	namespaceAnnotations,
	namespaceLabels,
	platformConfigMapName,
	previewNamespaceName,
	pullSecretName,
	pvcLabels,
	pvcName,
	runnerConfigMapName,
	serviceAccountName,
	verificationNamespaceName
} from '../app-names';

/** RFC 1123 DNS label — what Kubernetes accepts for a namespace or object name. */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const WORK_ID = '3f2a9c1e-8b47-4d05-9a11-0c6e5b2d7f30';
const OTHER_WORK_ID = 'a1b2c3d4-1111-2222-3333-444455556666';
const PROVISIONING_ID = '4f3a2b1c-9d8e-4f70-8123-abcdef012345';
const OTHER_PROVISIONING_ID = '9c8b7a65-4321-4fed-8abc-0123456789ab';
const SLUG = 'cal-diy';
const LIVE_NAMESPACE = 'ew-cal-diy-3f2a9c1e';
/** The longest `Name` APW-03 schema §0 allows. */
const NAME_32 = 'c'.repeat(32);
const LONGEST_SLUG = 's'.repeat(120);

describe('appNamespaceName', () => {
	it('renders `ew-<slug>-<first 8 hex of workId>`', () => {
		expect(appNamespaceName(SLUG, WORK_ID)).toBe(LIVE_NAMESPACE);
		expect(appNamespaceName(SLUG, WORK_ID).endsWith(WORK_ID.slice(0, 8))).toBe(true);
	});

	it('keeps every namespace within the 63-character cap', () => {
		const candidates = [
			appNamespaceName(LONGEST_SLUG, WORK_ID),
			appNamespaceName(LONGEST_SLUG, 'f'.repeat(64)),
			appNamespaceName(SLUG, 'not-a-uuid-at-all'),
			appNamespaceName('', WORK_ID)
		];

		for (const name of candidates) {
			expect(name.length).toBeLessThanOrEqual(APP_NAME_MAX_LENGTH);
			expect(name.length).toBeLessThanOrEqual(APP_NAMESPACE_MAX_LENGTH);
			expect(name).toMatch(DNS_LABEL);
		}
	});

	it('truncates the slug at 30 characters', () => {
		const name = appNamespaceName(LONGEST_SLUG, WORK_ID);
		const [, slugPart] = name.split('-');

		expect(APP_SLUG_MAX_LENGTH).toBe(30);
		expect(slugPart).toHaveLength(30);
		expect(slugPart).toBe('s'.repeat(30));
		expect(name).toBe(`ew-${'s'.repeat(30)}-3f2a9c1e`);
	});

	it('never leaves a trailing hyphen after truncating a slug', () => {
		// 30 characters of `a-` pairs would end on the truncation boundary.
		const name = appNamespaceName('a-'.repeat(20), WORK_ID);

		expect(name).toMatch(DNS_LABEL);
		expect(name).not.toContain('--');
		expect(name).not.toMatch(/-$/);
	});

	it('sanitises a human slug and falls back when nothing is left', () => {
		expect(appNamespaceName('My  Site!!', WORK_ID)).toBe('ew-my-site-3f2a9c1e');
		expect(appNamespaceName('', WORK_ID)).toBe('ew-app-3f2a9c1e');
	});

	it('derives a deterministic 8-hex suffix from the work id', () => {
		const suffix = hexSuffix(WORK_ID, 8);

		expect(suffix).toMatch(/^[0-9a-f]{8}$/);
		expect(suffix).toBe(WORK_ID.slice(0, 8));
		expect(appNamespaceName(SLUG, WORK_ID)).toBe(appNamespaceName(SLUG, WORK_ID));
		expect(hexSuffix(OTHER_WORK_ID, 8)).not.toBe(suffix);
		expect(appNamespaceName(SLUG, OTHER_WORK_ID)).not.toBe(appNamespaceName(SLUG, WORK_ID));
	});

	it('falls back deterministically for an id carrying fewer than 8 hex characters', () => {
		const first = hexSuffix('work-123', 8);
		const second = hexSuffix('work-456', 8);
		const third = hexSuffix('', 8);

		expect(first).toMatch(/^[0-9a-f]{8}$/);
		expect(second).toMatch(/^[0-9a-f]{8}$/);
		expect(third).toMatch(/^[0-9a-f]{8}$/);
		expect(hexSuffix('work-123', 8)).toBe(first);
		expect(second).not.toBe(first);
		expect(third).not.toBe(first);
	});
});

describe('previewNamespaceName', () => {
	it('appends `-pr<number>` to the live namespace', () => {
		expect(previewNamespaceName(LIVE_NAMESPACE, 42)).toBe(`${LIVE_NAMESPACE}-pr42`);
	});

	it('is deterministic and normalises the pull request number to a positive integer', () => {
		expect(previewNamespaceName(LIVE_NAMESPACE, 7)).toBe(previewNamespaceName(LIVE_NAMESPACE, 7));
		expect(previewNamespaceName(LIVE_NAMESPACE, 7.8)).toBe(`${LIVE_NAMESPACE}-pr7`);
		expect(previewNamespaceName(LIVE_NAMESPACE, -3)).toBe(`${LIVE_NAMESPACE}-pr1`);
		expect(previewNamespaceName(LIVE_NAMESPACE, Number.NaN)).toBe(`${LIVE_NAMESPACE}-pr1`);
	});

	it('stays inside the 63-character cap even for an over-long base namespace', () => {
		const name = previewNamespaceName('n'.repeat(63), 12345);

		expect(name.length).toBeLessThanOrEqual(APP_NAME_MAX_LENGTH);
		expect(name).toMatch(DNS_LABEL);
	});
});

describe('verificationNamespaceName', () => {
	it('renders `<ns>-v<first 6 hex of provisioningId>-<attempt>`', () => {
		expect(verificationNamespaceName(LIVE_NAMESPACE, PROVISIONING_ID, 1)).toBe(`${LIVE_NAMESPACE}-v4f3a2b-1`);
	});

	it('stays within 63 characters for any namespace and within 52 in practice', () => {
		const longestLiveNamespace = appNamespaceName(LONGEST_SLUG, WORK_ID);

		expect(longestLiveNamespace).toHaveLength(APP_NAMESPACE_MAX_LENGTH);
		expect(APP_VERIFICATION_NAMESPACE_MAX_LENGTH).toBe(52);

		const inPractice = verificationNamespaceName(longestLiveNamespace, PROVISIONING_ID, 9);
		expect(inPractice).toHaveLength(APP_VERIFICATION_NAMESPACE_MAX_LENGTH);
		expect(inPractice.length).toBeLessThanOrEqual(APP_VERIFICATION_NAMESPACE_MAX_LENGTH);

		const oversized = verificationNamespaceName('n'.repeat(63), PROVISIONING_ID, 1);
		expect(oversized.length).toBeLessThanOrEqual(APP_NAME_MAX_LENGTH);
		expect(oversized).toMatch(DNS_LABEL);
	});

	it('keeps the attempt at or below 9', () => {
		expect(APP_VERIFICATION_MAX_ATTEMPT).toBe(9);
		expect(verificationNamespaceName(LIVE_NAMESPACE, PROVISIONING_ID, 12)).toBe(
			verificationNamespaceName(LIVE_NAMESPACE, PROVISIONING_ID, 9)
		);
		expect(verificationNamespaceName(LIVE_NAMESPACE, PROVISIONING_ID, 0)).toBe(
			verificationNamespaceName(LIVE_NAMESPACE, PROVISIONING_ID, 1)
		);
	});

	it('is deterministic and never collides across attempts', () => {
		const first = verificationNamespaceName(LIVE_NAMESPACE, PROVISIONING_ID, 1);

		expect(verificationNamespaceName(LIVE_NAMESPACE, PROVISIONING_ID, 1)).toBe(first);
		expect(verificationNamespaceName(LIVE_NAMESPACE, PROVISIONING_ID, 2)).not.toBe(first);
	});

	it('gives two provisionings different names (APW06-G09)', () => {
		const a = verificationNamespaceName(LIVE_NAMESPACE, PROVISIONING_ID, 1);
		const b = verificationNamespaceName(LIVE_NAMESPACE, OTHER_PROVISIONING_ID, 1);

		expect(a).not.toBe(b);
		expect(a).toContain(`-v${PROVISIONING_ID.replace(/[^0-9a-f]/gi, '').slice(0, 6)}-`);
		expect(b).toContain(`-v${OTHER_PROVISIONING_ID.replace(/[^0-9a-f]/gi, '').slice(0, 6)}-`);
	});

	it('never derives a name from the live namespace of another App Work', () => {
		// The epic derives and owns this name (plan §4.12) — the base is always the caller's namespace.
		expect(verificationNamespaceName(LIVE_NAMESPACE, PROVISIONING_ID, 1).startsWith(LIVE_NAMESPACE)).toBe(true);
	});
});

describe('object name helpers', () => {
	it('keeps a Job name at or below 45 characters for a 32-character Name', () => {
		const name = jobName(NAME_32, 'deadbeef');

		expect(APP_JOB_NAME_MAX_LENGTH).toBe(45);
		expect(name).toBe(`job-${NAME_32}-deadbeef`);
		expect(name).toHaveLength(APP_JOB_NAME_MAX_LENGTH);
		expect(name).toMatch(DNS_LABEL);
	});

	it('keeps a CronJob name at or below 37 characters for a 32-character Name', () => {
		const name = cronJobName(NAME_32);

		expect(APP_CRONJOB_NAME_MAX_LENGTH).toBe(37);
		expect(name).toBe(`cron-${NAME_32}`);
		expect(name).toHaveLength(APP_CRONJOB_NAME_MAX_LENGTH);
		expect(name).toMatch(DNS_LABEL);
	});

	it('keeps a manual job run name at or below 45 characters', () => {
		const name = manualJobName(NAME_32, 'deadbeef');

		expect(name).toBe(`run-${NAME_32}-deadbeef`);
		expect(name.length).toBeLessThanOrEqual(APP_JOB_NAME_MAX_LENGTH);
		expect(name).toMatch(DNS_LABEL);
	});

	it('never exceeds a cap even when handed an over-long name', () => {
		const overlong = 'o'.repeat(60);

		expect(jobName(overlong, 'deadbeef').length).toBeLessThanOrEqual(APP_JOB_NAME_MAX_LENGTH);
		expect(cronJobName(overlong).length).toBeLessThanOrEqual(APP_CRONJOB_NAME_MAX_LENGTH);
		expect(manualJobName(overlong, 'deadbeef').length).toBeLessThanOrEqual(APP_JOB_NAME_MAX_LENGTH);
		expect(jobName(overlong, 'deadbeef')).toMatch(DNS_LABEL);
		expect(cronJobName(overlong)).toMatch(DNS_LABEL);
	});

	it('names the fixed objects of plan §4.1', () => {
		expect(serviceAccountName()).toBe('app');
		expect(pullSecretName()).toBe('app-pull');
		expect(componentObjectName('web')).toBe('web');
		expect(pvcName('web', 'uploads')).toBe('web-uploads');
		expect(dependencyNetworkPolicyName('postgres')).toBe('dep-postgres');
	});

	it('derives the checksum-named objects from the first 10 hex of the checksum', () => {
		expect(envSecretName('abcdef0123456789')).toBe('app-env-abcdef0123');
		expect(platformConfigMapName('abcdef0123456789')).toBe('app-platform-abcdef0123');
		expect(runnerConfigMapName('abcdef0123456789')).toBe('ew-runner-abcdef0123');
	});

	it('keeps the five network policy names of plan §4.1 split into baseline and deployment sets', () => {
		expect([...APP_BASELINE_NETWORK_POLICY_NAMES]).toEqual([
			'ew-default-deny',
			'ew-allow-same-namespace',
			'ew-allow-egress'
		]);
		expect([...APP_DEPLOYMENT_NETWORK_POLICY_NAMES]).toEqual(['ew-allow-ingress', 'ew-allow-deps']);
	});
});

describe('labels', () => {
	it('carries the disjoint App label set of plan §4.1', () => {
		expect(appLabels({ workId: WORK_ID, workSlug: SLUG })).toEqual({
			'app.kubernetes.io/managed-by': 'ever-works-k8s-plugin',
			'app.kubernetes.io/part-of': SLUG,
			'ever-works.io/work-id': WORK_ID,
			'ever-works.io/kind': 'app'
		});
	});

	it('adds the component, job and cron labels only where relevant', () => {
		expect(appLabels({ workId: WORK_ID, workSlug: SLUG, component: 'web' })).toMatchObject({
			'ever-works.io/component': 'web'
		});
		expect(appLabels({ workId: WORK_ID, workSlug: SLUG, component: 'web' })).not.toHaveProperty(
			'ever-works.io/job'
		);
		expect(appLabels({ workId: WORK_ID, workSlug: SLUG, job: 'migrate' })).toMatchObject({
			'ever-works.io/job': 'migrate'
		});
		expect(appLabels({ workId: WORK_ID, workSlug: SLUG, cron: 'tick' })).toMatchObject({
			'ever-works.io/cron': 'tick'
		});
	});

	it('never carries `ever-works.io/managed` or `app.kubernetes.io/name`', () => {
		const everyLabelMap: Array<Record<string, string>> = [
			appLabels({ workId: WORK_ID, workSlug: SLUG }),
			appLabels({ workId: WORK_ID, workSlug: SLUG, component: 'web', job: 'migrate', cron: 'tick' }),
			pvcLabels({ workId: WORK_ID, workSlug: SLUG, component: 'web' }),
			namespaceLabels({ workId: WORK_ID, workSlug: SLUG, podSecurity: 'baseline' }),
			namespaceLabels({ workId: WORK_ID, workSlug: SLUG, podSecurity: 'restricted' }),
			namespaceLabels({
				workId: WORK_ID,
				workSlug: SLUG,
				podSecurity: 'baseline',
				purpose: 'verification'
			}),
			componentSelector('web')
		];

		expect([...APP_FORBIDDEN_LABEL_KEYS]).toEqual(['ever-works.io/managed', 'app.kubernetes.io/name']);

		for (const labels of everyLabelMap) {
			for (const forbidden of APP_FORBIDDEN_LABEL_KEYS) {
				expect(Object.keys(labels)).not.toContain(forbidden);
			}
		}
	});

	it('marks a retained volume claim', () => {
		expect(pvcLabels({ workId: WORK_ID, workSlug: SLUG, component: 'web' })).toMatchObject({
			'ever-works.io/retain': 'true'
		});
	});

	it('adds the pod-security labels to a namespace', () => {
		expect(namespaceLabels({ workId: WORK_ID, workSlug: SLUG, podSecurity: 'baseline' })).toMatchObject({
			'pod-security.kubernetes.io/enforce': 'baseline',
			'pod-security.kubernetes.io/warn': 'restricted',
			'pod-security.kubernetes.io/audit': 'restricted'
		});
		expect(namespaceLabels({ workId: WORK_ID, workSlug: SLUG, podSecurity: 'restricted' })).toMatchObject({
			'pod-security.kubernetes.io/enforce': 'restricted'
		});
	});

	it('marks a verification namespace and only a verification namespace', () => {
		expect(
			namespaceLabels({
				workId: WORK_ID,
				workSlug: SLUG,
				podSecurity: 'baseline',
				purpose: 'verification'
			})
		).toMatchObject({ 'ever-works.io/purpose': 'verification' });
		expect(namespaceLabels({ workId: WORK_ID, workSlug: SLUG, podSecurity: 'baseline' })).not.toHaveProperty(
			'ever-works.io/purpose'
		);
	});
});

describe('namespaceAnnotations', () => {
	it('writes the verification expiry as RFC 3339 UTC', () => {
		expect(namespaceAnnotations({ expiresAt: '2026-09-17T12:00:00.000Z' })).toEqual({
			'ever-works.io/expires-at': '2026-09-17T12:00:00.000Z'
		});
	});

	it('writes nothing when there is no expiry', () => {
		expect(namespaceAnnotations()).toEqual({});
		expect(namespaceAnnotations({ expiresAt: null })).toEqual({});
		expect(namespaceAnnotations({ expiresAt: '  ' })).toEqual({});
	});
});

describe('componentSelector', () => {
	it('selects on the component label alone so a slug rename never breaks a selector', () => {
		expect(componentSelector('web')).toEqual({ 'ever-works.io/component': 'web' });
	});
});

describe('internalUrl', () => {
	it('resolves `http://<component>.<namespace>.svc.cluster.local` (plan §4.3)', () => {
		expect(internalUrl('web', LIVE_NAMESPACE)).toBe(`http://web.${LIVE_NAMESPACE}.svc.cluster.local`);
	});
});
