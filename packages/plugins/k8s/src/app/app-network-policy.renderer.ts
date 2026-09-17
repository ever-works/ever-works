/**
 * T7 — App network policies (plan §4.10, §4.2 step 4; spec FR-20/FR-21; ACC-06-17, ACC-06-54).
 *
 * Pure functions: no I/O, no clock, no cluster access. Every value comes from the render input or
 * from this module's constants, so the same input always renders the same five policies — which
 * matters because a NetworkPolicy is applied by server-side apply, where a byte-different body is
 * still the same object but a *missing* allowance is an outage.
 *
 * ## The two sets, and why `isolation: false` is not a deletion of someone else's policy
 *
 * Plan §4.1 splits the five into a **baseline** three — `ew-default-deny`,
 * `ew-allow-same-namespace`, `ew-allow-egress` — which the `prepare-namespace` op draws before any
 * dependency is provisioned (§4.2 step 4), and a **Deployment** two — `ew-allow-ingress`,
 * `ew-allow-deps` — which only `deployApp`'s `prepare` draws, because until a Deployment runs there
 * is nothing to publish and nothing to depend on. Both names come from `app-names.ts`
 * (`APP_BASELINE_NETWORK_POLICY_NAMES`, `APP_DEPLOYMENT_NETWORK_POLICY_NAMES`), never from a second
 * literal here.
 *
 * With `network.isolation: false` (Your cluster's opt-out) **none** of the five is rendered and
 * {@link planNetworkPolicies} reports exactly those five names as the deletion set.
 * **Added (APW07-G01): that set is never a `dep-<kind>` policy.** APW-07's providers own those:
 * they carry `ever-works.io/dependency: <kind>`, they are drawn before the dependency's own
 * workload, and they keep whatever the App Work's isolation setting — which is what makes FR-38 (a
 * dependency reachable only from the App Work's own pods) hold **even with isolation off**
 * (plan §4.10). {@link isDependencyNetworkPolicyName} names the rule, and the deletion set is built
 * from the two `app-names.ts` constants alone, so no `dep-*` name can enter it by construction.
 *
 * ## The isolation probe (plan §4.10, APW06-G18)
 *
 * The §4.10 rewrite of 2026-09-17 makes the probe reliable: the **policy-level** `spec.podSelector`
 * of `ew-allow-same-namespace`, `ew-allow-egress` and `ew-allow-deps` becomes
 * `{ matchExpressions: [{ key: ever-works.io/isolation-probe, operator: DoesNotExist }] }`, so a pod
 * carrying that label is selected **only** by `ew-default-deny` and has no egress at all — not even
 * DNS. `ew-default-deny` keeps `{}` and `ew-allow-ingress` is unchanged; every **peer** selector
 * stays `podSelector: {}`. The label only ever removes allowances, so a pod that carries it gains
 * nothing.
 *
 * ## What is a parameter, and the gaps that are (reported, not invented)
 *
 * - **The hairpin address.** §4.10's `ew-allow-deps` row wants "the ingress address on 80/443" when
 *   `network.needsHairpin` is true, but §3's `AppRenderInput` carries no address field — it is
 *   *observed* from the cluster at publish time (`AppDeployResult.ingressAddress`, §3.1). It is
 *   therefore a parameter ({@link AppNetworkPolicyOptions.ingressAddress}), never a lookup. A
 *   NetworkPolicy peer can only be a CIDR, an IP or a pod/namespace selector — never a DNS name —
 *   so a hostname-only address renders **no** hairpin rule. That case is reported rather than
 *   papered over with an invented warning code.
 * - **The DNS variant.** §4.10 names two: the `kube-system` `k8s-app=kube-dns` pods, and the
 *   fallback "any namespace, port 53". No field of §3's render input selects between them (which
 *   one a cluster needs is a property of that cluster's DNS, not of the App spec), so the caller
 *   passes {@link AppNetworkPolicyOptions.dns}. The default is the tight one, never the fallback.
 * - **The ingress controller namespace.** `ingress.controllerNamespace` is in the render input; when
 *   it is `null` the fallback of §4.10 is rendered and the specified warning
 *   `ingress_controller_namespace_unknown` is reported.
 */
