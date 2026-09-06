import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import {
    INBOX_MAX_BODY_CHARS,
    INBOX_MAX_REPLY_CHARS,
    normalizeInboxOptions,
    type InboxItemDto,
    type InboxItemOption,
    type InboxItemSourceMeta,
    type InboxItemStatus,
} from '@ever-works/contracts';
import { InboxItemRepository } from '../database/repositories/inbox-item.repository';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { RunSteeringService } from '../agents/run-steering.service';
import { AgentApprovalsService } from '../agent-approvals/agent-approvals.service';
import { AgentEscalationService } from '../agents/agent-escalation.service';
import { NotificationService } from '../notifications/notification.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import type { InboxItem } from '../entities/inbox-item.entity';
import type {
    InboxEscalationRaisedInput,
    InboxNoticeInput,
    InboxProducer,
    InboxProposalPendingInput,
    InboxQuestionRaisedInput,
} from './inbox-producer.port';
import { toInboxItemDto, type InboxReplyOutcome, type InboxReplyRouted } from './inbox.types';

/** Input of the `askHuman` agent tool (already schema-validated shape-wise). */
export interface AskHumanInput {
    question: string;
    options?: unknown;
    context?: string | null;
}

/** Where an `askHuman` call came from — bound at tool-build time, never model-supplied. */
export interface AskHumanSource {
    agentId: string;
    agentRunId?: string | null;
}

export interface ListInboxOptions {
    status?: InboxItemStatus;
    /** Only items linked to this Task (the Task page's open-question lookup, slice Q). */
    taskId?: string;
    limit?: number;
    offset?: number;
}

/**
 * Self-build slice Q — the message a resumed FLEET run receives for an
 * Inbox reply. Exported because the wording is the contract with the
 * planner (`# OWNER ANSWER` renders the new run's `pendingInput`
 * verbatim) and with the model that reads it: the question is restated
 * because the node that executes the answer has no CLI session that
 * remembers asking it — the file the model wrote is gone, the process
 * is gone, and the run may land on another machine.
 */
export function composeFleetAnswerMessage(questionTitle: string, answer: string): string {
    return `Your question from the previous run: ${questionTitle}\n\nOwner's answer: ${answer}`;
}

/**
 * Inbox (operator message center) — the ONE place agent/work/system
 * messages for the human are written, listed and ANSWERED.
 *
 * Four producer entry points (`askHuman`, `escalationRaised` /
 * `proposalPending` / `questionRaised` via the {@link InboxProducer}
 * port, and `notice`) write additively ALONGSIDE the existing records —
 * the escalation / proposal / run rows stay the system of record for
 * their own lifecycle; the inbox row is the message about them.
 *
 * `reply` is the answer router:
 *
 *   question   → live run: steer (message injected between iterations);
 *                parked/ended run: resume (new run seeded with the
 *                reply). Either way `awaitingInput` clears.
 *                `fleet-run` (slice Q): always the resume branch — the
 *                reconciler parks the run terminal BEFORE filing the
 *                row — and the reply travels with the question folded
 *                in (`composeFleetAnswerMessage`), because the next
 *                fleet run has no session that remembers the question.
 *   approval   → proxy to `AgentApprovalsService.decide` by option id.
 *   escalation → `AgentEscalationService.resolve` with the reply as the
 *                note; a parked linked run is additionally resumed.
 *   notice     → just marked answered.
 *
 * Archiving or deleting an OPEN `fleet-run` question un-parks its run
 * (un-archiving re-parks it): a run parked on a fleet question has no
 * other exit — cancel refuses terminal rows and the sweeper never reaps
 * an awaiting row — so dismissing the question IS "drop this run".
 * Cloud (`agent-run`) items keep today's behaviour byte for byte.
 *
 * Everything is owner-scoped inside the repository (foreign = missing
 * = 404), and downstream routers are all `@Optional()` so unit tests
 * and partial runtimes degrade to "recorded but not routed" instead of
 * failing the reply.
 */
