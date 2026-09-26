/**
 * T7 — `app-network-policy.renderer.ts` (plan §4.10, §4.2 step 4; spec FR-20/FR-21; ACC-06-17,
 * ACC-06-54, ACC-06-58).
 *
 * Every clause of T7's `**Test**` line (tasks.md:144-147) has an `it` below: the five default
 * policies and every excepted IPv4/IPv6 CIDR (ACC-06-17); the controller-namespace and fallback
 * variants; `extraEgress` and the hairpin rules; and `isolation: false` rendering **zero** policies
 * while returning the five names to delete — never a `dep-<kind>` name (APW07-G01, ACC-06-54).
 *
 * Pure functions only — no clock, no I/O, no cluster access. The hairpin address is data the
 * caller passes in (it is observed from the cluster at publish time, plan §8.2), never resolved
 * here.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
	APP_DNS_NAMESPACE,
	APP_DNS_POD_SELECTOR,
	APP_DNS_PORT,
	APP_HAIRPIN_PORTS,
	APP_IPV4_EXCEPTED_CIDRS,
	APP_IPV6_EXCEPTED_CIDRS,
	APP_ISOLATION_PROBE_LABEL,
	APP_PUBLIC_IPV4_CIDR,
	APP_PUBLIC_IPV6_CIDR,
	isDependencyNetworkPolicyName,
	networkPolicyNames,
	planNetworkPolicies,
	renderBaselineNetworkPolicies,
	renderDeploymentNetworkPolicies,
	renderNetworkPolicies,
	type AppNetworkPolicyInput,
	type AppNetworkPolicyPlan,
	type AppRenderedPolicy
} from '../app-network-policy.renderer';
import {
	APP_BASELINE_NETWORK_POLICY_NAMES,
	APP_DEPLOYMENT_NETWORK_POLICY_NAMES,
	dependencyNetworkPolicyName
} from '../app-names';

type Json = Record<string, any>;

function golden(name: string): unknown {
	return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

/**
 * The render input fields §4.10 reads, taken from the T6 single-web fixture shape: `web` is the
 * primary web component on port 3000, the ingress controller lives in `ingress-nginx`.
 */
function input(overrides: Json = {}): AppNetworkPolicyInput {
	const base: Json = {
		ref: { workId: '0f8e2c1a-1111-4a2b-9c3d-4e5f60718293', namespace: 'ew-analytics-0f8e2c1a' },
		workSlug: 'analytics',
		components: [{ name: 'web', role: 'web', port: 3000, primary: true }],
		ingress: { controllerNamespace: 'ingress-nginx' },
		network: { isolation: true, extraEgress: [], needsHairpin: false }
	};

	return { ...base, ...overrides } as unknown as AppNetworkPolicyInput;
}

function policyNamed(plan: AppNetworkPolicyPlan | readonly AppRenderedPolicy[], name: string): Json {
	const objects = Array.isArray(plan) ? plan : (plan as AppNetworkPolicyPlan).objects;
	const found = objects.find((object) => object.metadata.name === name);
	expect(found, `a NetworkPolicy named ${name}`).toBeDefined();
	return found as unknown as Json;
}

const allEgressRules = (policy: Json): Json[] => (policy.spec.egress ?? []) as Json[];

const cidrBlocks = (policy: Json): Json[] =>
	allEgressRules(policy)
		.flatMap((rule) => (rule.to ?? []) as Json[])
		.filter((peer) => peer.ipBlock)
		.map((peer) => peer.ipBlock as Json);

// --- T7: "the five default policies render" (ACC-06-17) --------------------