import { isIP } from 'node:net';

import {
	APP_BASELINE_NETWORK_POLICY_NAMES,
	APP_DEPLOYMENT_NETWORK_POLICY_NAMES,
	APP_DEPENDENCY_POLICY_PREFIX,
	appLabels
} from './app-names.js';

/** The `apiVersion` of every rendered policy. */
export const APP_NETWORK_POLICY_API_VERSION = 'networking.k8s.io/v1';

/** The label the isolation-probe pod carries and the allowance policies exclude (plan §4.10). */
export const APP_ISOLATION_PROBE_LABEL = 'ever-works.io/isolation-probe';

/** The label APW-07's providers put on the `dep-<kind>` policy this renderer must never delete. */
export const APP_DEPENDENCY_POLICY_LABEL = 'ever-works.io/dependency';

/** §4.10 `ew-allow-egress`: DNS lives here by default. */
export const APP_DNS_NAMESPACE = 'kube-system';
/** §4.10 `ew-allow-egress`: the pod labels CoreDNS/DNS pods carry in that namespace. */
export const APP_DNS_POD_SELECTOR = { 'k8s-app': 'kube-dns' };
/** §4.10 `ew-allow-egress`: DNS over both UDP and TCP. */
export const APP_DNS_PORT = 53;
/** `kubernetes.io/metadata.name` — the label Kubernetes writes on every namespace's metadata. */
export const APP_NAMESPACE_NAME_LABEL = 'kubernetes.io/metadata.name';

/** §4.10 `ew-allow-egress`: the internet, minus the ranges below. */
export const APP_PUBLIC_IPV4_CIDR = '0.0.0.0/0';
/** §4.10 `ew-allow-egress`: the internet, minus the ranges below. */
export const APP_PUBLIC_IPV6_CIDR = '::/0';

/**
 * §4.10 `ew-allow-egress`, in the table's own order: private, shared (CGNAT), link-local, loopback,
 * "this network", multicast and reserved. Exactly these nine, and a fixture asserts the array —
 * dropping one would silently let an App reach the owner's own network.
 */
export const APP_IPV4_EXCEPTED_CIDRS = [
	'10.0.0.0/8',
	'172.16.0.0/12',
	'192.168.0.0/16',
	'100.64.0.0/10',
	'169.254.0.0/16',
	'127.0.0.0/8',
	'0.0.0.0/8',
	'224.0.0.0/4',
	'240.0.0.0/4'
] as const;

/** §4.10 `ew-allow-egress`: unique-local, link-local, loopback and multicast, exactly these four. */
export const APP_IPV6_EXCEPTED_CIDRS = ['fc00::/7', 'fe80::/10', '::1/128', 'ff00::/8'] as const;

/** §4.10 `ew-allow-deps`: the hairpin egress the app needs to reach its own published address. */
export const APP_HAIRPIN_PORTS = [80, 443] as const;

/** Which policies to render: both sets, the `prepare-namespace` baseline, or a Deployment's two. */
export type AppNetworkPolicyScope = 'all' | 'baseline' | 'deployment';

/** §4.10 names two DNS shapes; nothing in §3's render input picks one (see the module doc). */
export type AppNetworkPolicyDns = 'kube-dns' | 'any-namespace' | 'both';

/** The App-label fields every policy carries. */
export interface AppNetworkPolicyLabels {
	workId: string;
	workSlug: string;
}

/**
 * A component as §4.10 reads it — structurally a subset of APW-03's resolved component
 * (`AppComponentInput`), so a render input passes straight through.
 */
export interface AppNetworkPolicyComponent {
	name: string;
	role: 'web' | 'worker';
	port?: number | null;
	primary?: boolean;
}

/**
 * The render-input fields §4.10 reads — structurally a subset of `AppRenderInput` (plan §3), the
 * same shape `app-security.ts` uses for §4.4.
 */