@Injectable()
export class InboxService implements InboxProducer {
    private readonly logger = new Logger(InboxService.name);

    constructor(
        private readonly items: InboxItemRepository,
        private readonly runs: AgentRunRepository,
        @Optional() private readonly steering?: RunSteeringService,
        @Optional() private readonly approvals?: AgentApprovalsService,
        @Optional() private readonly escalations?: AgentEscalationService,
        @Optional() private readonly notifications?: NotificationService,
        @Optional() private readonly activityLog?: ActivityLogService,
    ) {}

    // ── reads ─────────────────────────────────────────────────────

    async list(
        userId: string,
        options: ListInboxOptions = {},
    ): Promise<{ items: InboxItemDto[]; total: number; unreadCount: number }> {
        const [{ rows, total }, unreadCount] = await Promise.all([
            this.items.listForUser(userId, options),
            this.items.countUnreadForUser(userId),
        ]);
        return { items: rows.map(toInboxItemDto), total, unreadCount };
    }

    async unreadCount(userId: string): Promise<number> {
        return this.items.countUnreadForUser(userId);
    }

    async getForUser(id: string, userId: string): Promise<InboxItemDto | null> {
        const row = await this.items.findOwned(id, userId);
        return row ? toInboxItemDto(row) : null;
    }

    // ── read-state / archive ──────────────────────────────────────

    async setUnread(id: string, userId: string, unread: boolean): Promise<InboxItemDto> {
        const changed = await this.items.setUnread(id, userId, unread);
        if (!changed) throw new NotFoundException(`Inbox item ${id} not found.`);
        const row = await this.items.findOwned(id, userId);
        if (!row) throw new NotFoundException(`Inbox item ${id} not found.`);
        return toInboxItemDto(row);
    }

    async setArchived(id: string, userId: string, archived: boolean): Promise<InboxItemDto> {
        // Read BEFORE the write: the dismissal rule needs the state the
        // row is LEAVING (an open fleet question), and the store may
        // mutate the same instance.
        const before = await this.items.findOwned(id, userId);
        if (!before) throw new NotFoundException(`Inbox item ${id} not found.`);
        const dismissesParkedRun = isOpenFleetQuestion(before);
        const parkedRunId = before.agentRunId ?? null;

        const row = await this.items.setArchived(id, userId, archived);
        if (!row) throw new NotFoundException(`Inbox item ${id} not found.`);

        if (parkedRunId) {
            if (archived && dismissesParkedRun) {
                await this.setFleetRunParked(parkedRunId, false, `archive of item ${id}`);
            } else if (!archived && isOpenFleetQuestion(row)) {
                // Restored to `open` (it was never answered): the question
                // is live again, so the run waits for it again.
                await this.setFleetRunParked(parkedRunId, true, `unarchive of item ${id}`);
            }
        }
        return toInboxItemDto(row);
    }

    async delete(id: string, userId: string): Promise<void> {
        const row = await this.items.findOwned(id, userId);
        if (!row) throw new NotFoundException(`Inbox item ${id} not found.`);
        const dismissesParkedRun = isOpenFleetQuestion(row);
        const parkedRunId = row.agentRunId ?? null;

        const deleted = await this.items.deleteOwned(id, userId);
        if (!deleted) throw new NotFoundException(`Inbox item ${id} not found.`);

        if (dismissesParkedRun && parkedRunId) {
            await this.setFleetRunParked(parkedRunId, false, `delete of item ${id}`);
        }
    }

    // ── producers ─────────────────────────────────────────────────

