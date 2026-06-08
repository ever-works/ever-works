import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type EntityTarget, type ObjectLiteral } from 'typeorm';
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
// Security (EW-711 #8): scope-entity classes used to verify the caller
// owns the target Mission/Idea/Work BEFORE an imported Agent is planted
// under that scope id. Reached via the shared DataSource (no new module
// wiring) — see `assertScopeOwned`.
import { Mission } from '../entities/mission.entity';
import { Work } from '../entities/work.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import { AgentRepository } from '../database/repositories/agent.repository';
import { AgentBudgetRepository } from '../database/repositories/agent-budget.repository';
import { AgentMembershipRepository } from '../database/repositories/agent-membership.repository';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { createHash } from 'crypto';
import { slugifyText } from '../utils/text.utils';
import { assertNoSecrets } from '../utils/secret-scan';
import { assertNoInjectionTokens } from '../utils/content-policy';
import type { AgentDto } from './types';
import { toAgentDto } from './types';

// Security: per-file byte cap for imported instruction bodies. Mirrors
// the 64 KB `MAX_FILE_BYTES` limit enforced on the live-edit path
// (`AgentFileService.write` → `assertSize`). The import path previously
// only secret-scanned the bodies with no size bound, so a single
// envelope field could carry a multi-megabyte string that bloats the
// `agents` TEXT columns and forces a full-string scan in memory. Kept
// inline (and matched in value) to avoid coupling agent-export to
// agent-file at the module-construction layer.
const MAX_IMPORT_FILE_BYTES = 64 * 1024; // 64 KB per file (spec §5.10a / §5.6.6).

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
        // Security (EW-711 #8): the raw Agent repository is already
        // registered by `AgentsModule`'s `TypeOrmModule.forFeature([Agent,
        // …])`, so this resolves to a live `Repository<Agent>` in
        // production with NO extra module wiring. We only use its
        // `.manager` (the shared DataSource EntityManager) to load the
        // target Mission/Idea/Work scope entity for an ownership check —
        // mirroring the existing `manager.getRepository(...)` pattern in
        // `github-app-installation-repository.repository.ts`. `@Optional()`
        // keeps hand-rolled unit harnesses (which `new` the service with
        // only the first four deps) constructing; the presence gate in
        // `assertScopeOwned` keeps the production check strict.
        @Optional()
        @InjectRepository(Agent)
        private readonly agentEntityRepo?: Repository<Agent>,
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
            throw new BadRequestException(
                'Tenant-scoped import must not carry missionId/ideaId/workId.',
            );
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

        // Security (EW-711 #8): IDOR — verify the caller OWNS the target
        // scope entity BEFORE planting an imported Agent under it. The
        // missionId/ideaId/workId values flow straight from controller
        // query params (`agents.controller.ts` import handler) into
        // `agents.create(...)` below; the shape-only checks above never
        // confirm the scope id belongs to this user, and the scope columns
        // are intentionally NOT FK-constrained (see `agent.entity.ts`), so
        // any authenticated user could otherwise create/plant an Agent
        // inside another user's Mission/Idea/Work. Mirror how sibling
        // services scope ownership (`MissionsService.findOrThrow`,
        // `WorkProposalRepository.findByIdForUser`): load the scope row by
        // (id, userId) and 404 — same not-found shape either way — when it
        // is missing or owned by someone else. Tenant scope has no target
        // id, so it is unaffected.
        await this.assertScopeOwned(userId, scope, { missionId, ideaId, workId });

        // Secret-scan every file body BEFORE persisting — same hard-reject
        // posture as live edits via AgentFileService.write.
        for (const [name, body] of Object.entries(envelope.files)) {
            if (typeof body === 'string' && body.length > 0) {
                // Security: enforce the same 64 KB per-file cap the
                // live-edit path applies (AgentFileService.assertSize),
                // BEFORE the secret-scan walks the whole string. Without
                // this an imported envelope could carry a multi-megabyte
                // body that bloats the agents TEXT columns and forces an
                // unbounded in-memory scan (DoS). Checked first so an
                // oversized body is rejected without being scanned.
                const bytes = Buffer.byteLength(body, 'utf8');
                if (bytes > MAX_IMPORT_FILE_BYTES) {
                    throw new BadRequestException(
                        `Imported file "${name}" is ${Math.round(
                            bytes / 1024,
                        )} KB; max ${MAX_IMPORT_FILE_BYTES / 1024} KB.`,
                    );
                }
                assertNoSecrets(body, `import-envelope:${name}`);
                // D11: reject imported instruction bodies that carry
                // chat-template control tokens (<|im_start|>, [INST], …) — a
                // shared/catalog Agent could otherwise inject a forged system
                // turn into the importer's runtime context.
                assertNoInjectionTokens(body, `import-envelope:${name}`);
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

        // Security (D9): clamp imported permissions to least-privilege.
        // The envelope's `runtime.permissions` is attacker-controllable
        // (it round-trips through an off-platform JSON file an importer
        // can hand-edit), so honouring it would let an import grant an
        // Agent ELEVATED capabilities the importer may not be entitled to
        // (privilege escalation across import). Start every imported Agent
        // at the all-false frozen default — the owner must explicitly
        // re-grant capabilities via the normal permissions UI after
        // vetting the imported Agent (which also starts in DRAFT). We
        // deliberately do NOT spread `envelope.runtime.permissions` here.
        const permissions: AgentPermissions = { ...AGENT_PERMISSIONS_DEFAULT };

        // Image uploads from a different tenant are not visible to this
        // user — fall back to initials so the import never 404s on a
        // dangling reference.
        const safeAvatarMode =
            envelope.avatar.mode === AgentAvatarMode.IMAGE && envelope.avatar.imageUploadId === null
                ? AgentAvatarMode.INITIALS
                : envelope.avatar.mode;

        const created = await this.agents.create({
            userId,
            scope,
            missionId: scope === AgentScope.MISSION ? missionId : null,
            ideaId: scope === AgentScope.IDEA ? ideaId : null,
            workId: scope === AgentScope.WORK ? workId : null,
            name:
                finalSlug === originalSlug
                    ? envelope.identity.name
                    : `${envelope.identity.name} (imported)`,
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

        if (
            scope === AgentScope.TENANT &&
            envelope.runtime.targets &&
            envelope.runtime.targets.length > 0
        ) {
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
            throw new BadRequestException(
                `Envelope identity.scope is invalid: ${envelope.identity.scope}`,
            );
        }
    }

    /**
     * Security (EW-711 #8): reject an import whose target scope entity is
     * not owned by `userId`. Loads the Mission / Idea (WorkProposal) /
     * Work row by `(id, userId)` via the shared DataSource and throws
     * `NotFoundException` (404 — does NOT leak whether the id exists, same
     * posture as `MissionsService.findOrThrow`) when the row is missing or
     * belongs to another user.
     *
     * TENANT scope carries no target id, so it is a no-op. When the raw
     * Agent repository isn't wired (hand-rolled unit tests `new` the
     * service without it) the check is skipped so those harnesses keep
     * working — production always injects it via
     * `TypeOrmModule.forFeature([Agent, …])`.
     */
    private async assertScopeOwned(
        userId: string,
        scope: AgentScope,
        ids: { missionId: string | null; ideaId: string | null; workId: string | null },
    ): Promise<void> {
        // TENANT scope carries no target id — nothing to own-check.
        if (scope === AgentScope.TENANT) return;

        // Resolve the scope entity + its target id. The shape checks in
        // `importOne` already guarantee the matching id is present, but we
        // re-guard defensively so a future caller can't slip a null past us.
        // `Ideas` are persisted as `WorkProposal` rows (owner column
        // `userId`); Mission + Work likewise expose a `userId` owner column.
        // `EntityTarget<ObjectLiteral>` keeps `getRepository` typing
        // entity-agnostic across the Mission / WorkProposal / Work trio
        // (all three carry an `id` + `userId` owner column).
        const entity: EntityTarget<ObjectLiteral> =
            scope === AgentScope.MISSION
                ? Mission
                : scope === AgentScope.IDEA
                  ? WorkProposal
                  : Work;
        const targetId =
            scope === AgentScope.MISSION
                ? ids.missionId
                : scope === AgentScope.IDEA
                  ? ids.ideaId
                  : ids.workId;
        if (!targetId) {
            // Defensive: shape validation should have caught this already.
            throw new BadRequestException(`Missing target id for ${scope}-scoped import.`);
        }

        // Skip only when the repo isn't wired (mock-only unit harnesses);
        // production resolves a live Repository<Agent> and its `.manager`
        // reaches every entity in the same DataSource.
        if (!this.agentEntityRepo) return;

        // Existence-by-owner: count instead of hydrating a full row just to
        // assert ownership.
        const ownedCount = await this.agentEntityRepo.manager
            .getRepository(entity)
            .count({ where: { id: targetId, userId } });
        if (ownedCount === 0) {
            // 404 (not 403) — don't leak existence of another user's scope.
            throw new NotFoundException(`${scope} ${targetId} not found.`);
        }
    }

    private async applyEnvelopeToExisting(
        target: Agent,
        envelope: AgentExportEnvelope,
    ): Promise<void> {
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
        // PASS-4 review fix (HIGH): apply the same safeAvatarMode
        // normalization used on the create path. Cross-tenant image
        // uploads from a different user's tenant aren't visible to
        // THIS user — falling back to INITIALS prevents a dangling
        // reference. The second-pass fix added the avatar fields to
        // the patch but bypassed this guard.
        const safeAvatarMode =
            envelope.avatar.mode === AgentAvatarMode.IMAGE && envelope.avatar.imageUploadId === null
                ? AgentAvatarMode.INITIALS
                : envelope.avatar.mode;
        const patch: Partial<Agent> = {
            name: envelope.identity.name,
            title: envelope.identity.title,
            capabilities: envelope.identity.capabilities,
            aiProviderId: envelope.model.aiProviderId,
            modelId: envelope.model.modelId,
            maxSkillContextTokens: envelope.model.maxSkillContextTokens,
            // Security (D9): clamp imported permissions to least-privilege
            // on the overwrite path too — the envelope is attacker-editable,
            // so an overwrite import must NOT silently elevate an existing
            // Agent beyond the all-false frozen default. Mirrors the
            // create-path clamp in `importOne`; the owner re-grants
            // explicitly after vetting. Deliberately not the envelope value.
            permissions: { ...AGENT_PERMISSIONS_DEFAULT },
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
            avatarMode: safeAvatarMode,
            avatarIcon: safeAvatarMode === AgentAvatarMode.ICON ? envelope.avatar.icon : null,
            avatarImageUploadId:
                safeAvatarMode === AgentAvatarMode.IMAGE ? envelope.avatar.imageUploadId : null,
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
        throw new ConflictException(
            `Could not derive a unique slug for "${base}" after ${maxAttempts} attempts.`,
        );
    }

    private async logActivity(args: {
        userId: string;
        agentId: string;
        actionType: ActivityActionType;
    }): Promise<void> {
        if (!this.activityLog) return;
        try {
            // Post-rebase fix: develop's CreateActivityLogDto dropped
            // `resourceType` + `resourceId` (now lives under `details`),
            // and `ActivityStatus.SUCCESS` was renamed `COMPLETED`.
            await this.activityLog.log({
                userId: args.userId,
                action: args.actionType,
                actionType: args.actionType,
                status: ActivityStatus.COMPLETED,
                summary: `Agent ${args.agentId} — ${args.actionType}`,
                details: { resourceType: 'agent', resourceId: args.agentId },
            });
        } catch (err) {
            this.logger.warn(`Failed to log activity ${args.actionType}: ${err}`);
        }
    }
}
