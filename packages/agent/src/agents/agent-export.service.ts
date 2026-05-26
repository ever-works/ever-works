import {
	BadRequestException,
	ConflictException,
	Injectable,
	Logger,
	NotFoundException,
	Optional,
} from '@nestjs/common';
import {
	AGENT_PERMISSIONS_DEFAULT,
	Agent,
	AgentAvatarMode,
	AgentIdleBehavior,
	AgentScope,
	AgentStatus,
	type AgentPermissions,
	type AgentTarget,
} from '../entities/agent.entity';
import { AgentRepository } from '../database/repositories/agent.repository';
import { AgentBudgetRepository } from '../database/repositories/agent-budget.repository';
import { AgentMembershipRepository } from '../database/repositories/agent-membership.repository';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { createHash } from 'crypto';
import { slugifyText } from '../utils/text.utils';
import { assertNoSecrets } from '../utils/secret-scan';
import type { AgentDto } from './types';
import { toAgentDto } from './types';

/**
 * Review-fix I7: shared canonical-hash function. Mirrors the
 * algorithm in `AgentFileService.hashOf` so import-overwrite refresh
 * stays bit-identical with future Instructions-editor writes. Kept
 * inline here (and matched exactly) to avoid coupling agent-export
 * to agent-file at the module-construction layer; the file is
 * intentionally tiny.
 */
function computeContentHash(files: {
	soulMd?: string | null;
	agentsMd?: string | null;
	heartbeatMd?: string | null;
	toolsMd?: string | null;
	agentYml?: string | null;
}): string {
	const merged = {
		SOUL: files.soulMd ?? '',
		AGENTS: files.agentsMd ?? '',
		HEARTBEAT: files.heartbeatMd ?? '',
		TOOLS: files.toolsMd ?? '',
		AGENT_YML: files.agentYml ?? '',
	};
	const concat =
		merged.SOUL +
		'SOUL/AGENTS' +
		merged.AGENTS +
		'AGENTS/HEARTBEAT' +
		merged.HEARTBEAT +
		'HEARTBEAT/TOOLS' +
		merged.TOOLS +
		'TOOLS/AGENTYML' +
		merged.AGENT_YML;
	return createHash('sha256').update(concat, 'utf8').digest('hex');
}

/**
 * Agents/Skills/Tasks PR #1017 — Phase 6a.
 *
 * Per-Agent export/import envelope (spec §5.11, N5 override). Distinct
 * from the bulk account-transfer flow in ADR-008 (which round-trips
 * ALL tenant data via a sync repo) — this is for backing up / sharing
 * / migrating ONE Agent.
 *
 * `version` lets future readers detect older envelopes and run a
 * migration. v1 is the only existing shape; bump on any breaking
 * change to the wire format.
 *
 * `scope` is carried so an import at a different scope can be done by
 * hand-editing the envelope before re-uploading (use case: clone a
 * tenant CEO into a Mission as "MissionCEO").
 */
export interface AgentExportEnvelope {
	version: 1;
	meta: {
		exportedAt: string;
		sourceAgentId: string;
		sourceUserId: string;
		appVersion?: string;
	};
	identity: {
		name: string;
		slug: string;
		title: string | null;
		capabilities: string | null;
		scope: AgentScope;
	};
	model: {
		aiProviderId: string | null;
		modelId: string | null;
		maxSkillContextTokens: number;
	};
	runtime: {
		permissions: AgentPermissions;
		targets: AgentTarget[] | null;
		heartbeatCadence: string | null;
		idleBehavior: AgentIdleBehavior;
		pauseAfterFailures: number;
	};
	avatar: {
		mode: AgentAvatarMode;
		icon: string | null;
		/**
		 * Set when mode === image. v1 envelope carries the original
		 * upload reference (uploadId). On import to a different tenant,
		 * the platform falls back to initials mode if the upload id is
		 * not visible to the importing user — keeping the envelope
		 * importable without round-tripping the asset bytes inline.
		 *
		 * The spec contemplates inlining base64-encoded bytes in a
		 * later iteration so an Agent can be shared cross-tenant with
		 * its avatar intact; for now we keep the uploadId reference and
		 * note the limitation.
		 */
		imageUploadId: string | null;
	};
	files: {
		soulMd: string | null;
		agentsMd: string | null;
		heartbeatMd: string | null;
		toolsMd: string | null;
		agentYml: string | null;
	};
	skillBindings: Array<{
		skillSlug: string;
		priority: number;
		overrides?: Record<string, unknown>;
	}>;
	budget: Array<{
		intervalUnit: string;
		intervalCount: number;
		capCents: number | null;
		currency: string;
	}>;
}