    /**
     * The `askHuman` agent tool lands here: persist the question, PARK
     * the run (`agent_runs.awaitingInput = true` — the lifecycle signal
     * `RunSteeringService.isResumable` and the sweeper's reap-exemption
     * read), and notify. The reply resumes or steers the run.
     *
     * Parking writes the run row DIRECTLY rather than threading an
     * outcome through the tool loop: `finalize()` only ever SETS the
     * flag (`outcome.awaitingInput === true`), never clears it, and
     * `setAwaitingInput` is deliberately not status-guarded — so a flag
     * written mid-loop survives the run's own completion. This is the
     * parking path the executor actually supports for a domain tool
     * (the capture-callback channel is reserved for the built-in
     * `transitionTask`).
     */
    async askHuman(
        userId: string,
        input: AskHumanInput,
        source: AskHumanSource,
    ): Promise<{ item: InboxItemDto; parked: boolean }> {
        const question = (input.question ?? '').trim();
        if (!question) {
            throw new BadRequestException('askHuman: question must not be empty.');
        }
        const { row, parked } = await this.fileQuestion({
            userId,
            question,
            context: input.context ?? null,
            options: input.options,
            sourceType: 'agent-run',
            agentId: source.agentId,
            agentRunId: source.agentRunId ?? null,
        });
        return { item: toInboxItemDto(row), parked };
    }

    /**
     * {@link InboxProducer.questionRaised} — a FLEET run asked the owner
     * (self-build slice Q); idempotent per run.
     *
     * The fleet twin of `askHuman`: same filing routine, `sourceType`
     * `fleet-run`, the node / branch / Task provenance in `sourceMeta`.
     * Best-effort by the port contract — an empty question is logged
     * and dropped, never thrown — and the reconciler has ALREADY parked
     * the run terminal before calling this (see the port's ordering
     * note), so the parking write here is a harmless repeat that keeps
     * the two producers' behaviour identical.
     */
    async questionRaised(input: InboxQuestionRaisedInput): Promise<void> {
        const question = (input.question ?? '').trim();
        if (!question) {
            this.logger.warn(
                `questionRaised: run ${input.agentRunId} reported an empty question — nothing filed.`,
            );
            return;
        }
        // One parked run, one question: a replayed completion event or a
        // second node report for the same job must not stack a duplicate.
        if (await this.items.findOpenQuestionByRunId(input.agentRunId)) return;
        await this.fileQuestion({
            userId: input.userId,
            question,
            context: input.context ?? null,
            sourceType: 'fleet-run',
            agentId: input.agentId ?? null,
            agentRunId: input.agentRunId,
            sourceMeta: input.sourceMeta ?? null,
        });
    }

    /** {@link InboxProducer.escalationRaised} — idempotent per escalation. */
    async escalationRaised(input: InboxEscalationRaisedInput): Promise<void> {
        const existing = await this.items.findByEscalationId(input.escalationId);
        if (existing) return;
        const row = await this.items.create({
            userId: input.userId,
            kind: 'escalation',
            title: input.summary,
            body: input.decisionNeeded,
            sourceType: 'escalation',
            agentId: input.agentId ?? null,
            agentRunId: input.runId ?? null,
            taskId: input.taskId ?? null,
            workId: input.workId ?? null,
            escalationId: input.escalationId,
            organizationId: input.organizationId ?? null,
        });
        await this.notifyCreated(row);
        this.logCreated(row);
    }

    /** {@link InboxProducer.proposalPending} — idempotent per proposal. */
    async proposalPending(input: InboxProposalPendingInput): Promise<void> {
        const existing = await this.items.findByProposalId(input.proposalId);
        if (existing) return;
        const risks =
            input.riskFlags && input.riskFlags.length > 0
                ? `\n\nRisk flags: ${input.riskFlags.join(', ')}`
                : '';
        const row = await this.items.create({
            userId: input.userId,
            kind: 'approval',
            title: input.title,
            body: `An agent proposed the action "${input.title}" (${input.actionType}) and is waiting for your approval.${risks}`,
            // Neither branch is `recommended`: the guardrail layer already
            // auto-decided everything it had an opinion about, so a
            // proposal that reaches a human is one the platform will not
            // nudge either way.
            options: [
                { id: 'approve', label: 'Approve' },
                { id: 'reject', label: 'Reject' },
            ],
            sourceType: 'proposal',
            agentId: input.agentId ?? null,
            agentRunId: input.runId ?? null,
            proposalId: input.proposalId,
            organizationId: input.organizationId ?? null,
        });
        await this.notifyCreated(row);
        this.logCreated(row);
    }