describe('T7 — ACC-06-17: the five default policies', () => {
	it('renders all five policies, in plan §4.10’s table order', () => {
		const plan = planNetworkPolicies(input());

		expect(plan.objects).toHaveLength(5);
		expect(plan.objects.map((object) => object.metadata.name)).toEqual([
			'ew-default-deny',
			'ew-allow-same-namespace',
			'ew-allow-egress',
			'ew-allow-ingress',
			'ew-allow-deps'
		]);
		expect(networkPolicyNames()).toEqual([
			...APP_BASELINE_NETWORK_POLICY_NAMES,
			...APP_DEPLOYMENT_NETWORK_POLICY_NAMES
		]);
		for (const object of plan.objects) {
			expect(object.apiVersion).toBe('networking.k8s.io/v1');
			expect(object.kind).toBe('NetworkPolicy');
			expect(object.metadata.namespace).toBe('ew-analytics-0f8e2c1a');
			expect(object.spec.podSelector).toBeDefined();
			expect(object.spec.policyTypes.length).toBeGreaterThan(0);
		}
	});

	it('denies everything by default: all pods, both directions, no rules (FR-20)', () => {
		const policy = policyNamed(planNetworkPolicies(input()), 'ew-default-deny');

		expect(policy.spec.podSelector).toEqual({});
		expect(policy.spec.policyTypes).toEqual(['Ingress', 'Egress']);
		expect(policy.spec.ingress).toBeUndefined();
		expect(policy.spec.egress).toBeUndefined();
	});

	it('allows the namespace’s own pods to reach each other in both directions', () => {
		const policy = policyNamed(planNetworkPolicies(input()), 'ew-allow-same-namespace');

		expect(policy.spec.policyTypes).toEqual(['Ingress', 'Egress']);
		expect(policy.spec.ingress).toEqual([{ from: [{ podSelector: {} }] }]);
		expect(policy.spec.egress).toEqual([{ to: [{ podSelector: {} }] }]);
	});

	it('labels every policy with the App label set and never a forbidden key', () => {
		for (const object of planNetworkPolicies(input()).objects) {
			expect(object.metadata.labels['ever-works.io/kind']).toBe('app');
			expect(object.metadata.labels['ever-works.io/work-id']).toBe('0f8e2c1a-1111-4a2b-9c3d-4e5f60718293');
			expect(object.metadata.labels['app.kubernetes.io/managed-by']).toBe('ever-works-k8s-plugin');
			expect(object.metadata.labels).not.toHaveProperty('ever-works.io/managed');
			expect(object.metadata.labels).not.toHaveProperty('app.kubernetes.io/name');
		}
	});
});

// --- T7: "every excepted IPv4/IPv6 CIDR is present" (ACC-06-17) ------------

