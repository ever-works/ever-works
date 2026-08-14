import { createHash } from 'node:crypto';

import type { PluginContext, PluginSettings } from '@ever-works/plugin';

import {
	PERSISTENT_AGENT_NAME,
	PERSISTENT_ENVIRONMENT_NAME,
	SETTING_MANAGED_AGENT_CONFIG_HASH,
	SETTING_MANAGED_AGENT_ID,
	SETTING_MANAGED_ENVIRONMENT_CONFIG_HASH,
	SETTING_MANAGED_ENVIRONMENT_ID,
	type ManagedAgentDesiredConfig,
	type ManagedEnvironmentNetworking,
	type ManagedRuntimeEnvironment
} from '../types.js';
import { AnthropicManagedAgentsClient, resolveEnvVarNetworking } from './managed-agents-client.js';

export interface ControlPlaneLogger {
	log(message: string): void;
	warn(message: string): void;
}

export interface EnsureControlPlaneResult {
	agentId: string;
	environmentId: string;
	/**
	 * True when the agent/environment were created just for this run and must
	 * be torn down at cleanup (reuseControlPlane === false).
	 */
	ephemeral: boolean;
}

/**
 * Stable hash over a serializable config object. Key order is normalized so
 * semantically equal configs always hash identically.
 */
export function computeConfigHash(config: Record<string, unknown>): string {
	return createHash('sha256').update(stableStringify(config)).digest('hex').slice(0, 32);
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(',')}]`;
	}

	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
		return `{${entries.join(',')}}`;
	}

	return JSON.stringify(value) ?? 'null';
}

/**
 * Map the optional serializable runtime-environment descriptor carried on the
 * pipeline context to the sessions API networking policy. Unknown or absent
 * shapes fall back to the env-var driven policy (today's behavior).
 */
export function resolveNetworking(runtimeEnvironment?: ManagedRuntimeEnvironment | null): ManagedEnvironmentNetworking {
	const networking = runtimeEnvironment?.networking;
	if (!networking || typeof networking !== 'object') {
		return resolveEnvVarNetworking();
	}

	if (networking.type === 'unrestricted') {
		return { type: 'unrestricted' };
	}

	if (networking.type === 'limited') {
		const allowedHosts = Array.isArray(networking.allowedHosts)
			? networking.allowedHosts.filter((host): host is string => typeof host === 'string' && host.trim() !== '')
			: [];

		return {
			type: 'limited',
			allowed_hosts: allowedHosts,
			allow_package_managers: networking.allowPackageManagers === true,
			allow_mcp_servers: networking.allowMcpServers === true
		};
	}

	return resolveEnvVarNetworking();
}

/** Read a persisted non-empty string setting; anything else is "unset". */
function readStoredId(settings: PluginSettings, key: string): string | undefined {
	const value = settings[key];
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

async function persistUserSettings(
	context: PluginContext | null,
	userId: string,
	patch: Record<string, string>,
	logger: ControlPlaneLogger
): Promise<void> {
	if (!context) {
		return;
	}

	try {
		await context.updateSettings('user', userId, { settings: patch });
	} catch (error) {
		// Non-fatal: the run proceeds with the resolved ids; the next run
		// simply re-ensures the control plane.
		logger.warn(
			`claude-managed-agent: failed to persist control-plane state: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
	}
}

/**
 * Ensure the persistent managed agent exists and matches the desired config.
 *
 * Matrix:
 * - no stored id                → create, persist id + hash
 * - stored id + matching hash   → verify it still exists, reuse
 * - stored id + hash drift      → update (new immutable version), persist hash
 * - stored id but gone/archived → recreate, persist id + hash
 *
 * The config hash intentionally EXCLUDES the model: sessions pin the model
 * per run via `agent_with_overrides`, so a model change must not churn agent
 * versions.
 */