    /** {@link InboxProducer.notice} — plain system notice. */
    async notice(userId: string, input: InboxNoticeInput): Promise<void> {
        const row = await this.items.create({
            userId,
            kind: 'notice',
            title: input.title,
            body: input.body,
            sourceType: 'system',
            agentId: input.agentId ?? null,
            agentRunId: input.agentRunId ?? null,
            taskId: input.taskId ?? null,
            workId: input.workId ?? null,
            organizationId: input.organizationId ?? null,
        });
        // `notify: false` = this event already reached the human through
        // another producer; file the row, skip the second bell.
        if (input.notify !== false) {
            await this.notifyCreated(row);
        }
        this.logCreated(row);
    }

    // ── reply routing ─────────────────────────────────────────────

    async reply(
        userId: string,
        id: string,
        answer: { text?: string | null; optionId?: string | null },
    ): Promise<InboxReplyOutcome> {
        const row = await this.items.findOwned(id, userId);
        if (!row) throw new NotFoundException(`Inbox item ${id} not found.`);
        if (row.status !== 'open') {
            throw new ConflictException(
                `Inbox item ${id} is already ${row.status} and cannot be answered again.`,
            );
        }

        const text = (answer.text ?? '').trim();
        if (text.length > INBOX_MAX_REPLY_CHARS) {
            throw new BadRequestException(
                `Reply exceeds the maximum of ${INBOX_MAX_REPLY_CHARS} characters.`,
            );
        }
        const options = Array.isArray(row.options) ? row.options : [];
        const option = answer.optionId
            ? (options.find((candidate) => candidate.id === answer.optionId) ?? null)
            : null;
        if (answer.optionId && !option) {
            throw new BadRequestException(
                `"${answer.optionId}" is not one of this item's options.`,
            );
        }
        if (!text && !option) {
            throw new BadRequestException('A reply needs text, an option, or both.');
        }

        // Shape rules that do not depend on any downstream, checked
        // BEFORE the claim so a malformed reply never has to be rolled
        // back: an approval answer must name approve or reject.
        if (row.kind === 'approval' && row.proposalId && this.approvals) {
            if (!option || (option.id !== 'approve' && option.id !== 'reject')) {
                throw new BadRequestException(
                    'An approval reply must pick the approve or reject option.',
                );
            }
        }

        // The message the downstream run/record receives: option label
        // first (the structured half), free text after it.
        const composed = option ? (text ? `${option.label} — ${text}` : option.label) : text;

        // CAS-claim FIRST — this is what makes a reply happen ONCE.
        // Routing is NOT idempotent: `RunSteeringService.resume` creates
        // and DISPATCHES a brand-new AgentRun on every call, so two
        // replies racing on the same open item (two tabs, a double
        // submit, a retried API client) would resume the same question
        // twice and pay for both runs. Claiming the row before routing
        // makes the second caller lose the CAS and route nothing.
        //
        // The claim is released again if routing throws, so a downstream
        // hiccup still leaves the human an answerable item — the reason
        // the original order routed first.
        const claimed = await this.items.markAnswered(id, userId, {
            text: text || null,
            optionId: option?.id ?? null,
        });
        if (!claimed) {
            const winner = await this.items.findOwned(id, userId);
            if (!winner) throw new NotFoundException(`Inbox item ${id} not found.`);
            return { item: toInboxItemDto(winner), routed: 'already-decided' };
        }

        let routed: InboxReplyRouted = 'none';
        let runId: string | undefined;
        try {
            switch (row.kind) {
                case 'question': {
                    const outcome = await this.routeQuestionReply(row, userId, composed);
                    routed = outcome.routed;
                    runId = outcome.runId;
                    break;
                }
                case 'approval': {
                    routed = await this.routeApprovalReply(row, userId, option);
                    break;
                }
                case 'escalation': {
                    routed = await this.routeEscalationReply(row, userId, composed);
                    if (routed === 'escalation-resolved') {
                        const resumed = await this.tryResumeLinkedRun(row, userId, composed);
                        if (resumed) runId = resumed;
                    }
                    break;
                }
                case 'notice':
                    routed = 'none';
                    break;
            }
        } catch (err) {
            await this.items.reopen(id, userId).catch((reopenErr) => {
                this.logger.warn(
                    `Inbox item ${id}: routing failed AND the claim could not be released: ${reopenErr}`,
                );
                return false;
            });
            throw err;
        }

        const fresh = await this.items.findOwned(id, userId);
        if (!fresh) throw new NotFoundException(`Inbox item ${id} not found.`);

        this.logAnswered(fresh, routed);
        return { item: toInboxItemDto(fresh), routed, runId };
    }