describe('T7 — ACC-06-17: ew-allow-egress excepts every private, loopback, link-local, shared, multicast and reserved range', () => {
	it('sends public IPv4 traffic to the internet except the nine IPv4 ranges', () => {
		const blocks = cidrBlocks(policyNamed(planNetworkPolicies(input()), 'ew-allow-egress'));
		const ipv4 = blocks.find((block) => block.cidr === APP_PUBLIC_IPV4_CIDR);

		expect(APP_PUBLIC_IPV4_CIDR).toBe('0.0.0.0/0');
		expect(ipv4).toBeDefined();
		expect(ipv4!.except).toEqual([...APP_IPV4_EXCEPTED_CIDRS]);
		expect(ipv4!.except).toEqual([
			'10.0.0.0/8',
			'172.16.0.0/12',
			'192.168.0.0/16',
			'100.64.0.0/10',
			'169.254.0.0/16',
			'127.0.0.0/8',
			'0.0.0.0/8',
			'224.0.0.0/4',
			'240.0.0.0/4'
		]);
	});

	it('sends public IPv6 traffic to the internet except the four IPv6 ranges', () => {
		const blocks = cidrBlocks(policyNamed(planNetworkPolicies(input()), 'ew-allow-egress'));
		const ipv6 = blocks.find((block) => block.cidr === APP_PUBLIC_IPV6_CIDR);

		expect(APP_PUBLIC_IPV6_CIDR).toBe('::/0');
		expect(ipv6).toBeDefined();
		expect(ipv6!.except).toEqual([...APP_IPV6_EXCEPTED_CIDRS]);
		expect(ipv6!.except).toEqual(['fc00::/7', 'fe80::/10', '::1/128', 'ff00::/8']);
	});

	it('allows DNS over UDP and TCP on port 53 to the kube-dns pods in kube-system', () => {
		const policy = policyNamed(planNetworkPolicies(input()), 'ew-allow-egress');
		const dns = allEgressRules(policy).find((rule) => (rule.to ?? []).some((peer: Json) => peer.podSelector));

		expect(APP_DNS_NAMESPACE).toBe('kube-system');
		expect(APP_DNS_POD_SELECTOR).toEqual({ 'k8s-app': 'kube-dns' });
		expect(APP_DNS_PORT).toBe(53);
		expect(dns).toEqual({
			to: [
				{
					namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
					podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } }
				}
			],
			ports: [
				{ protocol: 'UDP', port: 53 },
				{ protocol: 'TCP', port: 53 }
			]
		});
	});

	it('renders the DNS fallback variant: any namespace, port 53', () => {
		const plan = planNetworkPolicies(input(), { dns: 'any-namespace' });
		const dns = allEgressRules(policyNamed(plan, 'ew-allow-egress')).find((rule) =>
			(rule.to ?? []).some((peer: Json) => peer.namespaceSelector)
		);

		expect(dns).toEqual({
			to: [{ namespaceSelector: {} }],
			ports: [
				{ protocol: 'UDP', port: 53 },
				{ protocol: 'TCP', port: 53 }
			]
		});
		expect(
			allEgressRules(policyNamed(plan, 'ew-allow-egress')).some((rule) =>
				(rule.to ?? []).some((peer: Json) => peer.podSelector)
			)
		).toBe(false);
	});

	it('renders both DNS variants when the caller asks for both', () => {
		const rules = allEgressRules(policyNamed(planNetworkPolicies(input(), { dns: 'both' }), 'ew-allow-egress'));

		expect(rules.filter((rule) => (rule.to ?? []).some((peer: Json) => peer.namespaceSelector))).toHaveLength(2);
	});
});

// --- T7: "controller-namespace and fallback variants" ---------------------

describe('T7 — ew-allow-ingress: controller namespace and its fallback', () => {
	it('admits only the ingress controller’s namespace on the primary web port', () => {
		const policy = policyNamed(planNetworkPolicies(input()), 'ew-allow-ingress');

		expect(policy.spec.podSelector).toEqual({ matchLabels: { 'ever-works.io/component': 'web' } });
		expect(policy.spec.policyTypes).toEqual(['Ingress']);
		expect(policy.spec.ingress).toEqual([
			{
				from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx' } } }],
				ports: [{ protocol: 'TCP', port: 3000 }]
			}
		]);
		expect(planNetworkPolicies(input()).warnings).toEqual([]);
	});

	it('falls back to any namespace on the web port only, with the documented warning', () => {
		const plan = planNetworkPolicies(input({ ingress: { controllerNamespace: null } }));
		const policy = policyNamed(plan, 'ew-allow-ingress');

		expect(policy.spec.ingress).toEqual([
			{ from: [{ namespaceSelector: {} }], ports: [{ protocol: 'TCP', port: 3000 }] }
		]);
		expect(plan.warnings.map((warning) => warning.code)).toEqual(['ingress_controller_namespace_unknown']);
		expect(plan.warnings[0].message).toContain('ingress controller');
	});

	it('selects the primary web component even when it is not the first declared one', () => {
		const plan = planNetworkPolicies(
			input({
				components: [
					{ name: 'admin', role: 'web', port: 3001, primary: false },
					{ name: 'web', role: 'web', port: 8080, primary: true }
				]
			})
		);

		expect(policyNamed(plan, 'ew-allow-ingress').spec.podSelector).toEqual({
			matchLabels: { 'ever-works.io/component': 'web' }
		});
		expect(policyNamed(plan, 'ew-allow-ingress').spec.ingress[0].ports).toEqual([{ protocol: 'TCP', port: 8080 }]);
	});

	it('renders no ingress rule at all when there is no primary web component, and selects no pod', () => {
		const plan = planNetworkPolicies(input({ components: [{ name: 'worker', role: 'worker', primary: false }] }));
		const policy = policyNamed(plan, 'ew-allow-ingress');

		expect(policy.spec.ingress).toBeUndefined();
		// Fail-closed: `ever-works.io/component` with `DoesNotExist` matches no App pod, so a
		// worker-only App never has the ingress controller admitted into a worker.
		expect(policy.spec.podSelector).toEqual({
			matchExpressions: [{ key: 'ever-works.io/component', operator: 'DoesNotExist' }]
		});
	});
});

