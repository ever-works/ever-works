/**
 * Lane works-security — the WEBSITE path of the `k8s` plugin and a MEMBER-SUPPLIED kubeconfig.
 *
 * `validateConnection` (Save & verify), `listClusterNodes`, `deploy`, `getDeploymentStatus`, `listProjects`,
 * `lookupExistingDeployment` and the four domain members load the kubeconfig into `@kubernetes/client-node`
 * in the API process. One naming an `exec` / `auth-provider` plugin, or a token / certificate / key FILE,
 * makes that client run a command or read a file of the API host. With
 * `EVER_WORKS_K8S_MEMBER_KUBECONFIG_EXEC_ALLOWED` off (the default) such a kubeconfig is refused before the
 * client factory is ever called — unless it is provably the operator's (a platform-managed cluster source, or
 * one of the operator's environment kubeconfigs). `'true'` restores the previous behaviour exactly.
 *
 * Also pinned here: the two client/guard gaps this lane closed in the §6.1 guard itself — `token-file` (read
 * by the client while it LOADS the kubeconfig) and YAML merge keys (applied by the client's js-yaml 4, not by
 * this plugin's js-yaml 5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import type { DeploymentConfig, DeploymentLookupContext } from '@ever-works/plugin';

import {
	KubernetesPlugin,
	MEMBER_KUBECONFIG_EXEC_ALLOWED_ENV,
	isOperatorKubeconfig,
	memberKubeconfigExecAllowed
} from '../k8s.plugin';
import { KubernetesApiService, defaultClientFactory, type KubernetesClientFactory } from '../k8s-api.service';
import { K8sPluginError } from '../errors';
import { assertSupportedKubeconfig, findLocalCredentialSource } from '../app/app-kubeconfig.guard';

const VALID = readFileSync(resolve(__dirname, 'fixtures/kubeconfig-valid.yml'), 'utf-8');
const EXEC = readFileSync(resolve(__dirname, 'fixtures/kubeconfig-exec.yml'), 'utf-8');

type Mapping = Record<string, unknown>;

/** `VALID` with its one user / cluster edited, re-dumped. */
function edited(edit: (parts: { user: Mapping; cluster: Mapping; doc: Mapping }) => void): string {
	const doc = yaml.load(VALID) as { users: Array<{ user: Mapping }>; clusters: Array<{ cluster: Mapping }> };
	edit({ user: doc.users[0].user, cluster: doc.clusters[0].cluster, doc: doc as unknown as Mapping });
	return yaml.dump(doc, { lineWidth: -1 });
}

/** A kubeconfig whose every identifying value carries a marker — any echo of it is detectable. */
const MARKED_EXEC = [
	'apiVersion: v1',
	'kind: Config',
	'current-context: ctx-MARK-1',
	'clusters:',
	'  - name: cluster-MARK-2',
	'    cluster:',
	'      server: https://host-MARK-3.example.com:6443',
	'      certificate-authority-data: Q0EtTUFSSy00',
	'contexts:',
	'  - name: ctx-MARK-1',
	'    context: { cluster: cluster-MARK-2, user: user-MARK-5 }',
	'users:',
	'  - name: user-MARK-5',
	'    user:',
	'      exec:',
	'        apiVersion: client.authentication.k8s.io/v1beta1',
	'        command: /usr/local/bin/cmd-MARK-6',
	'        args: ["--secret", "arg-MARK-7"]',
	''
].join('\n');

/** `exec` hidden behind a merge key: js-yaml 5 (this plugin) keeps `<<` literal, js-yaml 4 (the client) merges it. */
const MERGE_HIDDEN_EXEC = [
	'apiVersion: v1',
	'kind: Config',
	'current-context: kind-dev',
	'x-hidden: &hidden',
	'  exec: { apiVersion: client.authentication.k8s.io/v1beta1, command: /bin/sh }',
	'clusters:',
	'  - name: kind-dev',
	'    cluster: { server: "https://kind.example.com:6443", certificate-authority-data: Q0E= }',
	'contexts:',
	'  - name: kind-dev',
	'    context: { cluster: kind-dev, user: kind-admin }',
	'users:',
	'  - name: kind-admin',
	'    user:',
	'      <<: *hidden',
	'      token: abc',
	''
].join('\n');

