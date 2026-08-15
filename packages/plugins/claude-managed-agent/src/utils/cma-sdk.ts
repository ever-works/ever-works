import type { PluginContext, PluginSettings } from '@ever-works/plugin';

import { DEFAULT_BASE_URL } from '../types.js';
import { AnthropicManagedAgentsClient } from './managed-agents-client.js';
import { getUsableSecret } from './pipeline-helpers.js';

/**
 * Build the Claude Managed Agents SDK client from resolved plugin settings.
 *
 * Single construction seam for all new (feat-cma-scale) functionality:
 * control plane, fan-out, and the pipeline both route through here so the
 * API key / base URL handling stays in one place.
 */
export function createCmaSdkClient(settings: PluginSettings): AnthropicManagedAgentsClient {
	const apiKey = getUsableSecret(settings.apiKey);
	if (!apiKey) {
		throw new Error('Anthropic API key is required for the Claude Managed Agent plugin.');
	}

	return new AnthropicManagedAgentsClient(apiKey, (settings.baseUrl as string | undefined) || DEFAULT_BASE_URL);
}

/**
 * Resolve user-scope settings only (no Work scope). Used by the fan-out
 * entry point, which may be invoked outside a Work-scoped pipeline run
 * (e.g. from a Trigger.dev task that only knows the user).
 */
export async function resolveUserScopedSettings(
	context: PluginContext | null,
	userId: string
): Promise<PluginSettings> {
	if (!context) {
		return {};
	}

	try {
		return await context.getSettings('user', userId);
	} catch (err) {
		// Security: mirror resolveScopedSettings — auth failures must not be
		// masked as empty settings.
		if (isAuthError(err)) {
			throw err;
		}

		context.logger?.warn(
			`claude-managed-agent: failed to load user settings for user=${userId}: ${
				err instanceof Error ? err.message : String(err)
			}`
		);
		return {};
	}
}

function isAuthError(err: unknown): boolean {
	if (!(err instanceof Error)) {
		return false;
	}

	const status =
		('status' in err ? (err as { status: unknown }).status : undefined) ??
		('statusCode' in err ? (err as { statusCode: unknown }).statusCode : undefined);

	return /unauthorized|forbidden|access denied/i.test(err.message) || status === 401 || status === 403;
}
