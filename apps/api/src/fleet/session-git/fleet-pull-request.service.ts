import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AgentRepository, AgentRunRepository } from '@ever-works/agent/database';
import { GitFacadeService } from '@ever-works/agent/facades';
import {
    FleetAccessService,
    FleetAuditService,
    FleetCheckoutRepository,
    FleetCheckoutService,
    FleetKillSwitchService,
    FleetSessionActionService,
    FleetSessionRepository,
    fleetSessionError,
    readFleetSessionError,
    type FleetCheckout,
    type FleetSession,
} from '@ever-works/agent/fleet';
import { TaskRepository, TaskWorkspaceService } from '@ever-works/agent/tasks-domain';
import { getOptionalProvider, redactSecrets } from '@ever-works/agent/utils';
import {
    FLEET_PULL_REQUEST_BODY_MAX_LENGTH,
    FLEET_PULL_REQUEST_TITLE_MAX_LENGTH,
    fleetBranchWithoutRemote,
    isFleetSessionOnDefaultBranch,
    parseFleetGitLine,
    parseFleetRemote,
    type FleetOpenPullRequestRequest,
    type FleetOpenPullRequestResponse,
    type FleetPullRequestDraft,
} from '@ever-works/contracts';
import type { FleetRunCredentialBinding } from '../../auth/types/auth.types';
import { FleetPrEnrichmentService } from './fleet-pr-enrichment.service';

/** Who asks: a person, or an Agent session through its run-scoped token (`ew_run_…`). */
export interface FleetPullRequestCaller {
    userId: string;
    /** An Agent acting through its in-process tools (`fleet_checkouts_open_pull_request`). */
    agentId?: string | null;
    /** Present when a fleet-run token authenticated the request (the Agent session's MCP bridge). */
    run?: FleetRunCredentialBinding | null;
}

function firstLine(text: unknown): string {
    const line = (typeof text === 'string' ? text : '').split(/\r?\n/, 1)[0]?.trim() ?? '';
    return line.slice(0, 300) || 'the provider refused the request';
}

/** `fix-login` → `Fix login` (the dialog's title when nothing better is known). */
function titleFromBranch(branch: string | null): string {
    const leaf = (branch ?? '').split('/').filter(Boolean).pop() ?? '';
    const words = leaf.replace(/[-_]+/g, ' ').trim();
    if (!words) return '';
    return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, FLEET_PULL_REQUEST_TITLE_MAX_LENGTH);
}

/**
 * Session git & actions (FL-06 P2, spec FR-16 … FR-20, U10 … U12, S4, S5) —
 * the platform-side pull request of a session's checkout. Pull requests are
 * opened or updated by the PLATFORM, after the computer pushed the branch,
 * through the GitHub App; the session never holds a credential for the
 * provider's API (FR-17), and nothing here merges (FR-20 — the merge policy
 * alone decides that, on the Task's own path).
 *
 * Refusals, in order: the kill switch (`kill_switch`; one already asked for
 * completes — this answers before anything is sent); the checkout and the
 * Node's `checkouts` audience (404 / `permission_denied`); a run token only
 * for ITS session's own checkout (`permission_denied`); the Agent's "may open
 * pull requests" permission (`permission_denied` naming it, U11); the title
 * and body (redacted before they leave, NFR); a github.com remote and a
 * branch that is not the default (`invalid`); the provider (`operation_failed`
 * with its first line, U12). An open pull request for the branch is UPDATED,
 * never doubled (FR-16). A session working on a Task goes through the Task's
 * own finalize — the pull request is recorded on the Task and it moves to In
 * review, exactly as a Task run (FR-19).
 */
@Injectable()
export class FleetPullRequestService {
    private readonly logger = new Logger(FleetPullRequestService.name);

    constructor(
        private readonly checkouts: FleetCheckoutService,
        private readonly rows: FleetCheckoutRepository,
        private readonly sessionRows: FleetSessionRepository,
        private readonly access: FleetAccessService,
        private readonly killSwitch: FleetKillSwitchService,
        private readonly enrichment: FleetPrEnrichmentService,
        private readonly git: GitFacadeService,
        private readonly moduleRef: ModuleRef,
        @Optional() private readonly actions?: FleetSessionActionService,
        @Optional() private readonly audit?: FleetAuditService,
        @Optional() private readonly agents?: AgentRepository,
        @Optional() private readonly runs?: AgentRunRepository,
    ) {}