/** The selected context uses a token; ANOTHER user of the document is an exec plugin. */
const MULTI_CONTEXT_EXEC = edited(({ doc }) => {
	(doc.contexts as Mapping[]).push({ name: 'kind-dev ', context: { cluster: 'kind-dev', user: 'sneaky' } });
	(doc.users as Mapping[]).push({ name: 'sneaky', user: { exec: { command: '/bin/sh' } } });
});

/** A `!!merge` tag: the client's js-yaml 4 reads it, this plugin's js-yaml 5 cannot — so it cannot be checked. */
const UNREADABLE = MERGE_HIDDEN_EXEC.replace('      <<: *hidden', '      !!merge <<: *hidden');

const LOCAL_SOURCE_VARIANTS: Array<{ label: string; kubeconfig: string; mentions: RegExp }> = [
	{ label: 'exec', kubeconfig: EXEC, mentions: /exec credential plugin \('exec'\)/ },
	{
		label: 'auth-provider',
		kubeconfig: edited(({ user }) => {
			user['auth-provider'] = { name: 'gcp', config: { 'cmd-path': '/bin/sh' } };
		}),
		mentions: /'auth-provider'/
	},
	{
		label: 'tokenFile',
		kubeconfig: edited(({ user }) => {
			user.tokenFile = '/var/run/secrets/kubernetes.io/serviceaccount/token';
		}),
		mentions: /'tokenFile'/
	},
	{
		label: 'token-file',
		kubeconfig: edited(({ user }) => {
			delete user.token;
			user['token-file'] = '/var/run/secrets/kubernetes.io/serviceaccount/token';
		}),
		mentions: /'token-file'/
	},
	{
		label: 'client-certificate',
		kubeconfig: edited(({ user }) => {
			user['client-certificate'] = '/etc/kubernetes/pki/apiserver.crt';
		}),
		mentions: /'client-certificate'/
	},
	{
		label: 'client-key',
		kubeconfig: edited(({ user }) => {
			user['client-key'] = '/etc/kubernetes/pki/apiserver.key';
		}),
		mentions: /'client-key'/
	},
	{ label: 'merge key', kubeconfig: MERGE_HIDDEN_EXEC, mentions: /merge key/ },
	{ label: 'another context’s exec user', kubeconfig: MULTI_CONTEXT_EXEC, mentions: /exec credential plugin/ },
	{ label: 'a document the check cannot read', kubeconfig: UNREADABLE, mentions: /could not be read/ }
];

/** A client factory over recording mocks — `createKubeConfig` is THE "kubeconfig was loaded" signal. */
function mockFactory() {
	const createKubeConfig = vi.fn(() => ({
		loadFromString: vi.fn(),
		setCurrentContext: vi.fn(),
		makeApiClient: vi.fn()
	}));
	const factory: KubernetesClientFactory = {
		createKubeConfig: createKubeConfig as never,
		versionApi: () => ({ getCode: vi.fn(async () => ({ gitVersion: 'v1.30.4' })) }) as never,
		networkingV1Api: () =>
			({
				listIngressClass: vi.fn(async () => ({
					items: [{ metadata: { name: 'nginx' }, spec: { controller: 'k8s.io/ingress-nginx' } }]
				})),
				readNamespacedIngress: vi.fn(async () => ({ metadata: { name: 'my-site' }, spec: { rules: [] } }))
			}) as never,
		appsV1Api: () =>
			({
				readNamespacedDeployment: vi.fn(async () => ({
					metadata: { name: 'my-site', namespace: 'ever-works' },
					status: { conditions: [{ type: 'Available', status: 'True' }] }
				})),
				listDeploymentForAllNamespaces: vi.fn(async () => ({ items: [] }))
			}) as never,
		coreV1Api: () =>
			({
				readNamespace: vi.fn(async () => ({ metadata: { name: 'ever-works' } })),
				createNamespace: vi.fn(async () => undefined),
				listNode: vi.fn(async () => ({ items: [] }))
			}) as never,
		objectApi: () => ({ patch: vi.fn(async () => undefined) }) as never,
		authorizationV1Api: () => ({}) as never
	};
	return { factory, createKubeConfig };
}