// --- T7: "extraEgress and hairpin rules" ----------------------------------

describe('T7 — ew-allow-deps: dependency egress and the hairpin address (plan §4.10, FR-37)', () => {
	it('renders every extraEgress CIDR and port', () => {
		const plan = planNetworkPolicies(
			input({
				network: {
					isolation: true,
					needsHairpin: false,
					extraEgress: [
						{ cidr: '192.0.2.0/24', ports: [5432, 6379] },
						{ cidr: '2001:db8::/32', ports: [443] }
					]
				}
			})
		);
		const policy = policyNamed(plan, 'ew-allow-deps');

		expect(policy.spec.policyTypes).toEqual(['Egress']);
		expect(policy.spec.egress).toEqual([
			{
				to: [{ ipBlock: { cidr: '192.0.2.0/24' } }],
				ports: [
					{ protocol: 'TCP', port: 5432 },
					{ protocol: 'TCP', port: 6379 }
				]
			},
			{ to: [{ ipBlock: { cidr: '2001:db8::/32' } }], ports: [{ protocol: 'TCP', port: 443 }] }
		]);
	});

	it('omits the ports list when an extraEgress entry declares none', () => {
		const plan = planNetworkPolicies(
			input({
				network: { isolation: true, needsHairpin: false, extraEgress: [{ cidr: '192.0.2.0/24', ports: [] }] }
			})
		);

		expect(policyNamed(plan, 'ew-allow-deps').spec.egress).toEqual([
			{ to: [{ ipBlock: { cidr: '192.0.2.0/24' } }] }
		]);
	});

	it('adds the ingress address on 80/443 when the app needs to call its own public address', () => {
		const plan = planNetworkPolicies(input({ network: { isolation: true, needsHairpin: true, extraEgress: [] } }), {
			ingressAddress: { ip: '192.0.2.10' }
		});

		expect(APP_HAIRPIN_PORTS).toEqual([80, 443]);
		expect(policyNamed(plan, 'ew-allow-deps').spec.egress).toEqual([
			{
				to: [{ ipBlock: { cidr: '192.0.2.10/32' } }],
				ports: [
					{ protocol: 'TCP', port: 80 },
					{ protocol: 'TCP', port: 443 }
				]
			}
		]);
	});

	it('widens an IPv6 hairpin address to a /128', () => {
		const plan = planNetworkPolicies(input({ network: { isolation: true, needsHairpin: true, extraEgress: [] } }), {
			ingressAddress: { ip: '2001:db8::1' }
		});

		expect(policyNamed(plan, 'ew-allow-deps').spec.egress[0].to).toEqual([
			{ ipBlock: { cidr: '2001:db8::1/128' } }
		]);
	});

	it('renders no hairpin rule when the app does not need one', () => {
		const plan = planNetworkPolicies(
			input({ network: { isolation: true, needsHairpin: false, extraEgress: [] } }),
			{
				ingressAddress: { ip: '192.0.2.10' }
			}
		);

		expect(policyNamed(plan, 'ew-allow-deps').spec.egress).toEqual([]);
	});

	it('renders no hairpin rule when no address has been observed yet', () => {
		const plan = planNetworkPolicies(input({ network: { isolation: true, needsHairpin: true, extraEgress: [] } }));

		expect(policyNamed(plan, 'ew-allow-deps').spec.egress).toEqual([]);
	});

	it('still renders ew-allow-deps when there is nothing to allow, so the set stays the same five', () => {
		const plan = planNetworkPolicies(input());

		expect(policyNamed(plan, 'ew-allow-deps').spec.egress).toEqual([]);
		expect(plan.objects).toHaveLength(5);
	});
});