export type AgentImportConflictMode = 'skip' | 'overwrite' | 'rename';

export interface AgentImportOptions {
	/**
	 * Override the envelope's stored scope. Allows the operator to
	 * migrate an Agent between scopes (e.g. tenant → mission) at
	 * import time without editing the envelope JSON.
	 */
	overrideScope?: AgentScope;
	missionId?: string | null;
	ideaId?: string | null;
	workId?: string | null;
	onConflict?: AgentImportConflictMode;
}

export interface AgentImportResult {
	created: AgentDto;
	conflictResolution: 'none' | 'skipped' | 'overwritten' | 'renamed';
	originalSlug: string;
	finalSlug: string;
}

/**
 * Lives next to AgentsService — orchestrates per-Agent export +
 * import. Bulk account-transfer (ADR-008) is unrelated and ships in
 * Phase 19 with a different service.
 */
@Injectable()
export class AgentExportService {
	private readonly logger = new Logger(AgentExportService.name);

	constructor(
		private readonly agents: AgentRepository,
		private readonly memberships: AgentMembershipRepository,
		private readonly budgets: AgentBudgetRepository,
		@Optional() private readonly activityLog?: ActivityLogService,
	) {}

	async exportOne(userId: string, agentId: string): Promise<AgentExportEnvelope> {
		const agent = await this.agents.findByIdAndUser(agentId, userId);
		if (!agent) {
			throw new NotFoundException(`Agent ${agentId} not found.`);
		}

		// Review-fix I8: secret-scan every file body BEFORE serializing
		// the envelope. The import path already runs assertNoSecrets,
		// but a body written before the secret-scan landed (or by a
		// pre-PR-1017 import path) could otherwise leak credentials
		// through an export → off-platform → import round-trip. Hard
		// reject with a clear actionable message — the user can
		// scrub the file via the Instructions editor and re-export.
		const fileBodies: Array<[string, string | null | undefined]> = [
			['SOUL.md', agent.soulMd],
			['AGENTS.md', agent.agentsMd],
			['HEARTBEAT.md', agent.heartbeatMd],
			['TOOLS.md', agent.toolsMd],
			['agent.yml', agent.agentYml],
		];
		for (const [name, body] of fileBodies) {
			if (typeof body === 'string' && body.length > 0) {
				assertNoSecrets(body, `export-envelope:${agent.slug}:${name}`);
			}
		}

		const budgetRow = await this.budgets.findByAgentId(agentId).catch(() => null);
		const budgetRows = budgetRow ? [budgetRow] : [];

		const envelope: AgentExportEnvelope = {
			version: 1,
			meta: {
				exportedAt: new Date().toISOString(),
				sourceAgentId: agent.id,
				sourceUserId: agent.userId,
				appVersion: process.env.APP_VERSION,
			},
			identity: {
				name: agent.name,
				slug: agent.slug,
				title: agent.title ?? null,
				capabilities: agent.capabilities ?? null,
				scope: agent.scope,
			},
			model: {
				aiProviderId: agent.aiProviderId ?? null,
				modelId: agent.modelId ?? null,
				maxSkillContextTokens: agent.maxSkillContextTokens,
			},
			runtime: {
				permissions: agent.permissions ?? AGENT_PERMISSIONS_DEFAULT,
				targets: agent.targets ?? null,
				heartbeatCadence: agent.heartbeatCadence ?? null,
				idleBehavior: agent.idleBehavior,
				pauseAfterFailures: agent.pauseAfterFailures,
			},
			avatar: {
				mode: agent.avatarMode,
				icon: agent.avatarIcon ?? null,
				imageUploadId: agent.avatarImageUploadId ?? null,
			},
			files: {
				soulMd: agent.soulMd ?? null,
				agentsMd: agent.agentsMd ?? null,
				heartbeatMd: agent.heartbeatMd ?? null,
				toolsMd: agent.toolsMd ?? null,
				agentYml: agent.agentYml ?? null,
			},
			skillBindings: [], // Phase 9 — skill bindings table ships then.
			budget: budgetRows.map((b: any) => ({
				intervalUnit: b.intervalUnit,
				intervalCount: b.intervalCount ?? 1,
				capCents: b.capCents ?? null,
				currency: b.currency ?? 'USD',
			})),
		};

		await this.logActivity({
			userId,
			agentId,
			actionType: ActivityActionType.AGENT_EXPORTED,
		});

		return envelope;
	}