export interface AppNetworkPolicyInput {
	ref: { workId: string; namespace: string };
	workSlug: string;
	components: readonly AppNetworkPolicyComponent[];
	ingress: { controllerNamespace?: string | null };
	network: {
		isolation: boolean;
		extraEgress: readonly { cidr: string; ports: readonly number[] }[];
		needsHairpin?: boolean;
	};
}

/** Caller-supplied values §4.10 needs but §3's render input does not carry. */
export interface AppNetworkPolicyOptions {
	/** `'kube-dns'` (default) · `'any-namespace'` · `'both'` — plan §4.10's two DNS shapes. */
	dns?: AppNetworkPolicyDns;
	/** The address observed at publish time (§3.1). An IP renders a rule; a hostname cannot. */
	ingressAddress?: { ip?: string | null; hostname?: string | null } | null;
	/** Which of the two sets to render. `'all'` (default) includes the Deployment-only two. */
	scope?: AppNetworkPolicyScope;
}

/** A warning with one of §4.10's codes — never an invented one. */
export interface AppNetworkPolicyWarning {
	code: 'ingress_controller_namespace_unknown';
	message: string;
}

/**
 * A rendered object. A `type` alias (not an `interface`) so it stays directly assignable to the
 * manifest renderer's `AppRenderedObject` without a cast.
 */
export type AppRenderedPolicy = {
	apiVersion: string;
	kind: string;
	metadata: {
		name: string;
		namespace: string;
		labels: Record<string, string>;
	};
	spec: {
		podSelector: Record<string, unknown>;
		policyTypes: string[];
		ingress?: Record<string, unknown>[];
		egress?: Record<string, unknown>[];
	};
	[key: string]: unknown;
};

/** What a caller applies: the policies, §4.10's warning, and the names to delete. */
export interface AppNetworkPolicyPlan {
	objects: AppRenderedPolicy[];
	warnings: AppNetworkPolicyWarning[];
	/**
	 * The five `ew-*` names when `isolation` is false, otherwise empty. **Never** a `dep-<kind>`
	 * name (APW07-G01) — see {@link isDependencyNetworkPolicyName}.
	 */
	deleteNames: string[];
}

/**
 * The five policy names of §4.1/§4.10, in the table's order: the baseline three a
 * `prepare-namespace` op draws, then the two only a Deployment draws (§4.2).
 */
export function networkPolicyNames(): string[] {
	return [...APP_BASELINE_NETWORK_POLICY_NAMES, ...APP_DEPLOYMENT_NETWORK_POLICY_NAMES];
}

/**
 * Whether a name is one of APW-07's `dep-<kind>` policies — the objects this renderer **never**
 * renders and **never** deletes (plan §4.1, §4.10; R-15, ACC-06-54).
 */
export function isDependencyNetworkPolicyName(name: string): boolean {
	return typeof name === 'string' && name.startsWith(APP_DEPENDENCY_POLICY_PREFIX);
}

/**
 * Every policy §4.10 renders for `options.scope` — all five by default, and an **empty array** when
 * `network.isolation` is false (Your cluster's opt-out, FR-20).
 */
export function renderNetworkPolicies(
	input: AppNetworkPolicyInput,
	options: AppNetworkPolicyOptions = {}
): AppRenderedPolicy[] {
	return planNetworkPolicies(input, options).objects;
}

/** The three baseline policies of §4.2 step 4 — never `ew-allow-ingress` / `ew-allow-deps`. */
export function renderBaselineNetworkPolicies(
	input: AppNetworkPolicyInput,
	options: AppNetworkPolicyOptions = {}
): AppRenderedPolicy[] {
	return renderNetworkPolicies(input, { ...options, scope: 'baseline' });
}

/** The two policies only a Deployment draws (§4.2 step 4). */
export function renderDeploymentNetworkPolicies(
	input: AppNetworkPolicyInput,
	options: AppNetworkPolicyOptions = {}
): AppRenderedPolicy[] {
	return renderNetworkPolicies(input, { ...options, scope: 'deployment' });
}