// --- T7: the isolation-probe exclusion (plan §4.10, APW06-G18) -------------

describe('T7 — the isolation-probe pod selector (plan §4.10, APW06-G18)', () => {
	const EXCLUSION = { matchExpressions: [{ key: APP_ISOLATION_PROBE_LABEL, operator: 'DoesNotExist' }] };

	it('excludes probe pods from the three allowance policies', () => {
		const plan = planNetworkPolicies(input());

		expect(APP_ISOLATION_PROBE_LABEL).toBe('ever-works.io/isolation-probe');
		for (const name of ['ew-allow-same-namespace', 'ew-allow-egress', 'ew-allow-deps']) {
			expect(policyNamed(plan, name).spec.podSelector).toEqual(EXCLUSION);
		}
	});

	it('leaves ew-default-deny selecting every pod and ew-allow-ingress unchanged', () => {
		const plan = planNetworkPolicies(input());

		expect(policyNamed(plan, 'ew-default-deny').spec.podSelector).toEqual({});
		expect(policyNamed(plan, 'ew-allow-ingress').spec.podSelector).toEqual({
			matchLabels: { 'ever-works.io/component': 'web' }
		});
	});

	it('keeps every peer selector a podSelector {} — only the policy selector changes', () => {
		const plan = planNetworkPolicies(input());

		expect(policyNamed(plan, 'ew-allow-same-namespace').spec.ingress[0].from).toEqual([{ podSelector: {} }]);
		expect(policyNamed(plan, 'ew-allow-same-namespace').spec.egress[0].to).toEqual([{ podSelector: {} }]);
	});
});

// --- T7: "isolation: false renders zero policies and returns the five names to delete — and
// never a dep-<kind> name (APW07-G01, ACC-06-54)" --------------------------

describe('T7 — ACC-06-54 / APW07-G01: isolation off', () => {
	const isolated = (): AppNetworkPolicyInput =>
		input({ network: { isolation: false, extraEgress: [], needsHairpin: false } });

	it('renders zero policies and returns the five names to delete', () => {
		const plan = planNetworkPolicies(isolated());

		expect(plan.objects).toEqual([]);
		expect(plan.deleteNames).toEqual([
			'ew-default-deny',
			'ew-allow-same-namespace',
			'ew-allow-egress',
			'ew-allow-ingress',
			'ew-allow-deps'
		]);
		expect(renderNetworkPolicies(isolated())).toEqual([]);
	});

	it('returns no names to delete when isolation is on and the policies are rendered', () => {
		expect(planNetworkPolicies(input()).deleteNames).toEqual([]);
	});

	it('never returns a dep-<kind> name in the deletion set (APW07-G01)', () => {
		const plan = planNetworkPolicies(isolated());

		expect(isDependencyNetworkPolicyName('dep-postgres')).toBe(true);
		expect(isDependencyNetworkPolicyName('dep-redis')).toBe(true);
		expect(isDependencyNetworkPolicyName('ew-default-deny')).toBe(false);
		for (const name of plan.deleteNames) {
			expect(isDependencyNetworkPolicyName(name)).toBe(false);
			expect(name.startsWith('dep-')).toBe(false);
		}
	});

	it('keeps the deletion set to the five ew-* names only, never a dependency policy', () => {
		const plan = planNetworkPolicies(isolated());

		expect(plan.deleteNames).toEqual([...networkPolicyNames()]);
		// The name APW-07's providers draw for their own policy (plan §4.1) is never in the set.
		expect(plan.deleteNames).not.toContain(dependencyNetworkPolicyName('postgres'));
		expect(plan.deleteNames).not.toContain(dependencyNetworkPolicyName('redis'));
	});

	it('renders no policy for either scope while isolation is off', () => {
		expect(renderBaselineNetworkPolicies(isolated())).toEqual([]);
		expect(renderDeploymentNetworkPolicies(isolated())).toEqual([]);
	});

	it('reports no ingress-controller warning when nothing is rendered', () => {
		expect(
			planNetworkPolicies(
				input({
					ingress: { controllerNamespace: null },
					network: { isolation: false, extraEgress: [], needsHairpin: false }
				})
			).warnings
		).toEqual([]);
	});
});

