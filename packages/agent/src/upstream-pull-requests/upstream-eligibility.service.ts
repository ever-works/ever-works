import { Injectable, Logger, Optional } from '@nestjs/common';
import {
    UPSTREAM_LIMIT_WINDOW_MS,
    effectiveUpstreamMaxOpen,
    isAppWorkKind,
    type AppSourceRecord,
    type UpstreamEligibilityView,
} from '@ever-works/contracts';
import { config } from '../config';
import { WorkRepository } from '../database/repositories/work.repository';
import { TaskRepository } from '../database/repositories/task.repository';
import { UpstreamPullRequestRepository } from '../database/repositories/upstream-pull-request.repository';
import { AppSpecService } from '../app-spec/app-spec.service';
import { relationOf } from '../app-works/app-source-initializer.service';
import { resolveTaskRepository } from '../tasks-domain/task-repository';
import { UpstreamCredentialService } from './upstream-credential.service';
import { decideUpstreamEligibility, type UpstreamEligibilityDecision } from './upstream-eligibility.rules';
import { evaluateUpstreamRateLimits, type UpstreamRateLimitRefusal } from './upstream-rate-limits';

/** The eligibility answer: the API view plus the active record the `409` names. */
export type UpstreamEligibilityResult = UpstreamEligibilityView & {
    /** FR-5: the record that already holds the Task's slot (`409 activeProposal`). */
    readonly activeProposalId?: string | null;
    /** `taskNotOnWork` — the named Task is not one of this App Work's (the API answers `404`). */
    readonly taskNotOnWork?: boolean;
};

export interface UpstreamLimitScope {
    readonly workId: string;
    readonly userId: string;
    readonly upstreamOwner: string;
    readonly upstreamRepo: string;
    /** The App Work's effective open-at-once cap; read from the App spec when absent. */
    readonly maxOpen?: number;
    /** `true` after the caller's own record was claimed (see `evaluateUpstreamRateLimits`). */
    readonly includesSelf?: boolean;
    readonly now?: Date;
}

/**
 * APW-09 T9 — eligibility and the FR-26 / FR-39 limits, read from the platform's own state.
 *
 * ## What this slice reads, and what it leaves to the preparation step
 *
 * Read here (no provider call): the operator kill switch and deny list, the App Work's relation
 * and upstream (APW-01), the effective App spec's `upstreamPullRequests.enabled` / `maxOpen`
 * through `AppSpecService.getEffectiveSpec` (APW-03, G15), the source Task's pull-request state,
 * the active record (FR-5), the member's own connection (`UpstreamCredentialService`, FR-24 —
 * never a Work-resolved token) and the limit windows over `upstream_pull_requests`.
 *
 * NOT read here: the provider-side checks of FR-4 (archived, collaborators-only interaction
 * limit, fork network root, push permission, pull requests switched off, the maintainer
 * opt-out). They need a provider call with the member's token and belong to the preparation
 * step (T15), which re-checks immediately before opening. `preparationAvailable: false` says so
 * to the web, which keeps **Propose upstream** disabled until that step ships.
 *
 * Every collaborator is `@Optional()`; a missing one fails CLOSED (`disabled` / "not opted in").
 */
@Injectable()
export class UpstreamEligibilityService {
    private readonly logger = new Logger(UpstreamEligibilityService.name);

    constructor(
        @Optional() private readonly works?: WorkRepository,
        @Optional() private readonly tasks?: TaskRepository,
        @Optional() private readonly records?: UpstreamPullRequestRepository,
        @Optional() private readonly appSpec?: AppSpecService,
        @Optional() private readonly credentials?: UpstreamCredentialService,
    ) {}

    /**
     * The eligibility view for one member on one App Work, optionally for one source Task.
     * The caller has already proved edit access to the Work.
     */
    async evaluate(input: {
        workId: string;
        userId: string;
        taskId?: string | null;
        now?: Date;
    }): Promise<UpstreamEligibilityResult> {
        const now = input.now ?? new Date();
        const work = this.works ? await this.works.findById(input.workId) : null;
        const record = (work?.sourceRepository ?? {}) as AppSourceRecord;
        const relation = work && isAppWorkKind(work.kind) ? relationOf(record) : null;
        const upstream = record.upstream?.owner && record.upstream?.repo ? record.upstream : null;
        const fork = work ? safeTarget(work) : null;
        const baseBranch = upstream?.defaultBranch || 'main';
        const latest = this.records
            ? await this.records.findLatestForUser(input.workId, input.userId).catch(() => null)
            : null;

        const base: UpstreamEligibilityView = {
            allowed: false,
            target:
                upstream && fork
                    ? {
                          owner: upstream.owner,
                          repo: upstream.repo,
                          baseBranch,
                          forkOwner: fork.owner,
                          forkRepo: fork.repo,
                      }
                    : null,
            orgFork: false,
            maintainerCanModifyDefault: latest ? latest.maintainerCanModify !== false : true,
            relation,
            preparationAvailable: false,
        };

        if (!work || !this.records) {
            return { ...base, code: 'disabled' };
        }

        const denied =
            !!upstream &&
            config.everWorks.apps
                .upstreamDenyList()
                .includes(`${upstream.owner}/${upstream.repo}`.toLowerCase());
        const spec = await this.readSpec(work.id);

        let task: { prState: string | null } | null | undefined;
        let activeRecordId: string | null = null;
        if (input.taskId) {
            const found = this.tasks ? await this.tasks.findById(input.taskId).catch(() => null) : null;
            task = found && found.workId === work.id ? { prState: found.prState ?? null } : null;
            if (task) {
                const active = await this.records.findActiveBySourceTask(work.id, input.taskId);
                activeRecordId = active?.id ?? null;
            }
        }

        // The expensive / provider-adjacent reads only when everything before them passed.
        const preliminary = decideUpstreamEligibility({
            killSwitchOn: config.everWorks.apps.upstreamPullRequestsEnabled(),
            relation,
            hasUpstream: !!upstream,
            denied,
            optedIn: spec.optedIn,
            task,
            activeRecordId,
        });
        if (preliminary.allowed === false) return this.toView(base, preliminary);

        const connectionUsable = await this.connectionUsable(work.id, input.userId);
        const limits =
            upstream && fork
                ? await this.limitsFor({
                      workId: work.id,
                      userId: input.userId,
                      upstreamOwner: upstream.owner,
                      upstreamRepo: upstream.repo,
                      maxOpen: spec.maxOpen,
                      now,
                  })
                : null;

        const decision = decideUpstreamEligibility({
            killSwitchOn: true,
            relation,
            hasUpstream: !!upstream,
            denied,
            optedIn: spec.optedIn,
            task,
            activeRecordId,
            connectionUsable,
            limits,
        });
        return this.toView(base, decision);
    }