    // ── internals ─────────────────────────────────────────────────

    /**
     * The one filing routine behind `askHuman` (cloud, `agent-run`) and
     * `questionRaised` (fleet, `fleet-run`): persist the question, PARK
     * the run (`agent_runs.awaitingInput = true` — the lifecycle signal
     * `RunSteeringService.isResumable` and the sweeper's reap-exemption
     * read), and notify. The reply resumes or steers the run.
     *
     * The run row carries the task/work/org links — resolved HERE so
     * the model (cloud) or the node's result (fleet) never supplies
     * them: they route the reply, so a caller-supplied id would let a
     * prompt-injected agent point the human's answer at someone else's
     * run. A run that is not the asking user's is treated as absent —
     * the item is still filed, just without run links, and not parked.
     *
     * Parking writes the run row DIRECTLY rather than threading an
     * outcome through the tool loop: `finalize()` only ever SETS the
     * flag (`outcome.awaitingInput === true`), never clears it, and
     * `setAwaitingInput` is deliberately not status-guarded — so a flag
     * written mid-loop survives the run's own completion. This is the
     * parking path the executor actually supports for a domain tool
     * (the capture-callback channel is reserved for the built-in
     * `transitionTask`).
     */
    private async fileQuestion(args: {
        userId: string;
        /** Already trimmed and non-empty. */
        question: string;
        context?: string | null;
        options?: unknown;
        sourceType: 'agent-run' | 'fleet-run';
        agentId: string | null;
        agentRunId: string | null;
        sourceMeta?: InboxItemSourceMeta | null;
    }): Promise<{ row: InboxItem; parked: boolean }> {
        const { userId, question } = args;
        const run = args.agentRunId ? await this.runs.findById(args.agentRunId) : null;
        const ownedRun = run && run.userId === userId ? run : null;

        const title = firstLine(question);
        const body = args.context?.trim()
            ? `${question}\n\n${args.context.trim()}`.slice(0, INBOX_MAX_BODY_CHARS)
            : question;

        const row = await this.items.create({
            userId,
            kind: 'question',
            title,
            body,
            options: normalizeInboxOptions(args.options),
            sourceType: args.sourceType,
            agentId: args.agentId ?? ownedRun?.agentId ?? null,
            agentRunId: ownedRun?.id ?? null,
            taskId: ownedRun?.taskId ?? null,
            workId: ownedRun?.workId ?? null,
            organizationId: ownedRun?.organizationId ?? null,
            ...(args.sourceMeta !== undefined ? { sourceMeta: args.sourceMeta } : {}),
        });

        let parked = false;
        if (ownedRun) {
            try {
                await this.runs.setAwaitingInput(ownedRun.id, true);
                parked = true;
            } catch (err) {
                this.logger.warn(
                    `${args.sourceType === 'fleet-run' ? 'questionRaised' : 'askHuman'}: failed to park run ${ownedRun.id} (item ${row.id} still filed): ${err}`,
                );
            }
        }

        await this.notifyCreated(row);
        this.logCreated(row);
        return { row, parked };
    }

