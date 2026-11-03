import Anthropic, { toFile } from '@anthropic-ai/sdk';

import {
	DEFAULT_BASE_URL,
	FILES_API_BETA,
	type ManagedAgentsEvent,
	type ManagedAgentsSession,
	type ManagedAgentsSessionResource,
	type ManagedEnvironmentNetworking
} from '../types.js';
import { delayWithSignal } from './pipeline-helpers.js';

export class AnthropicManagedAgentsClient {
	private readonly client: Anthropic;

	constructor(apiKey: string, baseUrl: string = DEFAULT_BASE_URL) {
		this.client = new Anthropic({
			apiKey,
			baseURL: normalizeAnthropicBaseUrl(baseUrl)
		});
	}

	async validateAccess(): Promise<void> {
		await this.client.beta.agents.list({ limit: 1 });
	}

	async createAgent(input: {
		name: string;
		model: string;
		system: string;
		description?: string;
	}): Promise<{ id: string }> {
		const agent = await this.client.beta.agents.create({
			name: input.name,
			description: input.description,
			model: input.model,
			system: input.system,
			tools: [{ type: 'agent_toolset_20260401' }]
		});

		return { id: agent.id };
	}

	/**
	 * Update an existing (persistent) agent. Agents are versioned upstream:
	 * an update creates a new immutable version, which future sessions pin
	 * automatically when created with the bare agent id.
	 */
	async updateAgent(
		agentId: string,
		input: { name?: string; model?: string; system?: string; description?: string }
	): Promise<{ id: string }> {
		const agent = await this.client.beta.agents.update(agentId, {
			...(input.name !== undefined ? { name: input.name } : {}),
			...(input.description !== undefined ? { description: input.description } : {}),
			...(input.model !== undefined ? { model: input.model } : {}),
			...(input.system !== undefined ? { system: input.system } : {})
		});

		return { id: agent.id };
	}

	/** Retrieve an agent; throws (404) when it no longer exists. */
	async getAgent(agentId: string): Promise<{ id: string; archivedAt: string | null }> {
		const agent = await this.client.beta.agents.retrieve(agentId);
		return {
			id: agent.id,
			archivedAt: readNullableString((agent as { archived_at?: unknown }).archived_at)
		};
	}

	async archiveAgent(agentId: string): Promise<void> {
		await this.client.beta.agents.archive(agentId);
	}

	async createEnvironment(input: { name: string; networking?: ManagedEnvironmentNetworking }): Promise<{
		id: string;
	}> {
		const environment = await this.client.beta.environments.create({
			name: input.name,
			config: {
				type: 'cloud',
				networking: input.networking ?? resolveEnvVarNetworking()
			}
		});

		return { id: environment.id };
	}

	/** Update a persistent environment's networking config in place. */
	async updateEnvironment(
		environmentId: string,
		input: { name?: string; networking?: ManagedEnvironmentNetworking }
	): Promise<{ id: string }> {
		const environment = await this.client.beta.environments.update(environmentId, {
			...(input.name !== undefined ? { name: input.name } : {}),
			...(input.networking
				? {
						config: {
							type: 'cloud' as const,
							networking: input.networking
						}
					}
				: {})
		});

		return { id: environment.id };
	}

	/** Retrieve an environment; throws (404) when it no longer exists. */
	async getEnvironment(environmentId: string): Promise<{ id: string; archivedAt: string | null }> {
		const environment = await this.client.beta.environments.retrieve(environmentId);
		return { id: environment.id, archivedAt: environment.archived_at };
	}

	async deleteEnvironment(environmentId: string): Promise<void> {
		await this.client.beta.environments.delete(environmentId);
	}