    /**
     * The FR-26 / FR-39 limits for one member on one upstream (`null` = allowed). Used by the
     * eligibility read and enforced by every door that opens a pull request.
     */
    async limitsFor(scope: UpstreamLimitScope): Promise<UpstreamRateLimitRefusal | null> {
        if (!this.records) return null;
        const now = scope.now ?? new Date();
        const since = new Date(now.getTime() - UPSTREAM_LIMIT_WINDOW_MS);
        const maxOpen = scope.maxOpen ?? (await this.readSpec(scope.workId)).maxOpen;
        const [openedByUserOnUpstream, openedByUser, openedOnUpstream, openByUserOnUpstream] =
            await Promise.all([
                this.records.openedAtInWindow(
                    {
                        userId: scope.userId,
                        upstreamOwner: scope.upstreamOwner,
                        upstreamRepo: scope.upstreamRepo,
                    },
                    since,
                    100,
                ),
                this.records.openedAtInWindow({ userId: scope.userId }, since, 100),
                this.records.openedAtInWindow(
                    { upstreamOwner: scope.upstreamOwner, upstreamRepo: scope.upstreamRepo },
                    since,
                    100,
                ),
                this.records.countOpenByUserOnUpstream(
                    scope.userId,
                    scope.upstreamOwner,
                    scope.upstreamRepo,
                ),
            ]);
        const overallOverride = config.everWorks.apps.upstreamPullRequestMaxPerDay();
        return evaluateUpstreamRateLimits({
            openedByUserOnUpstream,
            openedByUser,
            openedOnUpstream,
            openByUserOnUpstream,
            maxOpen,
            limits: overallOverride ? { openedOverallPer24h: overallOverride } : undefined,
            includesSelf: scope.includesSelf,
            now,
        });
    }

    /** The effective App spec's opt-in and open-at-once cap. Unreadable ⇒ not opted in. */
    async readSpec(workId: string): Promise<{ optedIn: boolean; maxOpen: number }> {
        if (!this.appSpec) return { optedIn: false, maxOpen: effectiveUpstreamMaxOpen(undefined) };
        try {
            const read = await this.appSpec.getEffectiveSpec(workId);
            const block = read?.spec?.upstreamPullRequests;
            return {
                optedIn: block?.enabled === true,
                maxOpen: effectiveUpstreamMaxOpen(block?.maxOpen),
            };
        } catch (error) {
            this.logger.warn(
                `Reading the App spec of work ${workId} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return { optedIn: false, maxOpen: effectiveUpstreamMaxOpen(undefined) };
        }
    }

    private async connectionUsable(workId: string, userId: string): Promise<boolean> {
        if (!this.credentials) return false;
        try {
            const resolved = await this.credentials.resolveForPublishingMember(workId, userId);
            return resolved.usable === true;
        } catch {
            return false;
        }
    }

    private toView(
        base: UpstreamEligibilityView,
        decision: UpstreamEligibilityDecision,
    ): UpstreamEligibilityResult {
        if (decision.allowed === true) return { ...base, allowed: true };
        const refused = decision as Extract<UpstreamEligibilityDecision, { allowed: false }>;
        if (refused.code === 'activeProposal') {
            return { ...base, activeProposalId: refused.activeId ?? null };
        }
        if (refused.code === 'taskNotOnWork') {
            return { ...base, taskNotOnWork: true };
        }
        const view: UpstreamEligibilityResult = { ...base, code: refused.code };
        if (refused.limit) {
            return {
                ...view,
                limit: refused.limit,
                ...(typeof refused.limitValue === 'number' ? { limitValue: refused.limitValue } : {}),
                ...(refused.nextSlotAt ? { nextSlotAt: refused.nextSlotAt } : {}),
            };
        }
        return view;
    }
}

function safeTarget(work: Parameters<typeof resolveTaskRepository>[0]): { owner: string; repo: string } | null {
    try {
        const target = resolveTaskRepository(work);
        return target ? { owner: target.owner, repo: target.repo } : null;
    } catch {
        return null;
    }
}