    /**
     * Dismissal of a parked FLEET run (self-build slice Q). A run parked
     * on a `fleet-run` question has no other exit: `AgentRunRepository.cancel`
     * refuses terminal rows and the sweeper never reaps an awaiting row.
     * Archiving or deleting the OPEN question is therefore the owner's
     * "drop this run" — the parked flag clears so the run leaves the
     * attention filter; un-archiving re-parks it. Best-effort: the
     * archive / delete already happened and must not be undone by a
     * run-row hiccup.
     */
    private async setFleetRunParked(
        runId: string,
        awaitingInput: boolean,
        why: string,
    ): Promise<void> {
        try {
            await this.runs.setAwaitingInput(runId, awaitingInput);
        } catch (err) {
            this.logger.warn(
                `Inbox: could not ${awaitingInput ? 're-park' : 'un-park'} fleet run ${runId} on ${why}: ${err}`,
            );
        }
    }

    /**
     * Question reply → the run. Live run: steer (injected between model
     * round-trips, clears `awaitingInput`). Parked / ended-but-resumable
     * run: resume (new run seeded with the reply; the source run's
     * `awaitingInput` clears inside `resume`). No run, no steering
     * service, or a heartbeat run with no Task: the answer is still
     * recorded on the item — nothing is lost, just not auto-routed.
     *
     * Self-build slice Q — a `fleet-run` question. The run has no CLI
     * session that remembers its own question (the file the model wrote
     * is gone and the next job may run on another machine), and the
     * planner renders the new run's `pendingInput` verbatim under
     * `# OWNER ANSWER`; so the outbound message carries the question
     * folded in (`composeFleetAnswerMessage`). Two invariants keep this
     * honest: (1) the reconciler files a fleet question only AFTER the
     * run is terminal + `awaitingInput`, so this branch is always the
     * resume path — a steer would append to `pendingInput` nobody on a
     * node reads; (2) a resume that throws (planner refusal for a
     * done / cancelled Task, no repository, runtime off) leaves the item
     * reopened by `reply`'s catch AND the run still parked, because
     * `RunSteeringService.resume` clears the flag only once the
     * successor is enqueued — the owner can answer again or archive.
     */
    private async routeQuestionReply(
        row: InboxItem,
        userId: string,
        message: string,
    ): Promise<{ routed: InboxReplyRouted; runId?: string }> {
        if (!row.agentRunId || !this.steering) {
            await this.clearAwaitingInput(row);
            return { routed: 'none' };
        }
        const run = await this.runs.findByIdAndUser(row.agentRunId, userId);
        if (!run) {
            return { routed: 'none' };
        }
        const outbound =
            row.sourceType === 'fleet-run'
                ? composeFleetAnswerMessage(row.title, message)
                : message;
        if (RunSteeringService.isLive(run)) {
            const outcome = await this.steering.steer({ runId: run.id, userId, message: outbound });
            if (outcome.dispatched === 'injected') {
                return { routed: 'steered', runId: run.id };
            }
            // Terminal race — fall through to the resume branch below.
        }
        if (RunSteeringService.isResumable(run) && run.taskId) {
            const outcome = await this.steering.resume(run.id, userId, outbound);
            return { routed: 'resumed', runId: outcome.runId };
        }
        // Not resumable (no Task, or ended for good). Clear the parked
        // flag so the Sessions attention filter stops pointing at a
        // question that has been answered.
        await this.clearAwaitingInput(row);
        return { routed: 'none' };
    }