    /** `POST /api/fleet/checkouts/:id/pull-request` and the Agent's `fleet_checkouts_open_pull_request`. */
    async open(
        checkoutId: string,
        caller: FleetPullRequestCaller,
        request: FleetOpenPullRequestRequest,
    ): Promise<FleetOpenPullRequestResponse> {
        const title = redactSecrets(typeof request?.title === 'string' ? request.title.trim() : '').cleaned;
        if (title.length === 0 || title.length > FLEET_PULL_REQUEST_TITLE_MAX_LENGTH) {
            throw fleetSessionError('invalid', `a title of 1–${FLEET_PULL_REQUEST_TITLE_MAX_LENGTH} characters`, {
                field: 'title',
            });
        }
        const rawBody = typeof request.body === 'string' ? request.body : '';
        if (rawBody.length > FLEET_PULL_REQUEST_BODY_MAX_LENGTH) {
            throw fleetSessionError('invalid', `a body of at most ${FLEET_PULL_REQUEST_BODY_MAX_LENGTH} characters`, {
                field: 'body',
            });
        }
        const body = redactSecrets(rawBody).cleaned;
        if (await this.isStopped()) {
            throw fleetSessionError('kill_switch', 'Paused by the fleet stop — no new pull request is opened');
        }
        const { row, nodeName } = await this.resolve(checkoutId, caller.userId);

        // The session asking: a run token's own (and only for its own checkout), else the one named, else the live one.
        let session: FleetSession | null = null;
        if (caller.run) {
            session = await this.sessionRows.findByAgentRunId(caller.run.runId);
            if (!session || session.checkoutId !== row.id) {
                throw fleetSessionError(
                    'permission_denied',
                    'an Agent session may only open the pull request of its own checkout',
                    { checkoutId: row.id },
                );
            }
        } else if (request.sessionId) {
            const named = await this.sessionRows.findById(request.sessionId);
            if (!named || named.checkoutId !== row.id) {
                throw fleetSessionError('invalid', 'that session does not work in this checkout', { field: 'sessionId' });
            }
            session = named;
        } else {
            session = (await this.sessionRows.findLiveForNode(row.nodeId)).find((live) => live.checkoutId === row.id) ?? null;
        }

        // FR-18, U11: an Agent opens pull requests only with its owner's permission.
        const agentId = caller.run?.agentId ?? caller.agentId ?? (caller.run ? session?.agentId : null) ?? null;
        if (caller.run && !agentId) {
            throw fleetSessionError('permission_denied', 'only an Agent session may open a pull request this way', {
                permission: 'canOpenPullRequests',
            });
        }
        let agentName: string | null = null;
        if (agentId) {
            const agent = this.agents ? await this.agents.findById(agentId).catch(() => null) : null;
            agentName = agent?.name ?? null;
            const permissions = (agent?.permissions ?? {}) as unknown as Record<string, unknown>;
            if (!agent || permissions.canOpenPullRequests !== true) {
                throw fleetSessionError(
                    'permission_denied',
                    `${agentName ?? 'This Agent'} may not open pull requests — ask its owner to allow "Open pull requests"`,
                    { permission: 'canOpenPullRequests' },
                );
            }
        }

        const line = parseFleetGitLine(row.gitLine ?? null);
        const branch = line?.branch ?? row.branch ?? null;
        const remote = parseFleetRemote(row.remoteUrl ?? null);
        if (!branch) throw fleetSessionError('invalid', 'the checkout is not on a branch', { rule: 'no-branch' });
        if (!remote || remote.host !== 'github.com') {
            throw fleetSessionError('unsupported_on_node', 'pull requests are opened for GitHub repositories', {
                rule: 'provider',
            });
        }
        const facts = await this.enrichment.enrich(row, { force: true });
        if (isFleetSessionOnDefaultBranch({ branch, baseRef: line?.baseRef ?? null, defaultBranch: facts.defaultBranch })) {
            throw fleetSessionError('invalid', `a pull request is not opened from ${branch}`, { rule: 'default-branch' });
        }
        const access = await this.enrichment.accessFor(row.userId, remote);
        const requestedBy = caller.run?.agentId ? `agent:${caller.run.agentId}` : `user:${caller.userId}`;

        let result: { number: number; url: string; state: 'open' | 'draft' | 'merged' | 'closed' };
        let updated = false;
        let taskId: string | null = null;
        const open = facts.pr && (facts.pr.state === 'open' || facts.pr.state === 'draft') ? facts.pr : null;
        try {
            if (open) {
                // FR-16: "Update the pull request #n" — its title and body, never a second one.
                const changed = await this.git.updatePullRequest(
                    remote.owner,
                    remote.repo,
                    open.number,
                    { title, ...(body ? { body } : {}) },
                    access,
                );
                result = { number: changed.number, url: changed.url, state: open.state };
                updated = true;
            } else {
                const task = await this.taskOf(session);
                const taskAgentId = agentId ?? session?.agentId ?? null;
                if (task && taskAgentId) {
                    // FR-19: the Task's own tail — records the pull request, moves the Task to In review.
                    taskId = task.id;
                    const workspace = getOptionalProvider<TaskWorkspaceService>(this.moduleRef, TaskWorkspaceService);
                    if (!workspace) throw new Error('Task finalize is not available in this deployment');
                    const outcome = await workspace.finalizeRemotePush({
                        task,
                        userId: caller.userId,
                        agentId: taskAgentId,
                        agentCanOpenPullRequests: true,
                        branch,
                        ...(session?.agentRunId ? { runId: session.agentRunId } : {}),
                    });
                    if (outcome.outcome !== 'pr-opened' || !outcome.prNumber || !outcome.prUrl) {
                        throw fleetSessionError(
                            outcome.outcome === 'blocked-by-guard' ? 'permission_denied' : 'operation_failed',
                            outcome.outcome === 'conflict'
                                ? `${branch} does not merge cleanly`
                                : outcome.outcome === 'no-changes'
                                  ? 'branch is not pushed yet'
                                  : `the pull request was not opened (${outcome.outcome})`,
                            { outcome: outcome.outcome, ...(outcome.conflictPaths ? { conflictPaths: outcome.conflictPaths } : {}) },
                        );
                    }
                    result = { number: outcome.prNumber, url: outcome.prUrl, state: 'open' };
                } else {
                    const base =
                        facts.defaultBranch ??
                        (fleetBranchWithoutRemote(line?.baseRef ?? null) !== branch
                            ? fleetBranchWithoutRemote(line?.baseRef ?? null)
                            : null) ??
                        'main';
                    const created = await this.git.createPullRequest(
                        {
                            owner: remote.owner,
                            repo: remote.repo,
                            title,
                            head: branch,
                            base,
                            ...(body ? { body } : {}),
                            ...(request.draft ? { draft: true } : {}),
                        },
                        access,
                    );
                    result = { number: created.number, url: created.url, state: request.draft ? 'draft' : 'open' };
                }
            }
        } catch (error) {
            const typed = readFleetSessionError(error);
            if (typed) throw error;
            const message = error instanceof Error ? error.message : String(error);
            // GitHub answers 422 for a head that is not on the remote (U10).
            if (/not\s+(a\s+)?valid|no commits between|head.*(does not exist|invalid)|field.*head/i.test(message)) {
                throw fleetSessionError('invalid', 'branch is not pushed yet', { rule: 'not-pushed' });
            }
            this.logger.warn(`Pull request for checkout ${row.id} on ${nodeName} failed: ${firstLine(message)}`);
            throw fleetSessionError('operation_failed', firstLine(message));
        }

        await this.checkouts.setPullRequest(row.id, branch, {
            number: result.number,
            state: result.state,
            checks: facts.pr?.number === result.number ? facts.pr.checks : null,
            url: result.url,
        });
        this.enrichment.invalidate(row.id);
        if (session && this.actions) await this.actions.creditPullRequest(session, result);
        await this.audit?.tryRecord({
            action: 'node.session.pull-request.open',
            actorUserId: caller.userId,
            ownerUserId: row.userId,
            nodeId: row.nodeId,
            details: {
                family: 'checkouts',
                target: session?.id ?? row.path,
                checkoutId: row.id,
                number: result.number,
                url: result.url,
                updated,
                requestedBy,
                confirmationClass: 'plain',
                outcome: updated ? 'updated' : 'opened',
                ...(taskId ? { taskId } : {}),
            },
        });
        return { number: result.number, url: result.url, state: result.state, updated, taskId };
    }

