import type {
	IPlugin,
	IAgentMemoryPlugin,
	PluginContext,
	PluginCategory,
	JsonSchema,
	ValidationResult,
	ConnectionValidationResult,
	PluginManifest,
	PluginHealthCheck,
	PluginSettings,
	AgentMemorySession,
	AgentMemorySessionInput,
	AgentMemoryRecord,
	AgentMemorySaveInput,
	AgentMemorySearchInput,
	AgentMemorySearchResponse,
	AgentMemoryContext,
	AgentMemoryContextInput
} from '@ever-works/plugin';

import { AgentmemoryClient } from './agentmemory-client.js';
import type {
	AgentmemorySettings,
	AgentmemoryRawSession,
	AgentmemoryRawRecord,
	AgentmemoryRawSearchResponse,
	AgentmemoryRawContext
} from './types.js';
import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from './types.js';

/**
 * Agent Memory plugin — first-party implementation of the
 * `agent-memory` capability.
 *
 * Talks to a standalone `agentmemory` Node server over REST (default
 * `http://localhost:3111`, override via `baseUrl` setting or the
 * `AGENTMEMORY_BASE_URL` env var). Works equally well against:
 *
 * - a locally-run `npx @agentmemory/agentmemory` server (zero config),
 * - a hosted instance fronted by HTTPS + bearer auth,
 * - the optional in-cluster Deployment shipped under
 *   `.deploy/k8s/agentmemory.optional.yaml`.
 *
 * The plugin is settings-only — no global env reads beyond the
 * `x-envVar` fallbacks declared in the JSON Schema, which the plugin
 * settings service injects automatically when the user / admin hasn't
 * overridden them.
 */