	async createSession(input: {
		agentId: string;
		environmentId: string;
		title: string;
		resources?: ManagedAgentsSessionResource[];
		/** Hard per-session spend ceiling in USD (`budget` is create-only). */
		budgetUsd?: number;
		/** Initial `user.message` events processed in order at creation. */
		initialMessages?: string[];
		/** Per-session model/system overrides (no agent version churn). */
		agentOverrides?: { system?: string; model?: string };
	}): Promise<ManagedAgentsSession> {
		const hasOverrides =
			input.agentOverrides &&
			(input.agentOverrides.system !== undefined || input.agentOverrides.model !== undefined);

		const session = await this.client.beta.sessions.create({
			agent: hasOverrides
				? {
						type: 'agent_with_overrides',
						id: input.agentId,
						...(input.agentOverrides?.system !== undefined ? { system: input.agentOverrides.system } : {}),
						...(input.agentOverrides?.model !== undefined ? { model: input.agentOverrides.model } : {})
					}
				: input.agentId,
			environment_id: input.environmentId,
			title: input.title,
			...(input.resources?.length ? { resources: input.resources } : {}),
			...(typeof input.budgetUsd === 'number' && input.budgetUsd > 0
				? { budget: buildBudgetLimit(input.budgetUsd) }
				: {}),
			...(input.initialMessages?.length
				? {
						initial_events: input.initialMessages.map((text) => ({
							type: 'user.message' as const,
							content: [{ type: 'text' as const, text }]
						}))
					}
				: {})
		});

		return mapSession(session);
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.client.beta.sessions.delete(sessionId);
	}

	async archiveSession(sessionId: string): Promise<void> {
		await this.client.beta.sessions.archive(sessionId);
	}

	async uploadTextFile(filename: string, content: string, mimeType = 'application/json'): Promise<{ id: string }> {
		const file = await toFile(Buffer.from(content, 'utf-8'), filename, { type: mimeType });
		const uploaded = await this.client.beta.files.upload({
			file,
			betas: [FILES_API_BETA]
		});

		return { id: uploaded.id };
	}

	async deleteFile(fileId: string): Promise<void> {
		await this.client.beta.files.delete(fileId, { betas: [FILES_API_BETA] });
	}

	async getSession(sessionId: string): Promise<ManagedAgentsSession> {
		const session = await this.client.beta.sessions.retrieve(sessionId);
		return mapSession(session);
	}

	async sendUserMessage(sessionId: string, text: string): Promise<void> {
		await this.client.beta.sessions.events.send(sessionId, {
			events: [
				{
					type: 'user.message',
					content: [{ type: 'text', text }]
				}
			]
		});
	}

	async interruptSession(sessionId: string): Promise<void> {
		await this.client.beta.sessions.events.send(sessionId, {
			events: [{ type: 'user.interrupt' }]
		});
	}

	async listAllEvents(sessionId: string): Promise<ManagedAgentsEvent[]> {
		const events: ManagedAgentsEvent[] = [];

		for await (const event of this.client.beta.sessions.events.list(sessionId, { order: 'asc' })) {
			events.push(mapEvent(event));
		}

		return events;
	}

	async waitForSessionIdle(
		sessionId: string,
		options: {
			maxPollAttempts: number;
			pollIntervalMs: number;
			signal?: AbortSignal;
			onPoll?: (session: ManagedAgentsSession, attempt: number) => void | Promise<void>;
		}
	): Promise<ManagedAgentsSession> {
		for (let attempt = 0; attempt < options.maxPollAttempts; attempt += 1) {
			if (options.signal?.aborted) {
				throw new Error('Pipeline cancelled');
			}

			const session = await this.getSession(sessionId);
			if (session.status === 'idle') {
				return session;
			}

			if (session.status === 'terminated') {
				throw new Error('Claude Managed Agents session terminated before completion.');
			}

			await options.onPoll?.(session, attempt);
			await delayWithSignal(options.pollIntervalMs, options.signal);
		}

		throw new Error('Timed out waiting for Claude Managed Agents session to become idle.');
	}
}

/**
 * H-25: pin egress to an allow-list when CLAUDE_MANAGED_AGENT_EGRESS_HOSTS is
 * set. Default stays `unrestricted` to preserve the current behavior (the env
 * is opt-in until operators verify the agent tooling works with the
 * constrained list). Comma-separated hosts. SDK >= 0.117 exposes the typed
 * `limited` networking policy, so the former untyped `allowlist` payload is
 * migrated to `{ type: 'limited', allowed_hosts }`.
 */
