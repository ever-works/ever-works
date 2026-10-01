/**
 * APW-07 T20/T21 — the **shared** `dep-<kind>` renderer, `app-dependencies/common.ts`.
 *
 * `tasks.md:325-327`: "The shared `dep-<kind>` rendering lives in `common.ts`, so its unit spec covers the
 * label set, `podSelector`, the three ingress ports, the operator-namespace variant and the fact that it is
 * drawn with isolation off."
 *
 * The renderer is the one place FR-38's promise lives for all three in-cluster kinds (`spec.md:311-312`:
 * "Every in-cluster dependency is reachable only from the App Work's own pods: the platform creates a
 * network policy allowing only them, and exposes no dependency outside the cluster"), and the reason T19's
 * two path specs call it rather than restating it. The three ports are the plan's own list
 * (`plan.md` §4.9:588 — "on the service ports (5432, 6379, 9000)"), so this suite walks every one of them
 * rather than only the Postgres case T19 happens to exercise.
 *
 * "Drawn with isolation off" is asserted as the *absence of an input* that could switch it off: the
 * renderer takes no isolation flag, an extra `isolation: false` on the input changes nothing, and the
 * policy is `policyTypes: [Ingress]` with no `egress` key (which is what APW-06's `ew-allow-deps` got
 * wrong — it allowed egress *out* of the namespace, so it never kept anyone out; `plan.md` §4.9:597-602).
 */
import { describe, expect, it } from 'vitest';

import {
	APP_DEPENDENCY_POLICY_LABEL,
	APP_NAMESPACE_NAME_LABEL,
	APP_NETWORK_POLICY_API_VERSION
} from '../../app/app-network-policy.renderer';
import {
	APP_LABEL_KIND,
	APP_LABEL_KIND_APP,
	APP_LABEL_MANAGED_BY,
	APP_LABEL_PART_OF,
	APP_LABEL_WORK_ID,
	APP_MANAGED_BY,
	dependencyNetworkPolicyName
} from '../../app/app-names';
import {
	APP_DEPENDENCY_OPERATOR_STATUS_PORT,
	APP_DEPENDENCY_PORTS,
	dependencyPodSelector,
	planDependencyNetworkPolicy,
	renderDependencyNetworkPolicy,
	type AppDependencyK8sKind,
	type DependencyNetworkPolicyInput
} from '../common';

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

const WORK_ID = '0f8e2c1a-1111-4a2b-9c3d-4e5f60718293';
const WORK_SLUG = 'analytics';
const NAMESPACE = 'ew-analytics-0f8e2c1a';

/** The three kinds this plugin's providers serve, with the port the plan fixes for each. */
const KINDS: readonly { kind: AppDependencyK8sKind; port: number }[] = [
	{ kind: 'postgres', port: APP_DEPENDENCY_PORTS.postgres },
	{ kind: 'redis', port: APP_DEPENDENCY_PORTS.redis },
	{ kind: 'objectStorage', port: APP_DEPENDENCY_PORTS.objectStorage }
];

function input(overrides: Partial<DependencyNetworkPolicyInput> = {}): DependencyNetworkPolicyInput {
	return {
		kind: 'postgres',
		namespace: NAMESPACE,
		workId: WORK_ID,
		workSlug: WORK_SLUG,
		port: APP_DEPENDENCY_PORTS.postgres,
		...overrides
	};
}

/** The policy's `spec.ingress`, typed loosely: this suite's subject is the JSON a cluster receives. */
type IngressRule = Record<string, any>;

/**
 * A rendered policy with the `spec` this suite reads.
 *
 * `AppDependencyRenderedObject` carries an open index signature (a rendered object may hold anything), so
 * `spec` arrives as `unknown` — this is the shape the assertions below actually index into.
 */
interface RenderedPolicy {
	apiVersion: string;
	kind: string;
	metadata: { name: string; namespace: string; labels: Record<string, string> };
	spec: { podSelector: Record<string, unknown>; policyTypes: string[]; ingress?: IngressRule[]; egress?: unknown };
}

function policyOf(input: DependencyNetworkPolicyInput): RenderedPolicy {
	return renderDependencyNetworkPolicy(input) as unknown as RenderedPolicy;
}

function ingressOf(input: DependencyNetworkPolicyInput): IngressRule[] {
	return policyOf(input).spec.ingress ?? [];
}

/* ------------------------------------------------------------------------- *
 * Name and labels (plan §4.9:576, §4.9:586)
 * ------------------------------------------------------------------------- */