export async function ensureManagedAgent(
	client: AnthropicManagedAgentsClient,
	context: PluginContext | null,
	userId: string,
	settings: PluginSettings,
	desired: ManagedAgentDesiredConfig,
	logger: ControlPlaneLogger
): Promise<{ agentId: string }> {
	const desiredHash = computeConfigHash({
		name: desired.name,
		description: desired.description ?? null,
		system: desired.system
	});

	const storedId = readStoredId(settings, SETTING_MANAGED_AGENT_ID);
	const storedHash = readStoredId(settings, SETTING_MANAGED_AGENT_CONFIG_HASH);

	if (storedId) {
		try {
			const existing = await client.getAgent(storedId);
			if (!existing.archivedAt) {
				if (storedHash === desiredHash) {
					return { agentId: storedId };
				}

				await client.updateAgent(storedId, {
					name: desired.name,
					description: desired.description,
					model: desired.model,
					system: desired.system
				});
				await persistUserSettings(
					context,
					userId,
					{ [SETTING_MANAGED_AGENT_CONFIG_HASH]: desiredHash },
					logger
				);
				logger.log(`claude-managed-agent: updated managed agent ${storedId} (config drift)`);
				return { agentId: storedId };
			}
		} catch (error) {
			logger.warn(
				`claude-managed-agent: stored agent ${storedId} unusable, recreating: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	const created = await client.createAgent({
		name: desired.name,
		description: desired.description,
		model: desired.model,
		system: desired.system
	});
	await persistUserSettings(
		context,
		userId,
		{
			[SETTING_MANAGED_AGENT_ID]: created.id,
			[SETTING_MANAGED_AGENT_CONFIG_HASH]: desiredHash
		},
		logger
	);
	logger.log(`claude-managed-agent: created managed agent ${created.id}`);
	return { agentId: created.id };
}

/**
 * Ensure the persistent managed environment exists and matches the resolved
 * networking policy (runtime-environment context object when present, env-var
 * fallback otherwise). Drift updates the environment in place; a missing or
 * archived environment is recreated.
 */
export async function ensureManagedEnvironment(
	client: AnthropicManagedAgentsClient,
	context: PluginContext | null,
	userId: string,
	settings: PluginSettings,
	runtimeEnvironment: ManagedRuntimeEnvironment | null | undefined,
	logger: ControlPlaneLogger
): Promise<{ environmentId: string }> {
	const networking = resolveNetworking(runtimeEnvironment);
	const name =
		typeof runtimeEnvironment?.name === 'string' && runtimeEnvironment.name.trim() !== ''
			? runtimeEnvironment.name.trim()
			: PERSISTENT_ENVIRONMENT_NAME;
	const desiredHash = computeConfigHash({ name, networking });

	const storedId = readStoredId(settings, SETTING_MANAGED_ENVIRONMENT_ID);
	const storedHash = readStoredId(settings, SETTING_MANAGED_ENVIRONMENT_CONFIG_HASH);

	if (storedId) {
		try {
			const existing = await client.getEnvironment(storedId);
			if (!existing.archivedAt) {
				if (storedHash === desiredHash) {
					return { environmentId: storedId };
				}

				await client.updateEnvironment(storedId, { name, networking });
				await persistUserSettings(
					context,
					userId,
					{ [SETTING_MANAGED_ENVIRONMENT_CONFIG_HASH]: desiredHash },
					logger
				);
				logger.log(`claude-managed-agent: updated managed environment ${storedId} (config drift)`);
				return { environmentId: storedId };
			}
		} catch (error) {
			logger.warn(
				`claude-managed-agent: stored environment ${storedId} unusable, recreating: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	const created = await client.createEnvironment({ name, networking });
	await persistUserSettings(
		context,
		userId,
		{
			[SETTING_MANAGED_ENVIRONMENT_ID]: created.id,
			[SETTING_MANAGED_ENVIRONMENT_CONFIG_HASH]: desiredHash
		},
		logger
	);
	logger.log(`claude-managed-agent: created managed environment ${created.id}`);
	return { environmentId: created.id };
}

/**
 * Ensure agent + environment. In reuse mode (default) both are persistent and
 * survive the run; in ephemeral mode (reuseControlPlane === false) both are
 * created fresh and reported as ephemeral so the caller tears them down.
 */
export async function ensureControlPlane(
	client: AnthropicManagedAgentsClient,
	context: PluginContext | null,
	userId: string,
	settings: PluginSettings,
	desiredAgent: ManagedAgentDesiredConfig,
	runtimeEnvironment: ManagedRuntimeEnvironment | null | undefined,
	logger: ControlPlaneLogger
): Promise<EnsureControlPlaneResult> {
	const reuse = settings.reuseControlPlane !== false;

	if (!reuse) {
		const agent = await client.createAgent({
			name: desiredAgent.name,
			description: desiredAgent.description,
			model: desiredAgent.model,
			system: desiredAgent.system
		});
		const environment = await client.createEnvironment({
			name: PERSISTENT_ENVIRONMENT_NAME,
			networking: resolveNetworking(runtimeEnvironment)
		});
		return { agentId: agent.id, environmentId: environment.id, ephemeral: true };
	}

	const { agentId } = await ensureManagedAgent(client, context, userId, settings, desiredAgent, logger);
	const { environmentId } = await ensureManagedEnvironment(
		client,
		context,
		userId,
		settings,
		runtimeEnvironment,
		logger
	);

	return { agentId, environmentId, ephemeral: false };
}

export { PERSISTENT_AGENT_NAME };