export function resolveEnvVarNetworking(): ManagedEnvironmentNetworking {
	const allowHostsRaw = process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS?.trim();
	const allowHosts = allowHostsRaw
		? allowHostsRaw
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: null;

	if (allowHosts && allowHosts.length > 0) {
		return {
			type: 'limited',
			allowed_hosts: allowHosts,
			allow_package_managers: false,
			allow_mcp_servers: false
		};
	}

	return { type: 'unrestricted' };
}

/**
 * Convert a USD budget into the API's `budget` limit shape. `max_list_cost`
 * amounts are integer minor-unit strings ("250" = $2.50) — never floats.
 */
export function buildBudgetLimit(budgetUsd: number): {
	type: 'limit';
	max_list_cost: { amount: string; currency: 'USD' };
} {
	const cents = Math.max(1, Math.round(budgetUsd * 100));
	return {
		type: 'limit',
		max_list_cost: { amount: String(cents), currency: 'USD' }
	};
}

function normalizeAnthropicBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	if (!trimmed) {
		return DEFAULT_BASE_URL;
	}

	return trimmed.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

function readNullableString(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function mapSession(session: {
	id: string;
	status: ManagedAgentsSession['status'];
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
		list_cost?: { amount?: string; currency?: string } | null;
	} | null;
}): ManagedAgentsSession {
	const usage = session.usage ?? undefined;
	return {
		id: session.id,
		status: session.status,
		usage: usage
			? {
					input_tokens: usage.input_tokens,
					output_tokens: usage.output_tokens,
					cache_creation_input_tokens: usage.cache_creation_input_tokens,
					cache_read_input_tokens: usage.cache_read_input_tokens,
					list_cost_usd: parseListCostUsd(usage.list_cost)
				}
			: undefined
	};
}

/**
 * `list_cost.amount` is an integer minor-unit decimal string (e.g. "250" is
 * $2.50). Only USD is currently supported upstream; non-USD or malformed
 * amounts return undefined rather than a wrong number.
 */
function parseListCostUsd(listCost: { amount?: string; currency?: string } | null | undefined): number | undefined {
	if (!listCost || typeof listCost.amount !== 'string' || !/^\d+$/.test(listCost.amount)) {
		return undefined;
	}

	if (typeof listCost.currency === 'string' && listCost.currency.toUpperCase() !== 'USD') {
		return undefined;
	}

	return Number(listCost.amount) / 100;
}

function mapEvent(event: {
	id: string;
	type: string;
	processed_at?: string | null;
	content?: Array<{ type?: string; text?: string }>;
	stop_reason?: unknown;
	error?: unknown;
}): ManagedAgentsEvent {
	const normalizedStopReason = normalizeStopReason(event.stop_reason);
	const normalizedError = normalizeError(event.error);

	return {
		id: event.id,
		type: event.type,
		processed_at: event.processed_at,
		content: Array.isArray(event.content)
			? event.content.map((block) => ({
					type: typeof block.type === 'string' ? block.type : 'text',
					text: typeof block.text === 'string' ? block.text : undefined
				}))
			: undefined,
		...(normalizedStopReason ? { stop_reason: normalizedStopReason } : {}),
		...(normalizedError ? { error: normalizedError } : {})
	};
}

function normalizeStopReason(value: unknown): ManagedAgentsEvent['stop_reason'] | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}

	const record = value as Record<string, unknown>;
	const requiresAction =
		record.requires_action && typeof record.requires_action === 'object'
			? (record.requires_action as Record<string, unknown>)
			: undefined;

	return {
		type: typeof record.type === 'string' ? record.type : undefined,
		event_ids: Array.isArray(record.event_ids)
			? record.event_ids.filter((entry): entry is string => typeof entry === 'string')
			: Array.isArray(requiresAction?.event_ids)
				? requiresAction.event_ids.filter((entry): entry is string => typeof entry === 'string')
				: undefined
	};
}

function normalizeError(value: unknown): ManagedAgentsEvent['error'] | undefined {
	if (typeof value === 'string') {
		return value;
	}

	if (!value || typeof value !== 'object') {
		return undefined;
	}

	const record = value as Record<string, unknown>;
	const normalized: { message?: string; type?: string } = {};

	if (typeof record.message === 'string') {
		normalized.message = record.message;
	}

	if (typeof record.type === 'string') {
		normalized.type = record.type;
	}

	return normalized.message || normalized.type ? normalized : undefined;
}