// --- T7: the prepare-namespace subset (§4.2 step 4) -----------------------

describe('T7 — scopes: baseline for prepare-namespace, deployment for a Deployment (plan §4.2)', () => {
	it('renders exactly the three baseline policies for the prepare-namespace scope', () => {
		const plan = planNetworkPolicies(input(), { scope: 'baseline' });

		expect(plan.objects.map((object) => object.metadata.name)).toEqual([...APP_BASELINE_NETWORK_POLICY_NAMES]);
		expect(renderBaselineNetworkPolicies(input()).map((object) => object.metadata.name)).toEqual([
			...APP_BASELINE_NETWORK_POLICY_NAMES
		]);
	});

	it('renders exactly the two Deployment-only policies for the deployment scope', () => {
		const plan = planNetworkPolicies(input(), { scope: 'deployment' });

		expect(plan.objects.map((object) => object.metadata.name)).toEqual([...APP_DEPLOYMENT_NETWORK_POLICY_NAMES]);
		expect(renderDeploymentNetworkPolicies(input()).map((object) => object.metadata.name)).toEqual([
			...APP_DEPLOYMENT_NETWORK_POLICY_NAMES
		]);
	});

	it('never draws ew-allow-ingress or ew-allow-deps in the baseline scope', () => {
		const names = renderBaselineNetworkPolicies(input()).map((object) => object.metadata.name);

		expect(names).not.toContain('ew-allow-ingress');
		expect(names).not.toContain('ew-allow-deps');
	});
});

// --- T7: golden fixtures (plan §12.1) -------------------------------------

describe('T7 — golden fixtures (plan §12.1)', () => {
	it('matches expected.network-policies.isolation-on.json', () => {
		const plan = planNetworkPolicies(
			input({
				network: {
					isolation: true,
					needsHairpin: true,
					extraEgress: [{ cidr: '192.0.2.0/24', ports: [5432] }]
				}
			}),
			{ ingressAddress: { ip: '192.0.2.10' } }
		);

		expect(
			JSON.parse(
				JSON.stringify({ objects: plan.objects, warnings: plan.warnings, deleteNames: plan.deleteNames })
			)
		).toEqual(golden('expected.network-policies.isolation-on.json'));
	});

	it('matches expected.network-policies.isolation-off.json', () => {
		const plan = planNetworkPolicies(
			input({ network: { isolation: false, extraEgress: [], needsHairpin: false } })
		);

		expect(
			JSON.parse(
				JSON.stringify({ objects: plan.objects, warnings: plan.warnings, deleteNames: plan.deleteNames })
			)
		).toEqual(golden('expected.network-policies.isolation-off.json'));
	});

	it('matches expected.network-policies.baseline.json', () => {
		const plan = planNetworkPolicies(input(), { scope: 'baseline' });

		expect(
			JSON.parse(
				JSON.stringify({ objects: plan.objects, warnings: plan.warnings, deleteNames: plan.deleteNames })
			)
		).toEqual(golden('expected.network-policies.baseline.json'));
	});
});

// --- T7: purity ------------------------------------------------------------

describe('T7 — pure library entry points (R-5)', () => {
	it('renders the same bytes twice and never mutates its input', () => {
		const value = input();
		const snapshot = JSON.stringify(value);

		expect(JSON.stringify(planNetworkPolicies(value))).toBe(JSON.stringify(planNetworkPolicies(input())));
		planNetworkPolicies(value, { ingressAddress: { ip: '192.0.2.10' }, dns: 'both' });
		expect(JSON.stringify(value)).toBe(snapshot);
	});

	it('exposes every policy through the plain-array entry point', () => {
		const objects = renderNetworkPolicies(input());

		expect(objects.map((object) => object.metadata.name)).toEqual([...networkPolicyNames()]);
		expect(objects.every((object) => object.kind === 'NetworkPolicy')).toBe(true);
	});
});