/**
 * The whole plan: the rendered policies, the warning, and the deletion set.
 *
 * `isolation: false` → `objects: []` and the five names to delete. `isolation: true` →
 * the policies and `deleteNames: []`. Nothing else can enter the deletion set: it is
 * {@link networkPolicyNames}, which is built from the two `app-names.ts` constants.
 */
export function planNetworkPolicies(
	input: AppNetworkPolicyInput,
	options: AppNetworkPolicyOptions = {}
): AppNetworkPolicyPlan {
	const isolation = input?.network?.isolation === true;
	if (!isolation) {
		return { objects: [], warnings: [], deleteNames: networkPolicyNames() };
	}

	const scope = options.scope ?? 'all';
	const objects: AppRenderedPolicy[] = [];

	if (scope !== 'deployment') {
		objects.push(defaultDenyPolicy(input), sameNamespacePolicy(input), allowEgressPolicy(input, options));
	}

	if (scope !== 'baseline') {
		objects.push(allowIngressPolicy(input), allowDepsPolicy(input, options));
	}

	return { objects, warnings: allowIngressWarnings(input, scope, options), deleteNames: [] };
}

// --- the five policies ------------------------------------------------------

/** §4.10 row 1: all pods; both policy types, no rules. */
function defaultDenyPolicy(input: AppNetworkPolicyInput): AppRenderedPolicy {
	return policy(input, 'ew-default-deny', {
		podSelector: {},
		policyTypes: ['Ingress', 'Egress']
	});
}

/** §4.10 row 2: ingress and egress to `podSelector: {}` in this namespace. */
function sameNamespacePolicy(input: AppNetworkPolicyInput): AppRenderedPolicy {
	return policy(input, 'ew-allow-same-namespace', {
		podSelector: allowancePodSelector(),
		policyTypes: ['Ingress', 'Egress'],
		ingress: [{ from: [{ podSelector: {} }] }],
		egress: [{ to: [{ podSelector: {} }] }]
	});
}

/** §4.10 row 4: DNS, then the internet minus every private, loopback, link-local and reserved range. */
function allowEgressPolicy(input: AppNetworkPolicyInput, options: AppNetworkPolicyOptions): AppRenderedPolicy {
	return policy(input, 'ew-allow-egress', {
		podSelector: allowancePodSelector(),
		policyTypes: ['Egress'],
		egress: [
			...dnsRules(options),
			publicEgressRule(APP_PUBLIC_IPV4_CIDR, APP_IPV4_EXCEPTED_CIDRS),
			publicEgressRule(APP_PUBLIC_IPV6_CIDR, APP_IPV6_EXCEPTED_CIDRS)
		]
	});
}

/**
 * §4.10 row 3: the primary web component's pods, from the ingress controller's namespace, on the
 * web port (or the documented fallback when that namespace is unknown).
 *
 * When the App has no primary web component there is nothing to publish, so the policy selects the
 * **empty set** — `ever-works.io/component` with `DoesNotExist`, which no App pod satisfies. That is
 * deliberate fail-closed behaviour: a worker-only App must not have the ingress controller admitted
 * into a worker on every port.
 */
function allowIngressPolicy(input: AppNetworkPolicyInput): AppRenderedPolicy {
	const primary = primaryWebComponent(input);
	if (!primary) {
		// Nothing to publish: no App pod is selected and no rule is admitted, so a worker-only App
		// can never have the ingress controller let into a worker on every port.
		return policy(input, 'ew-allow-ingress', {
			podSelector: componentAbsentSelector(),
			policyTypes: ['Ingress']
		});
	}

	const port = webPort(primary);
	const controllerNamespace = normaliseNamespace(input?.ingress?.controllerNamespace);

	const from = controllerNamespace
		? [
				{
					namespaceSelector: {
						matchLabels: { [APP_NAMESPACE_NAME_LABEL]: controllerNamespace }
					}
				}
			]
		: [{ namespaceSelector: {} }];

	return policy(input, 'ew-allow-ingress', {
		podSelector: componentPodSelector(primary.name),
		policyTypes: ['Ingress'],
		// A fallback admission is scoped to the web port — never left open on every port.
		ingress: port === null ? [{ from }] : [{ from, ports: [{ protocol: 'TCP', port }] }]
	});
}