    private async routeApprovalReply(
        row: InboxItem,
        userId: string,
        option: InboxItemOption | null,
    ): Promise<InboxReplyRouted> {
        if (!row.proposalId || !this.approvals) return 'none';
        if (!option || (option.id !== 'approve' && option.id !== 'reject')) {
            throw new BadRequestException(
                'An approval reply must pick the approve or reject option.',
            );
        }
        const decision = option.id === 'approve' ? 'approved' : 'rejected';
        try {
            await this.approvals.decide(userId, row.proposalId, decision);
            return decision;
        } catch (err) {
            if (err instanceof ConflictException) {
                // Decided elsewhere (queue UI, chat tool) — the item is
                // stale, not the human wrong. Record and move on.
                return 'already-decided';
            }
            throw err;
        }
    }

    private async routeEscalationReply(
        row: InboxItem,
        userId: string,
        note: string,
    ): Promise<InboxReplyRouted> {
        if (!row.escalationId || !this.escalations) return 'none';
        const resolved = await this.escalations.resolve(row.escalationId, userId, note || null);
        return resolved ? 'escalation-resolved' : 'already-decided';
    }

    /**
     * An escalation reply also resumes the linked run when it is parked
     * — the decision the run was waiting on has been made, and the note
     * is exactly the context the resumed run should start from.
     */
    private async tryResumeLinkedRun(
        row: InboxItem,
        userId: string,
        note: string,
    ): Promise<string | undefined> {
        if (!row.agentRunId || !this.steering) return undefined;
        try {
            const run = await this.runs.findByIdAndUser(row.agentRunId, userId);
            if (!run || RunSteeringService.isLive(run)) return undefined;
            if (!RunSteeringService.isResumable(run) || !run.taskId) return undefined;
            const outcome = await this.steering.resume(run.id, userId, note);
            return outcome.runId;
        } catch (err) {
            // Best-effort: the escalation IS resolved; a resume hiccup
            // must not undo that answer.
            this.logger.warn(
                `Inbox reply: resume of run ${row.agentRunId} after escalation resolve failed: ${err}`,
            );
            return undefined;
        }
    }

    private async clearAwaitingInput(row: InboxItem): Promise<void> {
        if (!row.agentRunId) return;
        await this.runs.setAwaitingInput(row.agentRunId, false).catch(() => undefined);
    }

    /** Bell row + channel fanout — best-effort, never fails the write. */
    private async notifyCreated(row: InboxItem): Promise<void> {
        if (!this.notifications) return;
        try {
            await this.notifications.notifyInboxItem({
                userId: row.userId,
                itemId: row.id,
                kind: row.kind,
                title: row.title,
                message: row.body,
            });
        } catch (err) {
            this.logger.warn(`Inbox item ${row.id}: notification fanout failed: ${err}`);
        }
    }

    private logCreated(row: InboxItem): void {
        void this.tryLogActivity(row.userId, ActivityActionType.INBOX_ITEM_CREATED, row, {});
    }

    private logAnswered(row: InboxItem, routed: InboxReplyRouted): void {
        void this.tryLogActivity(row.userId, ActivityActionType.INBOX_ITEM_ANSWERED, row, {
            routed,
        });
    }

    private async tryLogActivity(
        userId: string,
        actionType: ActivityActionType,
        row: InboxItem,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId,
                action: actionType,
                actionType,
                status: ActivityStatus.COMPLETED,
                summary: `Inbox ${row.kind}: ${row.title}`.slice(0, 500),
                details: {
                    ...details,
                    inboxItemId: row.id,
                    kind: row.kind,
                    agentRunId: row.agentRunId ?? null,
                    taskId: row.taskId ?? null,
                },
            });
        } catch (err) {
            this.logger.warn(`Inbox item ${row.id}: activity log failed: ${err}`);
        }
    }
}

/** First non-empty line, capped to the title column. */
function firstLine(text: string): string {
    const line = text.split('\n').find((candidate) => candidate.trim().length > 0) ?? text;
    return line.trim().slice(0, 300);
}

/** An unanswered question a FLEET run is parked on (slice Q dismissal rule). */
function isOpenFleetQuestion(row: InboxItem): boolean {
    return row.kind === 'question' && row.status === 'open' && row.sourceType === 'fleet-run';
}