	async importOne(
		userId: string,
		envelope: AgentExportEnvelope,
		options: AgentImportOptions = {},
	): Promise<AgentImportResult> {
		this.assertValidEnvelope(envelope);

		const scope = options.overrideScope ?? envelope.identity.scope;
		const missionId = options.missionId ?? null;
		const ideaId = options.ideaId ?? null;
		const workId = options.workId ?? null;

		// Re-run the scope ownership check (mirrors AgentsService.validateScopeOwnership).
		if (scope === AgentScope.TENANT && (missionId || ideaId || workId)) {
			throw new BadRequestException('Tenant-scoped import must not carry missionId/ideaId/workId.');
		}
		if (scope === AgentScope.MISSION && !missionId) {
			throw new BadRequestException('Mission-scoped import requires missionId option.');
		}
		if (scope === AgentScope.IDEA && !ideaId) {
			throw new BadRequestException('Idea-scoped import requires ideaId option.');
		}
		if (scope === AgentScope.WORK && !workId) {
			throw new BadRequestException('Work-scoped import requires workId option.');
		}

		// Secret-scan every file body BEFORE persisting — same hard-reject
		// posture as live edits via AgentFileService.write.
		for (const [name, body] of Object.entries(envelope.files)) {
			if (typeof body === 'string' && body.length > 0) {
				assertNoSecrets(body, `import-envelope:${name}`);
			}
		}

		const originalSlug = slugifyText(envelope.identity.name) || envelope.identity.slug;
		const mode = options.onConflict ?? 'rename';

		const conflict = await this.agents.findByUserIdAndSlug(userId, scope, originalSlug, {
			missionId,
			ideaId,
			workId,
		});

		let finalSlug = originalSlug;
		let conflictResolution: AgentImportResult['conflictResolution'] = 'none';

		if (conflict) {
			if (mode === 'skip') {
				throw new ConflictException(
					`Agent with slug "${originalSlug}" already exists in this scope — skip mode.`,
				);
			} else if (mode === 'overwrite') {
				await this.applyEnvelopeToExisting(conflict, envelope);
				conflictResolution = 'overwritten';
				const refreshed = (await this.agents.findById(conflict.id)) as Agent;
				await this.logActivity({
					userId,
					agentId: conflict.id,
					actionType: ActivityActionType.AGENT_IMPORTED,
				});
				return {
					created: toAgentDto(refreshed),
					conflictResolution,
					originalSlug,
					finalSlug: originalSlug,
				};
			} else {
				// rename
				finalSlug = await this.deriveUniqueSlug(userId, scope, originalSlug, {
					missionId,
					ideaId,
					workId,
				});
				conflictResolution = 'renamed';
			}
		}

		const permissions: AgentPermissions = {
			...AGENT_PERMISSIONS_DEFAULT,
			...envelope.runtime.permissions,
		};
		if (permissions.canOpenPullRequests && !permissions.canCommitToRepo) {
			permissions.canCommitToRepo = true;
		}

		// Image uploads from a different tenant are not visible to this
		// user — fall back to initials so the import never 404s on a
		// dangling reference.
		const safeAvatarMode =
			envelope.avatar.mode === AgentAvatarMode.IMAGE &&
			envelope.avatar.imageUploadId === null
				? AgentAvatarMode.INITIALS
				: envelope.avatar.mode;

		const created = await this.agents.create({
			userId,
			scope,
			missionId: scope === AgentScope.MISSION ? missionId : null,
			ideaId: scope === AgentScope.IDEA ? ideaId : null,
			workId: scope === AgentScope.WORK ? workId : null,
			name: finalSlug === originalSlug ? envelope.identity.name : `${envelope.identity.name} (imported)`,
			slug: finalSlug,
			title: envelope.identity.title,
			capabilities: envelope.identity.capabilities,
			aiProviderId: envelope.model.aiProviderId,
			modelId: envelope.model.modelId,
			maxSkillContextTokens: envelope.model.maxSkillContextTokens,
			status: AgentStatus.DRAFT, // imported Agents always start in DRAFT — user vets before activating
			permissions,
			targets: envelope.runtime.targets,
			heartbeatCadence: envelope.runtime.heartbeatCadence,
			idleBehavior: envelope.runtime.idleBehavior,
			pauseAfterFailures: envelope.runtime.pauseAfterFailures,
			errorCount: 0,
			avatarMode: safeAvatarMode,
			avatarIcon: safeAvatarMode === AgentAvatarMode.ICON ? envelope.avatar.icon : null,
			avatarImageUploadId:
				safeAvatarMode === AgentAvatarMode.IMAGE ? envelope.avatar.imageUploadId : null,
			soulMd: envelope.files.soulMd ?? null,
			agentsMd: envelope.files.agentsMd ?? null,
			heartbeatMd: envelope.files.heartbeatMd ?? null,
			toolsMd: envelope.files.toolsMd ?? null,
			agentYml: envelope.files.agentYml ?? null,
		} as Partial<Agent>);

		if (scope === AgentScope.TENANT && envelope.runtime.targets && envelope.runtime.targets.length > 0) {
			await this.memberships
				.replaceForAgent(
					created.id,
					envelope.runtime.targets
						.filter((t) => t.type !== 'wildcard')
						.map((t) => ({ targetType: t.type, targetId: t.id ?? null })),
				)
				.catch((err) => {
					this.logger.warn(`Could not materialize memberships on import: ${err}`);
				});
		}

		await this.logActivity({
			userId,
			agentId: created.id,
			actionType: ActivityActionType.AGENT_IMPORTED,
		});

		return {
			created: toAgentDto(created),
			conflictResolution,
			originalSlug,
			finalSlug,
		};
	}