/** §4.10 row 5: `extraEgress` (the dependency CIDRs the platform resolved) plus the hairpin address. */
function allowDepsPolicy(input: AppNetworkPolicyInput, options: AppNetworkPolicyOptions): AppRenderedPolicy {
	const egress: Record<string, unknown>[] = [];

	for (const entry of input?.network?.extraEgress ?? []) {
		const cidr = normaliseCidr(entry?.cidr);
		if (!cidr) {
			continue;
		}
		const rule: Record<string, unknown> = { to: [{ ipBlock: { cidr } }] };
		const ports = normalisePorts(entry?.ports);
		if (ports.length > 0) {
			rule.ports = ports;
		}
		egress.push(rule);
	}

	if (input?.network?.needsHairpin === true) {
		const hairpin = hairpinRule(options?.ingressAddress);
		if (hairpin) {
			egress.push(hairpin);
		}
	}

	return policy(input, 'ew-allow-deps', {
		podSelector: allowancePodSelector(),
		policyTypes: ['Egress'],
		egress
	});
}

// --- rules ------------------------------------------------------------------

/**
 * The DNS rules of §4.10. `'kube-dns'` (default) is the exact pair of selectors; `'any-namespace'`
 * is the documented fallback; `'both'` renders the two of them, for a cluster whose DNS pods do not
 * carry the `k8s-app=kube-dns` label but whose namespace is still `kube-system`.
 */
function dnsRules(options: AppNetworkPolicyOptions): Record<string, unknown>[] {
	const mode = options?.dns ?? 'kube-dns';
	const ports = [
		{ protocol: 'UDP', port: APP_DNS_PORT },
		{ protocol: 'TCP', port: APP_DNS_PORT }
	];

	const rules: Record<string, unknown>[] = [];

	if (mode === 'kube-dns' || mode === 'both') {
		rules.push({
			to: [
				{
					namespaceSelector: { matchLabels: { [APP_NAMESPACE_NAME_LABEL]: APP_DNS_NAMESPACE } },
					podSelector: { matchLabels: { ...APP_DNS_POD_SELECTOR } }
				}
			],
			ports
		});
	}

	if (mode === 'any-namespace' || mode === 'both') {
		rules.push({ to: [{ namespaceSelector: {} }], ports });
	}

	return rules;
}

/** `0.0.0.0/0` / `::/0` minus the table's ranges. */
function publicEgressRule(cidr: string, except: readonly string[]): Record<string, unknown> {
	return { to: [{ ipBlock: { cidr, except: [...except] } }] };
}

/**
 * The hairpin rule: the ingress address on 80/443 (plan §4.10, FR-37). Only an IP literal can be a
 * NetworkPolicy peer, so a hostname-only address renders nothing — reported as a gap in the module
 * doc rather than guessed at.
 */
function hairpinRule(address: AppNetworkPolicyOptions['ingressAddress']): Record<string, unknown> | null {
	const ip = typeof address?.ip === 'string' ? address.ip.trim() : '';
	const version = isIP(ip);
	if (!version) {
		return null;
	}

	return {
		to: [{ ipBlock: { cidr: `${ip}/${version === 6 ? 128 : 32}` } }],
		ports: APP_HAIRPIN_PORTS.map((port) => ({ protocol: 'TCP', port }))
	};
}

// --- objects ----------------------------------------------------------------

function policy(input: AppNetworkPolicyInput, name: string, spec: AppRenderedPolicy['spec']): AppRenderedPolicy {
	return {
		apiVersion: APP_NETWORK_POLICY_API_VERSION,
		kind: 'NetworkPolicy',
		metadata: {
			name,
			namespace: String(input?.ref?.namespace ?? ''),
			labels: appLabels({ workId: input?.ref?.workId ?? '', workSlug: input?.workSlug ?? '' })
		},
		spec
	};
}