describe('T20/T21 — the shared dep-<kind> policy: name and labels', () => {
	it('names the policy dep-<kind> in the App Work’s namespace, for all three kinds', () => {
		for (const { kind, port } of KINDS) {
			const policy = policyOf(input({ kind, port }));

			expect(policy.apiVersion).toBe(APP_NETWORK_POLICY_API_VERSION);
			expect(policy.kind).toBe('NetworkPolicy');
			expect(policy.metadata.name).toBe(dependencyNetworkPolicyName(String(kind)));
			expect(policy.metadata.namespace).toBe(NAMESPACE);
		}

		expect(policyOf(input({ kind: 'postgres' })).metadata.name).toBe('dep-postgres');
		expect(policyOf(input({ kind: 'redis', port: APP_DEPENDENCY_PORTS.redis })).metadata.name).toBe('dep-redis');
	});

	it('normalises a mixed-case kind, which is why object storage renders dep-s3', () => {
		// `dependencyNetworkPolicyName` fits the name to a Kubernetes resource name, so the *dependency*
		// kind `objectStorage` would render `dep-objectstorage` — and the plan names this row's objects
		// `dep-s3` (`plan.md` §4.9:618, `tasks.md:324`). That is exactly why the object-storage provider
		// passes its object kind `s3` to this renderer instead of its dependency kind, and its own spec
		// asserts the `dep-s3` policy end to end.
		expect(dependencyNetworkPolicyName('objectStorage')).toBe('dep-objectstorage');
		expect(dependencyNetworkPolicyName('s3')).toBe('dep-s3');
	});

	it('carries APW-06’s label set plus ever-works.io/dependency: <kind>', () => {
		for (const { kind, port } of KINDS) {
			const policy = policyOf(input({ kind, port }));

			expect(policy.metadata.labels).toEqual({
				[APP_LABEL_MANAGED_BY]: APP_MANAGED_BY,
				[APP_LABEL_PART_OF]: WORK_SLUG,
				[APP_LABEL_WORK_ID]: WORK_ID,
				[APP_LABEL_KIND]: APP_LABEL_KIND_APP,
				[APP_DEPENDENCY_POLICY_LABEL]: kind
			});
		}
	});

	it('selects only the pods of its own dependency', () => {
		for (const { kind, port } of KINDS) {
			const policy = policyOf(input({ kind, port }));

			// The `matchLabels` a NetworkPolicy requires, over the dependency label — never `{}`: an empty
			// podSelector would put this policy over every pod in the namespace, including the app's own,
			// and hand the dependency's reachability to whoever owns that policy.
			expect(policy.spec.podSelector).toEqual({ matchLabels: dependencyPodSelector(kind) });
			expect(policy.spec.podSelector).toEqual({ matchLabels: { [APP_DEPENDENCY_POLICY_LABEL]: kind } });
		}
	});
});

/* ------------------------------------------------------------------------- *
 * The three ingress ports (plan §4.9:588, FR-38)
 * ------------------------------------------------------------------------- */

describe('T20/T21 — the shared dep-<kind> policy: the three ingress ports', () => {
	it('admits same-namespace pods on its own service port, for each of 5432, 6379 and 9000', () => {
		expect(KINDS.map((entry) => entry.port)).toEqual([5432, 6379, 9000]);

		for (const { kind, port } of KINDS) {
			const ingress = ingressOf(input({ kind, port }));

			expect(ingress).toHaveLength(1);
			// `podSelector: {}` with no `namespaceSelector` is "pods in this policy's own namespace" —
			// the whole of FR-38 for anything outside the App Work, and nothing outside it is admitted.
			expect(ingress[0].from).toEqual([{ podSelector: {} }]);
			expect(ingress[0].ports).toEqual([{ protocol: 'TCP', port }]);
		}
	});

	it('admits no other port of the pod — never every port', () => {
		const ingress = ingressOf(input({ kind: 'redis', port: APP_DEPENDENCY_PORTS.redis }));

		// One rule, one port: an admitted neighbour cannot reach a metrics endpoint, an admin port or a
		// second service the image happens to open.
		expect(ingress).toHaveLength(1);
		expect((ingress[0].ports as unknown[]).length).toBe(1);
	});

	it('is Ingress-only, with no egress rules that could deny the dependency’s own traffic', () => {
		for (const { kind, port } of KINDS) {
			const policy = policyOf(input({ kind, port }));

			expect(policy.spec.policyTypes).toEqual(['Ingress']);
			// An empty `egress` list under `policyTypes: [Egress]` would have denied every lookup the
			// dependency itself makes; the key is absent rather than empty, and this is the assertion.
			expect('egress' in policy.spec).toBe(false);
		}
	});
});

/* ------------------------------------------------------------------------- *
 * APW07-G01 — drawn with isolation off
 * ------------------------------------------------------------------------- */

