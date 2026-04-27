import Anthropic, { toFile } from '@anthropic-ai/sdk';

import {
	DEFAULT_BASE_URL,
	FILES_API_BETA,
	type ManagedAgentsEvent,
	type ManagedAgentsSession,
	type ManagedAgentsSessionResource
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

	async archiveAgent(agentId: string): Promise<void> {
		await this.client.beta.agents.archive(agentId);
	}

	async createEnvironment(input: { name: string }): Promise<{ id: string }> {
		const environment = await this.client.beta.environments.create({
			name: input.name,
			config: {
				type: 'cloud',
				networking: {
					type: 'unrestricted'
				}
			}
		});

		return { id: environment.id };
	}

	async deleteEnvironment(environmentId: string): Promise<void> {
		await this.client.beta.environments.delete(environmentId);
	}

	async createSession(input: {
		agentId: string;
		environmentId: string;
		title: string;
		resources?: ManagedAgentsSessionResource[];
	}): Promise<ManagedAgentsSession> {
		const session = await this.client.beta.sessions.create({
			agent: input.agentId,
			environment_id: input.environmentId,
			title: input.title,
			...(input.resources?.length ? { resources: input.resources } : {})
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

function normalizeAnthropicBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	if (!trimmed) {
		return DEFAULT_BASE_URL;
	}

	return trimmed.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

function mapSession(session: {
	id: string;
	status: ManagedAgentsSession['status'];
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
	};
}): ManagedAgentsSession {
	return {
		id: session.id,
		status: session.status,
		usage: session.usage
			? {
					input_tokens: session.usage.input_tokens,
					output_tokens: session.usage.output_tokens,
					cache_creation_input_tokens: session.usage.cache_creation_input_tokens,
					cache_read_input_tokens: session.usage.cache_read_input_tokens
				}
			: undefined
	};
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