/**
 * The §4.10 probe exclusion: every allowance policy selects pods **without** the probe label, so a
 * probe pod is selected only by `ew-default-deny` and has no egress at all.
 */
function allowancePodSelector(): Record<string, unknown> {
	return {
		matchExpressions: [{ key: APP_ISOLATION_PROBE_LABEL, operator: 'DoesNotExist' }]
	};
}

/** `{ ever-works.io/component: <name> }` — the same selector every App workload uses (§4.1). */
function componentPodSelector(name: string): Record<string, unknown> {
	return { matchLabels: { 'ever-works.io/component': normaliseComponentName(name) } };
}

/** Matches no App pod: every App workload carries `ever-works.io/component` (plan §4.1). */
function componentAbsentSelector(): Record<string, unknown> {
	return { matchExpressions: [{ key: 'ever-works.io/component', operator: 'DoesNotExist' }] };
}

// --- warnings ---------------------------------------------------------------

/**
 * §4.10 row 3's warning, reported only when the policy it belongs to is actually rendered: with
 * `isolation: false` nothing is drawn, and with the `baseline` scope the ingress policy is not part
 * of the set.
 */
function allowIngressWarnings(
	input: AppNetworkPolicyInput,
	scope: AppNetworkPolicyScope,
	options: AppNetworkPolicyOptions
): AppNetworkPolicyWarning[] {
	if (scope === 'baseline' || input?.network?.isolation !== true) {
		return [];
	}

	// Nothing to admit when the App has no primary web component, so the warning would be noise.
	if (!primaryWebComponent(input)) {
		return [];
	}

	if (normaliseNamespace(input?.ingress?.controllerNamespace)) {
		return [];
	}

	return [
		{
			code: 'ingress_controller_namespace_unknown',
			message:
				'The ingress controller’s namespace is unknown, so the primary web component accepts traffic from every namespace on its web port. Run Check connection to record it.'
		}
	];
}

// --- helpers ----------------------------------------------------------------

/** The primary web component of §4.3/§4.10, or `null` when the App has none. */
function primaryWebComponent(input: AppNetworkPolicyInput): AppNetworkPolicyComponent | null {
	const components = Array.isArray(input?.components) ? input.components : [];
	const marked = components.find((component) => component?.role === 'web' && component?.primary === true);
	if (marked) {
		return marked;
	}

	const webs = components.filter((component) => component?.role === 'web');
	return webs.length === 1 ? webs[0] : null;
}

function webPort(component: AppNetworkPolicyComponent | null): number | null {
	const port = component?.port;
	return typeof port === 'number' && Number.isFinite(port) && port > 0 ? Math.floor(port) : null;
}

function normalisePorts(ports: readonly number[] | undefined): { protocol: string; port: number }[] {
	if (!Array.isArray(ports)) {
		return [];
	}

	return ports
		.filter((port) => typeof port === 'number' && Number.isFinite(port) && port > 0)
		.map((port) => ({ protocol: 'TCP', port: Math.floor(port) }));
}

/** A CIDR as written, or `null` when it cannot be one — an unusable entry grants nothing. */
function normaliseCidr(cidr: unknown): string | null {
	const value = typeof cidr === 'string' ? cidr.trim() : '';
	if (!value) {
		return null;
	}

	const [address, prefix] = value.split('/');
	const version = isIP(address ?? '');
	if (!version || prefix === undefined || !/^\d{1,3}$/.test(prefix)) {
		return null;
	}

	const size = Number(prefix);
	return size >= 0 && size <= (version === 6 ? 128 : 32) ? value : null;
}

function normaliseNamespace(value: unknown): string | null {
	const namespace = typeof value === 'string' ? value.trim() : '';
	return namespace ? namespace : null;
}

function normaliseComponentName(value: unknown): string {
	const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
	return name || 'app';
}
