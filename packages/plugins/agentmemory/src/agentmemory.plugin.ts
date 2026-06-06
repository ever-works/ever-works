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
import {
	DEFAULT_BASE_URL,
	DEFAULT_TIMEOUT_MS,
	DEFAULT_PROJECT,
	MAX_TIMEOUT_MS,
	ENV_VAR_BASE_URL,
	ENV_VAR_API_KEY,
	ENV_VAR_PROJECT
} from './types.js';

/**
 * Agent Memory plugin — first-party implementation of the
 * `agent-memory` capability.
 *
 * Talks to a standalone `agentmemory` Node server over REST (default
 * `http://localhost:3111`, override via `baseUrl` setting). Works
 * equally well against:
 *
 * - a locally-run `npx @agentmemory/agentmemory` server (zero config),
 * - a hosted instance fronted by HTTPS + bearer auth,
 * - the optional in-cluster Deployment shipped under
 *   `.deploy/k8s/agentmemory.optional.yaml`.
 *
 * `baseUrl` / `apiKey` / `project` are normal admin/user/work-scoped
 * settings (NOT `x-envVar`-locked) — Codex pointed out on PR #1073 that
 * `x-envVar` makes a field env-only and unsettable through the UI. We
 * still fall back to `AGENTMEMORY_BASE_URL` / `AGENTMEMORY_API_KEY` /
 * `AGENTMEMORY_PROJECT` env vars manually in `resolveSettings` for
 * operators who prefer to inject the URL via k8s env.
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
					'REST endpoint of the agentmemory server. Defaults to http://localhost:3111 (matches the `npx agentmemory` server). Set to your hosted instance for a shared deployment. Falls back to the AGENTMEMORY_BASE_URL env var when empty.',
				default: DEFAULT_BASE_URL,
				'x-scope': 'user'
			},
			apiKey: {
				type: 'string',
				title: 'Bearer token',
				description:
					"Bearer token sent in Authorization. Leave empty for a localhost dev server. For a hosted instance this must match the server's `AGENTMEMORY_SECRET` env var. Falls back to the AGENTMEMORY_API_KEY env var when empty.",
				'x-secret': true,
				'x-scope': 'user'
			},
			projectId: {
				type: 'string',
				title: 'Project namespace',
				description:
					"agentmemory requires a `project` field on every request — we send this value (or AGENTMEMORY_PROJECT env, or 'ever-works' as last resort). Set it per-Work to partition observations between Works that share one server.",
				'x-scope': 'work'
			},
			timeoutMs: {
				type: 'number',
				title: 'Request timeout (ms)',
				default: DEFAULT_TIMEOUT_MS,
				minimum: 1000,
				maximum: MAX_TIMEOUT_MS,
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
				// Security (SSRF): reject a tenant-supplied baseUrl that targets the
				// cloud Instance Metadata Service / a link-local address at config
				// time. The localhost default and private-LAN hosts are intentionally
				// still permitted (this plugin talks to a self-hosted server); only
				// the never-legitimate IMDS/metadata surface is blocked here.
				if (isCloudMetadataHost(baseUrl)) {
					return {
						valid: false,
						errors: [
							{
								path: 'baseUrl',
								message: '`baseUrl` must not target a cloud metadata / link-local address'
							}
						]
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
		if (
			timeoutMs !== undefined &&
			(typeof timeoutMs !== 'number' || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS)
		) {
			return {
				valid: false,
				errors: [
					{
						path: 'timeoutMs',
						message: `\`timeoutMs\` must be a number between 1000 and ${MAX_TIMEOUT_MS}`
					}
				]
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
		const body: Record<string, unknown> = {
			project: input.projectId ?? settings.project ?? DEFAULT_PROJECT
		};
		if (input.metadata) body.metadata = input.metadata;
		const raw = (await client.sessionStart(body)) as AgentmemoryRawSession | undefined;
		return this.toSession(raw, { startedAt: new Date().toISOString() });
	}

	async closeSession(sessionId: string, settingsOverride?: PluginSettings): Promise<void> {
		const settings = this.resolveSettings(settingsOverride);
		const client = this.buildClient(settings);
		// `/session/end` requires both `project` and `sessionId`.
		await client.sessionEnd({
			project: settings.project ?? DEFAULT_PROJECT,
			sessionId
		});
	}

	async saveMemory(input: AgentMemorySaveInput): Promise<AgentMemoryRecord> {
		const settings = this.resolveSettings(input.settings);
		const client = this.buildClient(settings);

		// Always route through `/remember` — `/observe` is reserved for
		// auto-capture hook payloads (PostToolUse / PreToolUse / etc.)
		// with a `type` + `payload` shape that the agentmemory server
		// validates strictly. Free-form platform saves don't fit that
		// schema (Codex P1 review on PR #1073).
		const body: Record<string, unknown> = {
			project: input.projectId ?? settings.project ?? DEFAULT_PROJECT,
			content: input.content
		};
		if (input.tags) body.tags = input.tags;
		if (input.metadata) body.metadata = input.metadata;
		// `sessionId` is forwarded as metadata so audit trails can link
		// the memory back to its session; the upstream server ignores
		// unknown top-level keys on /remember.
		if (input.sessionId) body.sessionId = input.sessionId;

		const raw = (await client.remember(body)) as AgentmemoryRawRecord;
		return this.toRecord(raw, input);
	}

	async searchMemory(input: AgentMemorySearchInput): Promise<AgentMemorySearchResponse> {
		const settings = this.resolveSettings(input.settings);
		const client = this.buildClient(settings);
		const body: Record<string, unknown> = {
			project: input.projectId ?? settings.project ?? DEFAULT_PROJECT,
			query: input.query
		};
		// agentmemory's `/smart-search` uses `topK`, not `limit`.
		if (input.limit !== undefined) body.topK = input.limit;
		if (input.tags) body.tags = input.tags;
		if (input.sessionId) body.sessionId = input.sessionId;

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
		const body: Record<string, unknown> = {
			project: input.projectId ?? settings.project ?? DEFAULT_PROJECT
		};
		if (input.query) body.query = input.query;
		if (input.purpose) body.purpose = input.purpose;
		if (input.sessionId) body.sessionId = input.sessionId;
		// agentmemory's `/context` uses `tokenBudget`, not `maxTokens`.
		if (input.maxTokens !== undefined) body.tokenBudget = input.maxTokens;

		const raw = (await client.context(body)) as AgentmemoryRawContext | undefined;
		return {
			content: raw?.content ?? raw?.context ?? raw?.text ?? '',
			approxTokens: raw?.approxTokens ?? raw?.approx_tokens,
			references: raw?.references?.map((r) => this.toRecord(r))
		};
	}

	async deleteEntry(id: string, settingsOverride?: PluginSettings): Promise<void> {
		if (!id) {
			throw new Error('agentmemory deleteEntry: missing id');
		}
		const settings = this.resolveSettings(settingsOverride);
		const client = this.buildClient(settings);
		// `/forget` takes `{ project, filter: { ... } }`. The filter
		// selects observations / memories / sessions to delete by id.
		await client.forget({
			project: settings.project ?? DEFAULT_PROJECT,
			filter: { id }
		});
	}

	// ── helpers ────────────────────────────────────────────────────────

	private resolveSettings(rawSettings?: PluginSettings | Record<string, unknown>): AgentmemorySettings {
		const flat = this.flattenSettings(rawSettings);
		const out: AgentmemorySettings = {};

		const baseUrl =
			typeof flat.baseUrl === 'string' && flat.baseUrl ? (flat.baseUrl as string) : envOf(ENV_VAR_BASE_URL);
		if (baseUrl) out.baseUrl = baseUrl;

		const apiKey =
			typeof flat.apiKey === 'string' && flat.apiKey ? (flat.apiKey as string) : envOf(ENV_VAR_API_KEY);
		if (apiKey) out.apiKey = apiKey;

		const project =
			typeof flat.projectId === 'string' && flat.projectId ? (flat.projectId as string) : envOf(ENV_VAR_PROJECT);
		if (project) out.project = project;

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
		// Security (SSRF): defense-in-depth choke point. Every plugin operation
		// (openSession / saveMemory / searchMemory / buildContext / deleteEntry /
		// closeSession / validateConnection) funnels through here, and most of
		// them never call `validateSettings`. Reject a resolved baseUrl that
		// targets the cloud metadata service before any request is issued so a
		// hostile tenant can't read IMDS credentials back through the response.
		if (settings.baseUrl && isCloudMetadataHost(settings.baseUrl)) {
			throw new Error(
				'agentmemory baseUrl is not allowed to target a cloud metadata / link-local address (SSRF guard blocked the destination host).'
			);
		}
		return new AgentmemoryClient({
			baseUrl: settings.baseUrl,
			apiKey: settings.apiKey,
			timeoutMs: settings.timeoutMs,
			logger: this.context?.logger ?? console
		});
	}

	private toSession(raw: AgentmemoryRawSession | undefined, fallback?: { startedAt?: string }): AgentMemorySession {
		const id = raw?.id || raw?.sessionId || raw?.session_id;
		if (!id) {
			throw new Error(
				`agentmemory server returned a session without an id field (one of id, sessionId, session_id is required). Raw payload: ${safeStringify(raw)}`
			);
		}
		return {
			id,
			startedAt: raw.startedAt || raw.started_at || fallback?.startedAt || new Date().toISOString(),
			endedAt: raw.endedAt || raw.ended_at,
			metadata: raw.metadata,
			context: raw.context || raw.recall
		};
	}

	private toRecord(
		raw: AgentmemoryRawRecord,
		fallback?: Partial<AgentMemoryRecord> & { sessionId?: string; projectId?: string }
	): AgentMemoryRecord {
		const id = raw.id || raw.observationId || raw.observation_id || raw.memoryId || raw.memory_id;
		if (!id) {
			throw new Error(
				`agentmemory server returned a record without an id field (one of id, observationId, memoryId is required). Raw payload: ${safeStringify(raw)}`
			);
		}
		return {
			id,
			content: raw.content ?? raw.text ?? fallback?.content ?? '',
			tags: raw.tags ?? fallback?.tags,
			metadata: raw.metadata ?? fallback?.metadata,
			sessionId: raw.sessionId ?? raw.session_id ?? fallback?.sessionId,
			projectId: raw.projectId ?? raw.project_id ?? raw.project ?? fallback?.projectId,
			createdAt: raw.createdAt ?? raw.created_at ?? new Date().toISOString(),
			score: raw.score ?? raw.similarity
		};
	}
}

function envOf(name: string): string | undefined {
	const value = process.env[name];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// Security (SSRF — cloud-metadata exfiltration): `baseUrl` is a user/work-scoped
// tenant setting that is used verbatim to construct every outbound request and
// whose response/error body is reflected back through `validateConnection`.
// A hostile tenant can therefore point it at the cloud Instance Metadata
// Service (IMDS) and read back IAM credentials. We deliberately do NOT reuse
// the broad `isSafeWebhookUrl` guard here because this plugin's whole purpose
// is to talk to a self-hosted memory server — the documented default is
// `http://localhost:3111` and operators legitimately run it on loopback or a
// private LAN address, both of which `isSafeWebhookUrl` would reject. Blocking
// the link-local IMDS range + metadata hostnames is the maximal set that has
// ZERO impact on any legitimate agentmemory deployment (no one runs the server
// on 169.254.x.x or metadata.google.internal). A stricter tenant-baseUrl
// policy that also blocks RFC1918 is a multi-tenant deployment decision — see
// the audit DEFER note. Returns true when the host must never be reached.
function isCloudMetadataHost(rawUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		// Malformed URLs are rejected elsewhere (validateSettings); treat as
		// not-a-metadata-host so we don't change behaviour for that path.
		return false;
	}
	let host = url.hostname.toLowerCase();
	// Node keeps the brackets around literal IPv6 hosts.
	if (host.startsWith('[') && host.endsWith(']')) {
		host = host.slice(1, -1);
	}
	if (CLOUD_METADATA_HOSTNAMES.has(host)) return true;
	// IPv4 link-local 169.254.0.0/16 (covers AWS/GCP/Azure/OpenStack IMDS
	// 169.254.169.254 and any other link-local target).
	if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
	// IPv6 IMDS (AWS) and IPv4-mapped form of the link-local IMDS address.
	if (host === 'fd00:ec2::254' || host === '::ffff:169.254.169.254') return true;
	return false;
}

const CLOUD_METADATA_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.goog']);

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