describe('T20/T21 — the shared dep-<kind> policy: drawn with isolation off (APW07-G01)', () => {
	it('has no isolation input at all — an isolation flag on the input changes nothing', () => {
		// The renderer's whole signature, pinned: one argument. A second parameter is how an isolation
		// switch would arrive, and there is none to pass.
		expect(planDependencyNetworkPolicy.length).toBe(1);

		for (const { kind, port } of KINDS) {
			const strict = policyOf(input({ kind, port }));
			// The App Work's own isolation setting, switched OFF, beside anything else a caller might carry.
			const switchedOff = policyOf({
				...input({ kind, port }),
				isolation: false,
				appWorkIsolation: false
			} as DependencyNetworkPolicyInput);

			expect(switchedOff).toEqual(strict);
			// …and the policy still admits exactly one namespace: this one.
			expect(switchedOff.spec.ingress?.[0].from).toEqual([{ podSelector: {} }]);
		}
	});

	it('produces the object the provider applies — the plan and the render agree', () => {
		for (const { kind, port } of KINDS) {
			const plan = planDependencyNetworkPolicy(input({ kind, port }));

			expect(plan.warnings).toEqual([]);
			expect(plan.policy).toEqual(policyOf(input({ kind, port })));
		}
	});
});

/* ------------------------------------------------------------------------- *
 * The operator-namespace variant (plan §4.9:591-592)
 * ------------------------------------------------------------------------- */

describe('T20/T21 — the shared dep-<kind> policy: the operator-namespace variant', () => {
	it('admits the operator’s namespace on 5432 and the status port, and warns about nothing', () => {
		const plan = planDependencyNetworkPolicy(input({ kind: 'postgres', operatorNamespace: 'cnpg-system' }));
		const ingress = (plan.policy as unknown as RenderedPolicy).spec.ingress ?? [];

		expect(plan.warnings).toEqual([]);
		expect(ingress).toHaveLength(2);
		expect(ingress[1].from).toEqual([
			{ namespaceSelector: { matchLabels: { [APP_NAMESPACE_NAME_LABEL]: 'cnpg-system' } } }
		]);
		expect(ingress[1].ports).toEqual([
			{ protocol: 'TCP', port: APP_DEPENDENCY_PORTS.postgres },
			{ protocol: 'TCP', port: APP_DEPENDENCY_OPERATOR_STATUS_PORT }
		]);
	});

	it('warns operatorNamespaceUnknown and narrows the fallback to those two ports only', () => {
		const plan = planDependencyNetworkPolicy(input({ operatorFallback: true }));
		const ingress = (plan.policy as unknown as RenderedPolicy).spec.ingress ?? [];

		// APW07-G01: a detection failure must not become "no policy" — it becomes a wider rule on two
		// ports, and the warning the card renders.
		expect(plan.warnings).toEqual(['operatorNamespaceUnknown']);
		expect(ingress).toHaveLength(2);
		expect(ingress[1].from).toEqual([{ namespaceSelector: {} }]);
		expect(ingress[1].ports).toEqual([
			{ protocol: 'TCP', port: APP_DEPENDENCY_PORTS.postgres },
			{ protocol: 'TCP', port: APP_DEPENDENCY_OPERATOR_STATUS_PORT }
		]);
	});

	it('draws no operator rule for a kind that never takes the operator path', () => {
		for (const { kind, port } of KINDS.filter((entry) => entry.kind !== 'postgres')) {
			// Redis and object storage always take their plain path, so neither ever carries an operator
			// namespace — and an unrecognised flag must not invent one either.
			const plan = planDependencyNetworkPolicy(input({ kind, port, operatorNamespace: null }));

			expect(plan.warnings).toEqual([]);
			expect((plan.policy as unknown as RenderedPolicy).spec.ingress).toHaveLength(1);
		}
	});

	it('treats a blank namespace as absent rather than as a namespace named “”', () => {
		const blank = planDependencyNetworkPolicy(input({ operatorNamespace: '   ' }));

		expect(blank.warnings).toEqual([]);
		expect((blank.policy as unknown as RenderedPolicy).spec.ingress).toHaveLength(1);
	});

	it('never lets the operator rule reach the dependency’s own port twice or a caller-chosen one', () => {
		const ingress = ingressOf(input({ port: 6379, operatorNamespace: 'cnpg-system' }));

		expect(ingress[0].ports).toEqual([{ protocol: 'TCP', port: 6379 }]);
		// The operator's two ports are the plan's constants, not the kind's port repeated.
		expect(ingress[1].ports).toEqual([
			{ protocol: 'TCP', port: 5432 },
			{ protocol: 'TCP', port: 8000 }
		]);
	});
});