    /**
     * `GET /api/fleet/checkouts/:id/pull-request/draft` — what the owner's
     * pull-request dialog is prefilled with (spec §5.4): the branch, its base,
     * a title from the branch, and the open pull request when there is one.
     */
    async draft(checkoutId: string, userId: string): Promise<FleetPullRequestDraft> {
        await this.checkouts.get(checkoutId, { userId });
        const row = await this.rows.findById(checkoutId);
        if (!row) throw fleetSessionError('not_found', 'no such checkout');
        const line = parseFleetGitLine(row.gitLine ?? null);
        const branch = line?.branch ?? row.branch ?? null;
        const facts = await this.enrichment.enrich(row);
        const ownBase = fleetBranchWithoutRemote(line?.baseRef ?? null);
        return {
            checkoutId: row.id,
            branch,
            base: facts.baseRef ?? (ownBase && ownBase !== branch ? ownBase : null) ?? facts.defaultBranch,
            title: titleFromBranch(branch),
            body: '',
            pushed: line !== null && line.ahead !== null,
            existing: facts.pr,
        };
    }

    // ─── Internals ─────────────────────────────────────────────────────────

    private async resolve(checkoutId: string, userId: string): Promise<{ row: FleetCheckout; nodeName: string }> {
        const row = await this.rows.findById(checkoutId);
        if (!row) throw fleetSessionError('not_found', 'no such checkout');
        try {
            const { node } = await this.access.resolveForFamily(row.nodeId, userId, 'checkouts');
            return { row, nodeName: node.name };
        } catch (error) {
            const typed = readFleetSessionError(error);
            if (typed?.code === 'permission_denied') throw fleetSessionError(typed.code, typed.hint, typed.details);
            throw fleetSessionError('not_found', 'no such checkout');
        }
    }

    /** The Task an Agent session's Run works on, when it does. */
    private async taskOf(session: FleetSession | null) {
        if (!session?.agentRunId || !this.runs) return null;
        try {
            const run = await this.runs.findById(session.agentRunId);
            if (!run?.taskId) return null;
            const tasks = getOptionalProvider<TaskRepository>(this.moduleRef, TaskRepository);
            return (await tasks?.findById(run.taskId)) ?? null;
        } catch {
            return null;
        }
    }

    private async isStopped(): Promise<boolean> {
        try {
            return await this.killSwitch.isStopped();
        } catch {
            return true;
        }
    }
}