function pluginWithFactory() {
	const { factory, createKubeConfig } = mockFactory();
	const plugin = new KubernetesPlugin({ api: new KubernetesApiService(factory) });
	return { plugin, createKubeConfig };
}

function deployConfig(clusterSource?: string): DeploymentConfig {
	return {
		projectName: 'my-site',
		sourceDir: '.',
		options: {
			githubOwner: 'acme',
			websiteRepoIsPrivate: false,
			githubReadPackagesToken: 'read-packages-token',
			...(clusterSource ? { settingsOverride: { clusterSource } } : {})
		}
	} as DeploymentConfig;
}

function lookup(clusterSource?: string): DeploymentLookupContext {
	return (clusterSource ? { settingsOverride: { clusterSource } } : {}) as DeploymentLookupContext;
}

/** Every website member, called with `kubeconfig` — each must refuse without building a client. */
function websiteCalls(plugin: KubernetesPlugin, kubeconfig: string, clusterSource = 'custom-kubeconfig') {
	const ctx = lookup(clusterSource);
	return [
		{ label: 'listClusterNodes', run: () => plugin.listClusterNodes(kubeconfig) },
		{ label: 'deploy', run: () => plugin.deploy(deployConfig(clusterSource), kubeconfig) },
		{ label: 'listProjects', run: () => plugin.listProjects(kubeconfig) },
		{
			label: 'lookupExistingDeployment',
			run: () => plugin.lookupExistingDeployment('my-site', kubeconfig, undefined, ctx)
		},
		{ label: 'getDomains', run: () => plugin.getDomains('ever-works/my-site', kubeconfig, undefined, ctx) },
		{
			label: 'addDomain',
			run: () => plugin.addDomain('ever-works/my-site', 'shop.example.com', kubeconfig, undefined, ctx)
		},
		{
			label: 'removeDomain',
			run: () => plugin.removeDomain('ever-works/my-site', 'shop.example.com', kubeconfig, undefined, ctx)
		},
		{
			label: 'verifyDomain',
			run: () => plugin.verifyDomain('ever-works/my-site', 'shop.example.com', kubeconfig, undefined, ctx)
		}
	];
}

const OPERATOR_ENVS = [
	'EVER_WORKS_K8S_WORKS_KUBECONFIG',
	'EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG',
	'EVER_WORKS_DEPLOY_KUBECONFIG',
	'EVER_WORKS_DEPLOY_KUBECONFIG_PATH'
];

