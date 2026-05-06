import yaml from 'js-yaml';
import { createHash } from 'node:crypto';
import { K8sPluginError } from './errors.js';

/**
 * Subset of the kubeconfig spec we care about. Anything we don't read is
 * passed through opaquely.
 */
interface RawKubeconfig {
	apiVersion?: string;
	kind?: string;
	'current-context'?: string;
	contexts?: Array<{ name: string; context: { cluster: string; user: string; namespace?: string } }>;
	clusters?: Array<{
		name: string;
		cluster: { server: string; 'certificate-authority-data'?: string; 'certificate-authority'?: string };
	}>;
	users?: Array<{
		name: string;
		user: {
			token?: string;
			'client-certificate-data'?: string;
			'client-key-data'?: string;
			exec?: { command: string; args?: string[]; env?: Array<{ name: string; value: string }> };
		};
	}>;
}

export interface ParsedKubeconfig {
	currentContext: string;
	clusterName: string;
	server: string;
	userName: string;
	namespace?: string;
	clusterCa?: string;
	requiresExecPlugin: boolean;
	fingerprint: string;
}

/**
 * Parse a kubeconfig YAML string and validate its essential fields.
 *
 * Throws K8sPluginError for any user-correctable problem. Never includes
 * raw config content in the error message — `errors.scrubError` is the
 * second line of defence but we don't rely on it.
 */
export function parseKubeconfig(input: string, contextOverride?: string): ParsedKubeconfig {
	if (!input || input.trim().length === 0) {
		throw new K8sPluginError('INVALID_YAML', 'kubeconfig is empty');
	}

	let doc: unknown;
	try {
		doc = yaml.load(input);
	} catch (err) {
		throw new K8sPluginError(
			'INVALID_YAML',
			`kubeconfig YAML is invalid: ${err instanceof Error ? err.message : String(err)}`
		);
	}

	if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
		throw new K8sPluginError('INVALID_YAML', 'kubeconfig must be a YAML mapping at the root');
	}

	const cfg = doc as RawKubeconfig;

	if (cfg.kind !== undefined && cfg.kind !== 'Config') {
		throw new K8sPluginError('INVALID_YAML', `kubeconfig kind must be 'Config' (got '${cfg.kind}')`);
	}

	const wantedContext = contextOverride?.trim() || cfg['current-context']?.trim();
	if (!wantedContext) {
		throw new K8sPluginError(
			'MISSING_CONTEXT',
			'kubeconfig is missing a current-context (and no context override was provided)'
		);
	}

	const contexts = cfg.contexts ?? [];
	const ctx = contexts.find((c) => c.name === wantedContext);
	if (!ctx) {
		throw new K8sPluginError('MISSING_CONTEXT', `kubeconfig has no context named '${wantedContext}'`);
	}

	const clusters = cfg.clusters ?? [];
	const cluster = clusters.find((c) => c.name === ctx.context.cluster);
	if (!cluster) {
		throw new K8sPluginError('MISSING_CLUSTER', `kubeconfig has no cluster named '${ctx.context.cluster}'`);
	}

	if (!cluster.cluster.server) {
		throw new K8sPluginError('MISSING_CLUSTER', `cluster '${cluster.name}' is missing a server URL`);
	}

	const users = cfg.users ?? [];
	const user = users.find((u) => u.name === ctx.context.user);
	if (!user) {
		throw new K8sPluginError('MISSING_USER', `kubeconfig has no user named '${ctx.context.user}'`);
	}

	const requiresExecPlugin = Boolean(user.user.exec);

	const ca = cluster.cluster['certificate-authority-data'];
	const fingerprint = makeFingerprint(cluster.cluster.server, ca);

	return {
		currentContext: wantedContext,
		clusterName: cluster.name,
		server: cluster.cluster.server,
		userName: user.name,
		namespace: ctx.context.namespace,
		clusterCa: ca,
		requiresExecPlugin,
		fingerprint
	};
}

function makeFingerprint(server: string, ca?: string): string {
	const hash = createHash('sha256');
	hash.update(server);
	if (ca) {
		hash.update('\0');
		hash.update(ca);
	}
	return hash.digest('hex').slice(0, 16);
}