	// ── internals ─────────────────────────────────────────────────

	private assertValidEnvelope(envelope: AgentExportEnvelope): void {
		if (!envelope || typeof envelope !== 'object') {
			throw new BadRequestException('Envelope must be an object.');
		}
		if (envelope.version !== 1) {
			throw new BadRequestException(`Unsupported envelope version: ${envelope.version}`);
		}
		if (!envelope.identity?.name || typeof envelope.identity.name !== 'string') {
			throw new BadRequestException('Envelope identity.name is required.');
		}
		if (!Object.values(AgentScope).includes(envelope.identity.scope)) {
			throw new BadRequestException(`Envelope identity.scope is invalid: ${envelope.identity.scope}`);
		}
	}

	private async applyEnvelopeToExisting(target: Agent, envelope: AgentExportEnvelope): Promise<void> {
		// Review-fix I7: recompute contentHash so subsequent
		// Instructions-editor writes (which use expectedHash for
		// optimistic concurrency) don't fail with a stale-hash mismatch
		// against the now-overwritten file bodies.
		const files = {
			soulMd: envelope.files.soulMd ?? null,
			agentsMd: envelope.files.agentsMd ?? null,
			heartbeatMd: envelope.files.heartbeatMd ?? null,
			toolsMd: envelope.files.toolsMd ?? null,
			agentYml: envelope.files.agentYml ?? null,
		};
		const patch: Partial<Agent> = {
			name: envelope.identity.name,
			title: envelope.identity.title,
			capabilities: envelope.identity.capabilities,
			aiProviderId: envelope.model.aiProviderId,
			modelId: envelope.model.modelId,
			maxSkillContextTokens: envelope.model.maxSkillContextTokens,
			permissions: envelope.runtime.permissions,
			targets: envelope.runtime.targets,
			heartbeatCadence: envelope.runtime.heartbeatCadence,
			idleBehavior: envelope.runtime.idleBehavior,
			pauseAfterFailures: envelope.runtime.pauseAfterFailures,
			soulMd: files.soulMd,
			agentsMd: files.agentsMd,
			heartbeatMd: files.heartbeatMd,
			toolsMd: files.toolsMd,
			agentYml: files.agentYml,
			contentHash: computeContentHash(files),
		};
		await this.agents.updateById(target.id, patch);
	}

	private async deriveUniqueSlug(
		userId: string,
		scope: AgentScope,
		base: string,
		ids: { missionId: string | null; ideaId: string | null; workId: string | null },
		maxAttempts = 200,
	): Promise<string> {
		for (let i = 2; i <= maxAttempts; i++) {
			const candidate = `${base}-${i}`;
			const existing = await this.agents.findByUserIdAndSlug(userId, scope, candidate, ids);
			if (!existing) return candidate;
		}
		throw new ConflictException(`Could not derive a unique slug for "${base}" after ${maxAttempts} attempts.`);
	}

	private async logActivity(args: {
		userId: string;
		agentId: string;
		actionType: ActivityActionType;
	}): Promise<void> {
		if (!this.activityLog) return;
		try {
			await this.activityLog.log({
				userId: args.userId,
				action: args.actionType,
				actionType: args.actionType,
				status: ActivityStatus.SUCCESS,
				resourceType: 'agent',
				resourceId: args.agentId,
			});
		} catch (err) {
			this.logger.warn(`Failed to log activity ${args.actionType}: ${err}`);
		}
	}
}