export class AgentmemoryPlugin implements IPlugin, IAgentMemoryPlugin {
	readonly id = 'agentmemory';
	readonly name = 'Agent Memory';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'utility';
	readonly capabilities = ['agent-memory'] as const;
	readonly configurationMode = 'hybrid' as const;
	readonly providerName = 'agentmemory';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			baseUrl: {
				type: 'string',
				title: 'agentmemory base URL',
				description:
					'REST endpoint of the agentmemory server. Defaults to http://localhost:3111 (matches the `npx agentmemory` server). Set to your hosted instance for a shared deployment.',
				default: DEFAULT_BASE_URL,
				'x-scope': 'user',
				'x-envVar': 'AGENTMEMORY_BASE_URL'
			},
			apiKey: {
				type: 'string',
				title: 'Bearer token',
				description:
					"Bearer token sent in Authorization. Leave empty for a localhost dev server. For a hosted instance this must match the server's `AGENTMEMORY_SECRET` env var.",
				'x-secret': true,
				'x-scope': 'user',
				'x-envVar': 'AGENTMEMORY_API_KEY'
			},
			projectId: {
				type: 'string',
				title: 'Project namespace',
				description:
					"Optional namespace inside the agentmemory store. Each Work / project can pin a value so different Works don't see each other's observations.",
				'x-scope': 'work'
			},
			timeoutMs: {
				type: 'number',
				title: 'Request timeout (ms)',
				default: DEFAULT_TIMEOUT_MS,
				minimum: 1000,
				maximum: 120_000,
				'x-scope': 'user'
			}
		},
		required: []
	};

	private context: PluginContext | null = null;

	// ── IPlugin lifecycle ──────────────────────────────────────────────

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('agentmemory plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = null;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'agentmemory plugin is ready',
			checkedAt: Date.now()
		};
	}

	async isAvailable(): Promise<boolean> {
		// The plugin is always available — connectivity is checked per-call.
		// We don't ping the server in `isAvailable` because the operator may
		// run agentmemory on-demand (it's cheap to start, no daemon by default).
		return true;
	}

	async validateSettings(settings: Record<string, unknown>): Promise<ValidationResult> {
		const baseUrl = settings.baseUrl;
		if (baseUrl !== undefined && typeof baseUrl !== 'string') {
			return {
				valid: false,
				errors: [{ path: 'baseUrl', message: '`baseUrl` must be a string' }]
			};
		}
		if (baseUrl && typeof baseUrl === 'string') {
			try {
				const url = new URL(baseUrl);
				if (url.protocol !== 'http:' && url.protocol !== 'https:') {
					return {
						valid: false,
						errors: [{ path: 'baseUrl', message: '`baseUrl` must be http:// or https://' }]
					};
				}
			} catch {
				return {
					valid: false,
					errors: [{ path: 'baseUrl', message: '`baseUrl` is not a valid URL' }]
				};
			}
		}
		const timeoutMs = settings.timeoutMs;
		if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || timeoutMs < 1000)) {
			return {
				valid: false,
				errors: [{ path: 'timeoutMs', message: '`timeoutMs` must be a number ≥ 1000' }]
			};
		}
		return { valid: true };
	}

	async validateConnection(rawSettings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const settings = this.resolveSettings(rawSettings);
		const client = this.buildClient(settings);
		try {
			const result = await client.health();
			if (result.ok) {
				return {
					success: true,
					message: `Connected to agentmemory at ${settings.baseUrl ?? DEFAULT_BASE_URL}.`
				};
			}
			return {
				success: false,
				message: `agentmemory health check returned an unexpected payload: ${safeStringify(result.raw)}`
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Connection validation failed';
			return { success: false, message };
		}
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'Persistent memory store for AI coding / generation agents. Connects to a local or hosted agentmemory REST server (default http://localhost:3111).',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			autoEnable: false,
			visibility: 'public',
			defaultForCapabilities: ['agent-memory'],
			homepage: 'https://github.com/rohitg00/agentmemory',
			uiHints: {
				includeInOnboarding: false,
				completionFields: ['baseUrl']
			}
		};
	}

	// ── IAgentMemoryPlugin ────────────────────────────────────────────

	async openSession(input: AgentMemorySessionInput): Promise<AgentMemorySession> {
		const settings = this.resolveSettings(input.settings);
		const client = this.buildClient(settings);
		const body: Record<string, unknown> = {};
		if (input.projectId ?? settings.projectId) body.projectId = input.projectId ?? settings.projectId;
		if (input.metadata) body.metadata = input.metadata;
		const raw = (await client.sessionStart(body)) as AgentmemoryRawSession | undefined;
		return this.toSession(raw);
	}

	async closeSession(sessionId: string, settingsOverride?: PluginSettings): Promise<void> {
		const settings = this.resolveSettings(settingsOverride);
		const client = this.buildClient(settings);
		await client.sessionEnd({ sessionId });
	}

	async saveMemory(input: AgentMemorySaveInput): Promise<AgentMemoryRecord> {
		const settings = this.resolveSettings(input.settings);
		const client = this.buildClient(settings);
		const body: Record<string, unknown> = { content: input.content };
		if (input.tags) body.tags = input.tags;
		if (input.metadata) body.metadata = input.metadata;
		if (input.sessionId) body.sessionId = input.sessionId;
		if (input.projectId ?? settings.projectId) body.projectId = input.projectId ?? settings.projectId;

		// `/observe` is the right call when a session is open (records as
		// a transient observation); otherwise `/remember` persists it
		// directly to long-term memory. Mirrors the agentmemory docs.
		const raw = input.sessionId
			? ((await client.observe(body)) as AgentmemoryRawRecord)
			: ((await client.remember(body)) as AgentmemoryRawRecord);

		return this.toRecord(raw, input);
	}

	async searchMemory(input: AgentMemorySearchInput): Promise<AgentMemorySearchResponse> {
		const settings = this.resolveSettings(input.settings);
		const client = this.buildClient(settings);
		const body: Record<string, unknown> = { query: input.query };
		if (input.limit !== undefined) body.limit = input.limit;
		if (input.tags) body.tags = input.tags;
		if (input.sessionId) body.sessionId = input.sessionId;
		if (input.projectId ?? settings.projectId) body.projectId = input.projectId ?? settings.projectId;

		const raw = (await client.smartSearch(body)) as AgentmemoryRawSearchResponse | undefined;
		const rawList = raw?.results ?? raw?.matches ?? raw?.hits ?? [];
		return {
			results: rawList.map((r) => this.toRecord(r)),
			summary: raw?.summary ?? raw?.digest
		};
	}

	async buildContext(input: AgentMemoryContextInput): Promise<AgentMemoryContext> {
		const settings = this.resolveSettings(input.settings);
		const client = this.buildClient(settings);
		const body: Record<string, unknown> = {};
		if (input.query) body.query = input.query;
		if (input.purpose) body.purpose = input.purpose;
		if (input.sessionId) body.sessionId = input.sessionId;
		if (input.projectId ?? settings.projectId) body.projectId = input.projectId ?? settings.projectId;
		if (input.maxTokens !== undefined) body.maxTokens = input.maxTokens;

		const raw = (await client.context(body)) as AgentmemoryRawContext | undefined;
		return {
			content: raw?.content ?? raw?.context ?? raw?.text ?? '',
			approxTokens: raw?.approxTokens ?? raw?.approx_tokens,
			references: raw?.references?.map((r) => this.toRecord(r))
		};
	}

	async deleteEntry(id: string, settingsOverride?: PluginSettings): Promise<void> {
		const settings = this.resolveSettings(settingsOverride);
		const client = this.buildClient(settings);
		await client.forget({ id });
	}

	async listSessions(options?: {
		limit?: number;
		projectId?: string;
		settings?: PluginSettings;
	}): Promise<readonly AgentMemorySession[]> {
		const settings = this.resolveSettings(options?.settings);
		const client = this.buildClient(settings);
		const query: Record<string, string | number | undefined> = {};
		if (options?.limit !== undefined) query.limit = options.limit;
		if (options?.projectId ?? settings.projectId) {
			query.projectId = (options?.projectId ?? settings.projectId) as string;
		}
		const raw = (await client.listSessions(query)) as
			| { sessions?: readonly AgentmemoryRawSession[]; data?: readonly AgentmemoryRawSession[] }
			| readonly AgentmemoryRawSession[]
			| undefined;

		let list: readonly AgentmemoryRawSession[];
		if (Array.isArray(raw)) {
			list = raw;
		} else if (raw && typeof raw === 'object') {
			list =
				(raw as { sessions?: readonly AgentmemoryRawSession[]; data?: readonly AgentmemoryRawSession[] })
					.sessions ??
				(raw as { data?: readonly AgentmemoryRawSession[] }).data ??
				[];
		} else {
			list = [];
		}

		return list.map((s) => this.toSession(s));
	}

	// ── helpers ────────────────────────────────────────────────────────

	private resolveSettings(rawSettings?: PluginSettings | Record<string, unknown>): AgentmemorySettings {
		const flat = this.flattenSettings(rawSettings);
		const out: AgentmemorySettings = {};
		if (typeof flat.baseUrl === 'string' && flat.baseUrl) out.baseUrl = flat.baseUrl as string;
		if (typeof flat.apiKey === 'string' && flat.apiKey) out.apiKey = flat.apiKey as string;
		if (typeof flat.projectId === 'string' && flat.projectId) out.projectId = flat.projectId as string;
		if (typeof flat.timeoutMs === 'number') out.timeoutMs = flat.timeoutMs as number;
		return out;
	}

	/** Some callers pass `{ admin: {...}, user: {...} }` directly; the
	 *  facade always pre-flattens but tests / `validateConnection` may
	 *  not, so we accept both shapes. */
	private flattenSettings(rawSettings: unknown): Record<string, unknown> {
		if (!rawSettings || typeof rawSettings !== 'object') return {};
		const obj = rawSettings as Record<string, unknown>;
		if ('admin' in obj || 'user' in obj || 'work' in obj || 'effective' in obj) {
			const effective = (obj.effective as Record<string, unknown>) || undefined;
			if (effective) return effective;
			const admin = (obj.admin as Record<string, unknown>) || {};
			const user = (obj.user as Record<string, unknown>) || {};
			const work = (obj.work as Record<string, unknown>) || {};
			return { ...admin, ...user, ...work };
		}
		return obj;
	}

	private buildClient(settings: AgentmemorySettings): AgentmemoryClient {
		return new AgentmemoryClient({
			baseUrl: settings.baseUrl,
			apiKey: settings.apiKey,
			timeoutMs: settings.timeoutMs,
			logger: this.context?.logger ?? console
		});
	}

	private toSession(raw: AgentmemoryRawSession | undefined): AgentMemorySession {
		const id = raw?.id || raw?.sessionId || raw?.session_id || '';
		return {
			id,
			startedAt: raw?.startedAt || raw?.started_at || new Date().toISOString(),
			endedAt: raw?.endedAt || raw?.ended_at,
			metadata: raw?.metadata,
			context: raw?.context || raw?.recall
		};
	}

	private toRecord(
		raw: AgentmemoryRawRecord,
		fallback?: Partial<AgentMemoryRecord> & { sessionId?: string; projectId?: string }
	): AgentMemoryRecord {
		return {
			id: raw.id || raw.observationId || raw.observation_id || '',
			content: raw.content ?? raw.text ?? fallback?.content ?? '',
			tags: raw.tags ?? fallback?.tags,
			metadata: raw.metadata ?? fallback?.metadata,
			sessionId: raw.sessionId ?? raw.session_id ?? fallback?.sessionId,
			projectId: raw.projectId ?? raw.project_id ?? fallback?.projectId,
			createdAt: raw.createdAt ?? raw.created_at ?? new Date().toISOString(),
			score: raw.score ?? raw.similarity
		};
	}
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
