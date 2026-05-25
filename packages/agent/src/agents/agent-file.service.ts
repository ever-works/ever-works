import { createHash } from 'crypto';
import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Agent, AgentScope } from '../entities/agent.entity';
import { AgentRepository } from '../database/repositories/agent.repository';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { assertNoSecrets } from '../utils/secret-scan';

/**
 * The five canonical Agent files (architecture/agent-yml-manifest-schema.md
 * §1). Used as a discriminated union for both controller arg validation
 * and the on-row column it maps to in DB-inline (tenant) mode.
 */
export type AgentFileName = 'SOUL.md' | 'AGENTS.md' | 'HEARTBEAT.md' | 'TOOLS.md' | 'agent.yml';

export const AGENT_FILE_NAMES: ReadonlyArray<AgentFileName> = [
	'SOUL.md',
	'AGENTS.md',
	'HEARTBEAT.md',
	'TOOLS.md',
	'agent.yml',
];

const MAX_FILE_BYTES = 64 * 1024; // 64 KB per file (spec §5.10a / §5.6.6).

/**
 * AgentFileService — read/write the five canonical Agent files.
 *
 * v1 storage policy (ADR-008):
 *   - TENANT scope → DB-inline (5 TEXT columns on the agents row).
 *   - MISSION / IDEA / WORK scope → Git mode via `GitFacadeService.commit()`
 *     on the scope's repo at `.works/agents/<slug>/<name>`.
 *
 * Security mitigations applied on every write:
 *   - path / name validated against `AGENT_FILE_NAMES` allow-list
 *     (T3 — path traversal mitigation).
 *   - body secret-scanned (T4 hard-reject mode — agent files are
 *     deliberate authoring; redact mode is for chat / task description).
 *   - optimistic concurrency via `expectedHash` arg (T10).
 *   - max 64 KB per file (NFR-6).
 *
 * On every successful write:
 *   - `agents.contentHash` is recomputed as sha256 of the canonical
 *     5-file concatenation (used as ETag).
 *   - `AGENT_FILE_EDITED` activity row is logged with prevHash + newHash +
 *     diff (truncated to 5 KB) in `details`.
 *
 * Git mode for Mission/Work-scoped Agents is intentionally STUBBED in
 * v1's Phase 4 — the wiring needs the scope repo's clone path resolver
 * and a committer identity, which depend on the `GitFacadeService`
 * surface we'll thread through in Phase 6 alongside the heartbeat
 * dispatcher (which also needs scope-repo access). Until then, Git-mode
 * writes throw a clear error so the UI surfaces "stored in account"
 * mode only. Tenant-scope users see the full feature today.
 */
@Injectable()
export class AgentFileService {
	private readonly logger = new Logger(AgentFileService.name);

	constructor(
		private readonly agents: AgentRepository,
		// ActivityLogService is optional so the service can be unit-tested
		// without the entire activity-log module DI graph. In production
		// the ActivityLogModule provides it.
		@Optional() private readonly activityLog?: ActivityLogService,
	) {}

	async read(userId: string, agentId: string, name: AgentFileName): Promise<{
		name: AgentFileName;
		body: string;
		hash: string;
		storage: 'git' | 'db';
	}> {
		this.assertValidName(name);
		const agent = await this.requireOwned(userId, agentId);

		if (this.usesInlineStorage(agent)) {
			const body = this.readInline(agent, name) ?? '';
			return { name, body, hash: agent.contentHash ?? '', storage: 'db' };
		}

		// Git mode — stub for v1 Phase 4. Will land alongside heartbeat
		// dispatcher in Phase 6 when scope-repo helpers are wired.
		throw new BadRequestException(
			`Git-mode file storage for Mission/Work-scoped Agents lands in Phase 6 — ` +
				`use a tenant-scoped Agent for now, or edit the file directly in the scope's GitHub repo.`,
		);
	}