beforeEach(() => {
	vi.stubEnv(MEMBER_KUBECONFIG_EXEC_ALLOWED_ENV, undefined);
	for (const name of OPERATOR_ENVS) vi.stubEnv(name, undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe('the switch — EVER_WORKS_K8S_MEMBER_KUBECONFIG_EXEC_ALLOWED', () => {
	it('is off unless the value is exactly true', () => {
		expect(MEMBER_KUBECONFIG_EXEC_ALLOWED_ENV).toBe('EVER_WORKS_K8S_MEMBER_KUBECONFIG_EXEC_ALLOWED');
		expect(memberKubeconfigExecAllowed({})).toBe(false);
		for (const value of ['', 'TRUE', 'True', ' true', '1', 'yes', 'on']) {
			expect(memberKubeconfigExecAllowed({ [MEMBER_KUBECONFIG_EXEC_ALLOWED_ENV]: value }), value).toBe(false);
		}
		expect(memberKubeconfigExecAllowed({ [MEMBER_KUBECONFIG_EXEC_ALLOWED_ENV]: 'true' })).toBe(true);
	});
});

describe('switch off (default) — a member kubeconfig with a local credential source is refused before the client', () => {
	it('validateConnection (Save & verify) refuses an exec kubeconfig as a validation failure — explicit and defaulted source', async () => {
		const { plugin, createKubeConfig } = pluginWithFactory();

		for (const settings of [{ clusterSource: 'custom-kubeconfig', kubeconfig: EXEC }, { kubeconfig: EXEC }]) {
			const result = await plugin.validateConnection(settings);
			expect(result.success).toBe(false);
			expect(result.message).toMatch(/not accepted for a pasted kubeconfig on this installation/);
			expect(result.message).toContain(MEMBER_KUBECONFIG_EXEC_ALLOWED_ENV);
		}
		expect(createKubeConfig).not.toHaveBeenCalled();
	});

	it('never echoes the kubeconfig in the refusal', async () => {
		const { plugin, createKubeConfig } = pluginWithFactory();

		const result = await plugin.validateConnection({ clusterSource: 'custom-kubeconfig', kubeconfig: MARKED_EXEC });
		expect(result.success).toBe(false);
		expect(result.message).not.toMatch(/MARK/);
		const thrown = await plugin.deploy(deployConfig('custom-kubeconfig'), EXEC).catch((e: unknown) => e);
		for (const fragment of ['aws-iam-authenticator', 'eks-user', 'eks-prod', 'EXAMPLE', 'amazonaws']) {
			expect((thrown as Error).message).not.toContain(fragment);
		}
		expect(createKubeConfig).not.toHaveBeenCalled();
	});

	it('deploy throws a KUBECONFIG_UNSUPPORTED K8sPluginError, before any client call', async () => {
		const { plugin, createKubeConfig } = pluginWithFactory();

		const error = await plugin.deploy(deployConfig('custom-kubeconfig'), EXEC).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(K8sPluginError);
		expect(error).toMatchObject({ code: 'KUBECONFIG_UNSUPPORTED' });
		expect((error as Error).message).toMatch(/Exec credential plugins .* are not accepted for a pasted kubeconfig/);
		expect(createKubeConfig).not.toHaveBeenCalled();
	});

	it('getDeploymentStatus reports the refusal as its error status, without a client', async () => {
		const { plugin, createKubeConfig } = pluginWithFactory();

		const result = await plugin.getDeploymentStatus('ever-works/my-site', EXEC, lookup('custom-kubeconfig'));

		expect(result).toMatchObject({
			status: 'error',
			error: expect.stringMatching(/not accepted for a pasted kubeconfig/)
		});
		expect(createKubeConfig).not.toHaveBeenCalled();
	});

	it('every other website member refuses it too', async () => {
		const { plugin, createKubeConfig } = pluginWithFactory();

		for (const { label, run } of websiteCalls(plugin, EXEC)) {
			await expect(run(), label).rejects.toMatchObject({ code: 'KUBECONFIG_UNSUPPORTED' });
		}
		// No settings travel with these two, so a missing source is no exemption either.
		await expect(plugin.listClusterNodes(EXEC, 'eks-prod')).rejects.toBeInstanceOf(K8sPluginError);
		await expect(plugin.listProjects(EXEC)).rejects.toBeInstanceOf(K8sPluginError);
		expect(createKubeConfig).not.toHaveBeenCalled();
	});

	it('refuses every local credential source, a merge-hidden exec, an exec user of another context, and an uncheckable document', async () => {
		const { plugin, createKubeConfig } = pluginWithFactory();

		for (const { label, kubeconfig, mentions } of LOCAL_SOURCE_VARIANTS) {
			const result = await plugin.validateConnection({ clusterSource: 'custom-kubeconfig', kubeconfig });
			expect(result.success, label).toBe(false);
			expect(result.message, label).toMatch(mentions);
			expect(result.message, label).toContain(MEMBER_KUBECONFIG_EXEC_ALLOWED_ENV);
			await expect(plugin.deploy(deployConfig('custom-kubeconfig'), kubeconfig), label).rejects.toBeInstanceOf(
				K8sPluginError
			);
		}
		expect(createKubeConfig).not.toHaveBeenCalled();
	});
});

describe('unaffected — static-token kubeconfigs, the switch, and platform-managed kubeconfigs', () => {
	it('a static-token kubeconfig is accepted on every member, as before', async () => {
		const { plugin, createKubeConfig } = pluginWithFactory();

		const validation = await plugin.validateConnection({ clusterSource: 'custom-kubeconfig', kubeconfig: VALID });
		expect(validation).toMatchObject({ success: true, details: { requiresExecPlugin: false } });
		await expect(plugin.deploy(deployConfig('custom-kubeconfig'), VALID)).resolves.toMatchObject({
			status: 'deploying'
		});
		for (const { label, run } of websiteCalls(plugin, VALID)) {
			await expect(run(), label).resolves.not.toThrow();
		}
		expect(createKubeConfig).toHaveBeenCalled();
	});

	it('EVER_WORKS_K8S_MEMBER_KUBECONFIG_EXEC_ALLOWED=true restores the previous behaviour, requiresExecPlugin included', async () => {
		vi.stubEnv(MEMBER_KUBECONFIG_EXEC_ALLOWED_ENV, 'true');
		const { plugin, createKubeConfig } = pluginWithFactory();

		const validation = await plugin.validateConnection({ clusterSource: 'custom-kubeconfig', kubeconfig: EXEC });
		expect(validation).toMatchObject({ success: true, details: { requiresExecPlugin: true } });
		await expect(plugin.deploy(deployConfig('custom-kubeconfig'), EXEC)).resolves.toMatchObject({
			status: 'deploying'
		});
		await expect(
			plugin.getDeploymentStatus('ever-works/my-site', EXEC, lookup('custom-kubeconfig'))
		).resolves.toMatchObject({ status: 'ready' });
		for (const { kubeconfig } of LOCAL_SOURCE_VARIANTS.slice(0, 6)) {
			await expect(plugin.listClusterNodes(kubeconfig)).resolves.toEqual([]);
		}
		expect(createKubeConfig).toHaveBeenCalled();
	});

	it('a platform-managed cluster source (k8s-works / k8s-works-shared) with an exec kubeconfig still works', async () => {
		const { plugin, createKubeConfig } = pluginWithFactory();

		await expect(plugin.deploy(deployConfig('k8s-works-shared'), EXEC)).resolves.toMatchObject({
			status: 'deploying'
		});
		await expect(
			plugin.getDeploymentStatus('ever-works/my-site', EXEC, lookup('k8s-works'))
		).resolves.toMatchObject({
			status: 'ready'
		});
		for (const { label, run } of websiteCalls(plugin, EXEC, 'k8s-works').filter(
			(call) => call.label !== 'listClusterNodes' && call.label !== 'listProjects'
		)) {
			await expect(run(), label).resolves.not.toThrow();
		}
		expect(createKubeConfig).toHaveBeenCalled();
		// validateConnection never dials a platform-managed source at all.
		await expect(
			plugin.validateConnection({ clusterSource: 'k8s-works', kubeconfig: EXEC })
		).resolves.toMatchObject({
			success: true
		});
	});

	it('the operator’s environment kubeconfig is accepted even where the stored source says custom-kubeconfig (the managed ever-works provider)', async () => {
		const { plugin, createKubeConfig } = pluginWithFactory();

		for (const name of [
			'EVER_WORKS_DEPLOY_KUBECONFIG',
			'EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG',
			'EVER_WORKS_K8S_WORKS_KUBECONFIG'
		]) {
			vi.stubEnv(name, `\n${EXEC}\n\n`);
			await expect(plugin.deploy(deployConfig('custom-kubeconfig'), EXEC), name).resolves.toMatchObject({
				status: 'deploying'
			});
			// And on the members that carry no settings at all.
			await expect(plugin.listClusterNodes(EXEC), name).resolves.toEqual([]);
			vi.stubEnv(name, undefined);
		}
		expect(createKubeConfig).toHaveBeenCalled();
		// A different kubeconfig in that variable proves nothing about this one.
		vi.stubEnv('EVER_WORKS_DEPLOY_KUBECONFIG', VALID);
		await expect(plugin.deploy(deployConfig('custom-kubeconfig'), EXEC)).rejects.toMatchObject({
			code: 'KUBECONFIG_UNSUPPORTED'
		});
	});

	it('…including one the operator keeps in a file (EVER_WORKS_DEPLOY_KUBECONFIG_PATH)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'ew-k8s-operator-'));
		try {
			const path = join(dir, 'kubeconfig');
			writeFileSync(path, EXEC, 'utf-8');
			vi.stubEnv('EVER_WORKS_DEPLOY_KUBECONFIG_PATH', path);
			const { plugin } = pluginWithFactory();

			await expect(
				plugin.lookupExistingDeployment('my-site', EXEC, undefined, lookup('custom-kubeconfig'))
			).resolves.toMatchObject({ found: true });
			expect(isOperatorKubeconfig(EXEC)).toBe(true);
			expect(isOperatorKubeconfig(MARKED_EXEC)).toBe(false);

			vi.stubEnv('EVER_WORKS_DEPLOY_KUBECONFIG_PATH', join(dir, 'missing'));
			expect(isOperatorKubeconfig(EXEC)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('the two client gaps closed in the §6.1 guard (App and dependency paths too)', () => {
	it('the premise: @kubernetes/client-node reads token-file while LOADING, and applies merge keys', () => {
		const dir = mkdtempSync(join(tmpdir(), 'ew-k8s-token-file-'));
		try {
			const path = join(dir, 'token');
			writeFileSync(path, 'platform-service-account-token', 'utf-8');
			const withTokenFile = edited(({ user }) => {
				delete user.token;
				user['token-file'] = path;
			});
			const loaded = defaultClientFactory.createKubeConfig(withTokenFile) as unknown as {
				getCurrentUser(): { token?: string; exec?: unknown } | null;
			};
			expect(loaded.getCurrentUser()?.token).toBe('platform-service-account-token');

			const merged = defaultClientFactory.createKubeConfig(MERGE_HIDDEN_EXEC) as unknown as {
				getCurrentUser(): { exec?: unknown } | null;
			};
			expect(merged.getCurrentUser()?.exec).toBeTruthy();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('assertSupportedKubeconfig now refuses token-file and a merge key', () => {
		const tokenFile = LOCAL_SOURCE_VARIANTS.find((v) => v.label === 'token-file')!.kubeconfig;
		expect(() => assertSupportedKubeconfig(tokenFile)).toThrow(/'token-file'/);
		expect(() => assertSupportedKubeconfig(MERGE_HIDDEN_EXEC)).toThrow(/merge key/);
		expect(() => assertSupportedKubeconfig(VALID)).not.toThrow();
	});

	it('checkClusterCredentialShape maps both to fixed sentences', () => {
		const plugin = new KubernetesPlugin();
		const tokenFile = LOCAL_SOURCE_VARIANTS.find((v) => v.label === 'token-file')!.kubeconfig;

		expect(plugin.checkClusterCredentialShape(tokenFile)).toMatchObject({
			ok: false,
			code: 'KUBECONFIG_UNSUPPORTED',
			message: expect.stringMatching(/token-file/)
		});
		expect(plugin.checkClusterCredentialShape(MERGE_HIDDEN_EXEC)).toMatchObject({
			ok: false,
			code: 'KUBECONFIG_UNSUPPORTED',
			message: expect.stringMatching(/merge key/)
		});
	});

	it('findLocalCredentialSource answers which rule matched, for every user, and null for a token kubeconfig', () => {
		expect(findLocalCredentialSource(VALID)).toBeNull();
		expect(findLocalCredentialSource(EXEC)).toEqual({ kind: 'field', field: 'exec' });
		expect(findLocalCredentialSource(MULTI_CONTEXT_EXEC)).toEqual({ kind: 'field', field: 'exec' });
		expect(findLocalCredentialSource(MERGE_HIDDEN_EXEC)).toEqual({ kind: 'merge-key' });
		expect(findLocalCredentialSource(UNREADABLE)).toEqual({ kind: 'unreadable' });
		expect(findLocalCredentialSource('')).toEqual({ kind: 'unreadable' });
	});
});
