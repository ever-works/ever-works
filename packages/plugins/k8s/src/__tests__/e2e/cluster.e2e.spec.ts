/**
 * End-to-end test against a real Kubernetes cluster.
 *
 * Run conditions:
 *   - `KUBECONFIG_E2E_PATH` env var points at a kubeconfig file connected
 *     to a reachable cluster (kind, k3d, EKS, etc).
 *
 * The test exercises every code path that touches the K8s API:
 *   - validateConnection (server version, IngressClass listing)
 *   - ensureNamespace (idempotent create)
 *   - applyDeployment / applyService (server-side apply)
 *   - getDeployment + status mapping
 *   - listManagedDeployments (label-selector listing)
 *   - cleanup
 *
 * Mocked tests already cover the unit boundaries; this suite catches
 * everything those can't: real API serialization, RBAC, server-side
 * apply field-manager semantics, IngressClass schema differences across
 * Kubernetes versions, and the `createRequire(import.meta.url)` ESM
 * loader path actually working at runtime.
 *
 * The CI workflow at `.github/workflows/k8s-e2e.yml` provisions a kind
 * cluster, installs ingress-nginx, exports `KUBECONFIG_E2E_PATH`, and
 * runs `pnpm test:e2e` from this package.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { KubernetesApiService } from '../../k8s-api.service.js';
import { buildDeployment, buildService } from '../../manifest.renderer.js';
import { mapDeploymentToStatus } from '../../status.mapper.js';

const E2E_PATH = process.env.KUBECONFIG_E2E_PATH;
const describeE2E = E2E_PATH ? describe : describe.skip;

const NAMESPACE = `everworks-e2e-${Date.now()}`;
const WORK_SLUG = 'e2e-site';
const WORK_ID = 'e2e-test-work';
// Tiny image with a working `/` endpoint for the readiness probe.
// `nginxinc/nginx-unprivileged` runs as a non-root user, matching what
// the platform-rendered Deployment expects.
const IMAGE = 'nginxinc/nginx-unprivileged:1.27-alpine';

describeE2E('k8s plugin e2e — against real cluster', () => {
	let kubeconfig: string;
	const api = new KubernetesApiService();

	beforeAll(() => {
		kubeconfig = readFileSync(E2E_PATH!, 'utf-8');
	});

	afterAll(async () => {
		// Best-effort cleanup. We don't fail the suite if teardown errors —
		// the kind cluster is ephemeral and the workflow tears it down anyway.
		try {
			const k8s = await import('@kubernetes/client-node');
			const kc = new k8s.KubeConfig();
			kc.loadFromString(kubeconfig);
			const core = kc.makeApiClient(k8s.CoreV1Api);
			await core.deleteNamespace({ name: NAMESPACE });
		} catch {
			// Ignore — namespace teardown is opportunistic.
		}
	}, 60_000);

	it('validateConnection returns server version + ingress classes', async () => {
		const info = await api.validateConnection(kubeconfig, {
			hasStrategyFor: (c) => c === 'k8s.io/ingress-nginx' || c === 'traefik.io/ingress-controller'
		});

		expect(info.clusterName).toBeTruthy();
		expect(info.serverUrl).toMatch(/^https?:\/\//);
		expect(info.serverVersion).toMatch(/^v\d+\.\d+/);
		expect(info.serverFingerprint).toMatch(/^[0-9a-f]{16}$/);
		// `ingressClasses` may be empty on a fresh cluster — we verify it
		// resolves at all (non-throwing) rather than asserting contents,
		// since the workflow has variants with and without nginx installed.
		expect(Array.isArray(info.ingressClasses)).toBe(true);
	}, 30_000);

	it('ensureNamespace is idempotent', async () => {
		await api.ensureNamespace(kubeconfig, NAMESPACE);
		// Second call must not throw — exercises the read-then-skip path.
		await api.ensureNamespace(kubeconfig, NAMESPACE);
	}, 30_000);

	it('applyDeployment + applyService converge to a Ready Deployment', async () => {
		const deployment = buildDeployment({
			workId: WORK_ID,
			workSlug: WORK_SLUG,
			namespace: NAMESPACE,
			image: IMAGE,
			replicas: 1,
			containerPort: 8080, // nginx-unprivileged listens on 8080
			hosts: []
		});
		const service = buildService({
			workId: WORK_ID,
			workSlug: WORK_SLUG,
			namespace: NAMESPACE,
			image: IMAGE,
			replicas: 1,
			containerPort: 8080,
			hosts: []
		});

		await api.applyDeployment(kubeconfig, deployment);
		await api.applyService(kubeconfig, service);

		// Poll until the Deployment is Available or 90s elapses. kind +
		// `nginx-unprivileged:alpine` typically converges in <30s but
		// CI runners are slower under contention.
		const deadline = Date.now() + 90_000;
		let status: ReturnType<typeof mapDeploymentToStatus> = 'pending';
		while (Date.now() < deadline) {
			const fetched = await api.getDeployment(kubeconfig, NAMESPACE, WORK_SLUG);
			status = mapDeploymentToStatus(fetched);
			if (status === 'ready' || status === 'error') break;
			await new Promise((r) => setTimeout(r, 3_000));
		}

		expect(status).toBe('ready');
	}, 120_000);

	it('listManagedDeployments returns the deployment we just created', async () => {
		const managed = await api.listManagedDeployments(kubeconfig);
		const ours = managed.find((d) => d.namespace === NAMESPACE && d.name === WORK_SLUG);
		expect(ours).toBeDefined();
		expect(ours?.workId).toBe(WORK_ID);
	}, 30_000);

	it('getDeployment returns null for a missing Deployment', async () => {
		const result = await api.getDeployment(kubeconfig, NAMESPACE, 'definitely-not-there');
		expect(result).toBeNull();
	}, 30_000);

	it('getIngressLoadBalancerHost returns null when no Ingress exists', async () => {
		const host = await api.getIngressLoadBalancerHost(kubeconfig, NAMESPACE, WORK_SLUG);
		expect(host).toBeNull();
	}, 30_000);
});