	async write(args: {
		userId: string;
		agentId: string;
		name: AgentFileName;
		body: string;
		expectedHash?: string;
	}): Promise<{ newHash: string }> {
		const { userId, agentId, name, body, expectedHash } = args;
		this.assertValidName(name);
		this.assertSize(body);
		assertNoSecrets(body, `Agent file ${name}`);

		const agent = await this.requireOwned(userId, agentId);

		// Optimistic concurrency: only enforce if caller supplied a hash.
		if (expectedHash !== undefined && (agent.contentHash ?? '') !== expectedHash) {
			await this.activityLog?.log({
				userId,
				actionType: ActivityActionType.AGENT_FILE_REVERTED,
				action: 'agent_file_reverted',
				status: ActivityStatus.FAILED,
				summary: `Concurrent edit on ${name} for agent ${agent.slug}`,
				details: { agentId: agent.id, name, expectedHash, currentHash: agent.contentHash ?? null },
			});
			throw new BadRequestException(
				`Agent file was modified elsewhere — reload and try again (etag mismatch).`,
			);
		}

		if (!this.usesInlineStorage(agent) && agent.scope !== AgentScope.TENANT) {
			throw new BadRequestException(
				`Git-mode file storage for Mission/Work-scoped Agents lands in Phase 6.`,
			);
		}

		// Build the new full row state (only one MD field changes).
		const prevHash = agent.contentHash ?? null;
		const updates = this.computeInlineUpdates(agent, name, body);
		const newHash = this.hashOf(updates);
		await this.agents.updateById(agent.id, { ...updates, contentHash: newHash });

		// Activity row — captured before throwing if logger unavailable, so we
		// don't fail the write if telemetry is wedged.
		try {
			await this.activityLog?.log({
				userId,
				actionType: ActivityActionType.AGENT_FILE_EDITED,
				action: 'agent_file_edited',
				status: ActivityStatus.COMPLETED,
				summary: `Edited ${name} for agent ${agent.slug}`,
				details: {
					agentId: agent.id,
					name,
					prevHash,
					newHash,
					diff: this.makeDiffSummary(this.readInline(agent, name) ?? '', body),
				},
			});
		} catch (err) {
			this.logger.warn(
				`Failed to log AGENT_FILE_EDITED activity for agent=${agent.id}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}

		return { newHash };
	}

	// ── helpers ───────────────────────────────────────────────────

	private assertValidName(name: string): asserts name is AgentFileName {
		if (!AGENT_FILE_NAMES.includes(name as AgentFileName)) {
			throw new BadRequestException(
				`Invalid file name "${name}". Allowed: ${AGENT_FILE_NAMES.join(', ')}.`,
			);
		}
	}

	private assertSize(body: string): void {
		const bytes = Buffer.byteLength(body, 'utf8');
		if (bytes > MAX_FILE_BYTES) {
			throw new BadRequestException(
				`File body is ${Math.round(bytes / 1024)} KB; max ${MAX_FILE_BYTES / 1024} KB.`,
			);
		}
	}

	private async requireOwned(userId: string, agentId: string): Promise<Agent> {
		const agent = await this.agents.findByIdAndUser(agentId, userId);
		if (!agent) {
			throw new NotFoundException(`Agent ${agentId} not found.`);
		}
		return agent;
	}

	private usesInlineStorage(agent: Agent): boolean {
		// Tenant scope always uses DB-inline (ADR-008). Mission/Work-scoped
		// Agents may have inline data if they were created before the
		// scope-repo wiring lands — read still works for those.
		return (
			agent.scope === AgentScope.TENANT ||
			[agent.soulMd, agent.agentsMd, agent.heartbeatMd, agent.toolsMd, agent.agentYml].some(
				(s) => s != null && s !== '',
			)
		);
	}

	private readInline(agent: Agent, name: AgentFileName): string | null {
		switch (name) {
			case 'SOUL.md':
				return agent.soulMd ?? null;
			case 'AGENTS.md':
				return agent.agentsMd ?? null;
			case 'HEARTBEAT.md':
				return agent.heartbeatMd ?? null;
			case 'TOOLS.md':
				return agent.toolsMd ?? null;
			case 'agent.yml':
				return agent.agentYml ?? null;
		}
	}

	private computeInlineUpdates(
		agent: Agent,
		name: AgentFileName,
		body: string,
	): Partial<Pick<Agent, 'soulMd' | 'agentsMd' | 'heartbeatMd' | 'toolsMd' | 'agentYml'>> {
		const current = {
			soulMd: agent.soulMd ?? '',
			agentsMd: agent.agentsMd ?? '',
			heartbeatMd: agent.heartbeatMd ?? '',
			toolsMd: agent.toolsMd ?? '',
			agentYml: agent.agentYml ?? '',
		};
		switch (name) {
			case 'SOUL.md':
				return { soulMd: body };
			case 'AGENTS.md':
				return { agentsMd: body };
			case 'HEARTBEAT.md':
				return { heartbeatMd: body };
			case 'TOOLS.md':
				return { toolsMd: body };
			case 'agent.yml':
				return { agentYml: body };
		}
		void current;
		return {};
	}

	/**
	 * sha256 of the canonical 5-file concatenation. Order: SOUL → AGENTS →
	 * HEARTBEAT → TOOLS → agent.yml, joined by a sentinel that won't appear
	 * in normal MD or YAML.
	 */
	private hashOf(updates: Partial<Agent>, base?: Agent): string {
		const merged = {
			SOUL: updates.soulMd ?? base?.soulMd ?? '',
			AGENTS: updates.agentsMd ?? base?.agentsMd ?? '',
			HEARTBEAT: updates.heartbeatMd ?? base?.heartbeatMd ?? '',
			TOOLS: updates.toolsMd ?? base?.toolsMd ?? '',
			AGENT_YML: updates.agentYml ?? base?.agentYml ?? '',
		};
		const concat =
			merged.SOUL +
			'SOUL/AGENTS' +
			merged.AGENTS +
			'AGENTS/HEARTBEAT' +
			merged.HEARTBEAT +
			'HEARTBEAT/TOOLS' +
			merged.TOOLS +
			'TOOLS/AGENTYML' +
			merged.AGENT_YML;
		return createHash('sha256').update(concat, 'utf8').digest('hex');
	}

	private makeDiffSummary(prev: string, next: string): { addedChars: number; removedChars: number; sample: string } {
		const sample = next.slice(0, 5 * 1024);
		return {
			addedChars: Math.max(0, next.length - prev.length),
			removedChars: Math.max(0, prev.length - next.length),
			sample,
		};
	}
}
