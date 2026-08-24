import { Injectable, Logger, BadRequestException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationRepository } from '@src/database/repositories/notification.repository';
import { Notification } from '@src/entities/notification.entity';
import {
    CreateNotificationDto,
    NotificationQueryOptions,
    NotificationType,
    NotificationCategory,
} from '@src/entities/notification.types';
import { sanitizeName, sanitizeDescription } from '@src/utils/sanitize.util';
import { redactSecrets } from '@src/utils/secret-scan';

/**
 * Notifications v2 (EW-664 / EW-678) — payload emitted on
 * `notifications-v2.fanout-requested` after every in-app producer
 * call. The api layer's `NotificationFanoutListener` consumes this and
 * delegates to `NotificationChannelFacadeService` for the multi-channel
 * fanout. Keeping the listener in the api layer avoids pulling the
 * channel-facade + subscription-resolver deps into the agent package.
 */
export interface NotificationFanoutEvent {
    readonly userId: string;
    readonly eventKey: string;
    readonly title: string;
    readonly message: string;
    readonly actionUrl?: string;
    readonly actionLabel?: string;
    readonly urgent: boolean;
}

export const NOTIFICATION_FANOUT_EVENT = 'notifications-v2.fanout-requested';

@Injectable()
export class NotificationService {
    private readonly logger = new Logger(NotificationService.name);

    constructor(
        private readonly repository: NotificationRepository,
        @Optional() private readonly eventEmitter?: EventEmitter2,
    ) {}

    /**
     * Emit the multi-channel fanout event. No-op when EventEmitter2 isn't
     * wired (e.g. in v1 unit tests that don't import EventEmitterModule).
     * Producer methods invoke this AFTER successfully writing the in-app
     * row so a fanout failure can never block the v1 path.
     */
    private async dispatchFanout(payload: NotificationFanoutEvent): Promise<void> {
        if (!this.eventEmitter) return;
        try {
            this.eventEmitter.emit(NOTIFICATION_FANOUT_EVENT, payload);
        } catch (err) {
            this.logger.warn(
                `Notifications v2 fanout emission failed for user=${payload.userId} event=${payload.eventKey}: ${String(err)}`,
            );
        }
    }

    /**
     * Security: strip HTML angle brackets from user-supplied label strings before
     * embedding them into notification message text. This is a defence-in-depth
     * measure; the primary XSS guard lives in the frontend renderer. Uses the
     * shared sanitizeName helper (100-char cap, removes control chars/newlines)
     * and additionally removes < and > to neutralise any residual HTML payloads.
     */
    private sanitizeLabel(value: string): string {
        return sanitizeName(value).replace(/[<>]/g, '');
    }

    /**
     * Security: cap error-message strings at 500 characters before storing
     * them in notifications. AI provider SDKs can embed endpoint URLs, request
     * IDs, or stack traces in error messages; truncating limits accidental
     * information leakage while still giving users actionable context.
     * Credential-shaped tokens (API keys, JWTs, PEM blocks, …) are redacted
     * BEFORE the length cap so a leaked secret can neither survive intact nor
     * be split by truncation into a partially-leaked prefix.
     */
    private sanitizeErrorMessage(value: string): string {
        return sanitizeDescription(redactSecrets(value).cleaned, 500);
    }

    /**
     * Create a new notification for a user.
     *
     * Deduplication contract (when `dto.deduplicationKey` is set):
     * - Looks up an existing notification by `(userId, deduplicationKey)`.
     *   If one exists AND is **not dismissed**, returns it untouched —
     *   the new dto is silently discarded. (So "dismiss" deliberately
     *   re-arms the dedup slot: a user who dismissed an alert can see a
     *   fresh one for the same condition.)
     * - Race-condition guard: if two requests slip past the lookup at
     *   the same time, the second `INSERT` hits a UNIQUE constraint on
     *   `(userId, deduplicationKey)` and we re-fetch + return the
     *   first writer's row. Detected per-engine via
     *   {@link isUniqueConstraintError} (PG `23505`, MySQL
     *   `ER_DUP_ENTRY`, SQLite `SQLITE_CONSTRAINT`). **This contract
     *   relies on the DB constraint existing** — if a migration ever
     *   drops it, concurrent creates will silently duplicate.
     *
     * Without a `deduplicationKey`, every call writes a new row.
     */
    async create(dto: CreateNotificationDto): Promise<Notification> {
        // Check deduplication - if a notification with this key already exists and isn't dismissed, return it
        if (dto.deduplicationKey) {
            const existing = await this.repository.findByDeduplicationKey(
                dto.userId,
                dto.deduplicationKey,
            );
            if (existing && !existing.isDismissed) {
                this.logger.debug(
                    `Notification with deduplication key ${dto.deduplicationKey} already exists`,
                );
                return existing;
            }
        }

        try {
            const notification = await this.repository.create(dto);

            this.logger.log(
                `Created notification ${notification.id} for user ${dto.userId}: ${dto.title}`,
            );

            return notification;
        } catch (error) {
            // Handle race condition: another request created the notification between our check and insert
            if (dto.deduplicationKey && this.isUniqueConstraintError(error)) {
                this.logger.debug(
                    `Race condition detected for deduplication key ${dto.deduplicationKey}, fetching existing`,
                );
                const existing = await this.repository.findByDeduplicationKey(
                    dto.userId,
                    dto.deduplicationKey,
                );
                if (existing) {
                    return existing;
                }
            }
            throw error;
        }
    }

    /**
     * Check if error is a unique constraint violation
     */
    private isUniqueConstraintError(error: unknown): boolean {
        if (error && typeof error === 'object' && 'code' in error) {
            const code = (error as { code: string }).code;
            // PostgreSQL: 23505, MySQL: ER_DUP_ENTRY (1062), SQLite: SQLITE_CONSTRAINT (19)
            return code === '23505' || code === 'ER_DUP_ENTRY' || code === 'SQLITE_CONSTRAINT';
        }
        return false;
    }

    /**
     * Get notifications for a user with optional filtering
     */
    async getNotifications(
        userId: string,
        options?: NotificationQueryOptions,
    ): Promise<Notification[]> {
        return await this.repository.findByUserId(userId, options);
    }

    /**
     * Get unread notification count for a user
     */
    async getUnreadCount(userId: string): Promise<number> {
        return await this.repository.getUnreadCount(userId);
    }

    /**
     * Mark a notification as read
     */
    async markAsRead(userId: string, notificationId: string): Promise<void> {
        const notification = await this.repository.findByIdAndUserId(notificationId, userId);
        if (!notification) {
            throw new BadRequestException('Notification not found');
        }

        await this.repository.markAsRead(notificationId);
        this.logger.debug(`Marked notification ${notificationId} as read`);
    }

    /**
     * Mark all notifications as read for a user
     */
    async markAllAsRead(userId: string): Promise<void> {
        await this.repository.markAllAsRead(userId);
        this.logger.debug(`Marked all notifications as read for user ${userId}`);
    }

    /**
     * Dismiss a notification (hides it from view)
     * Persistent notifications cannot be dismissed
     */
    async dismiss(userId: string, notificationId: string): Promise<void> {
        const notification = await this.repository.findByIdAndUserId(notificationId, userId);
        if (!notification) {
            throw new BadRequestException('Notification not found');
        }

        if (notification.isPersistent) {
            throw new BadRequestException(
                'Persistent notifications cannot be dismissed. Please resolve the underlying issue first.',
            );
        }

        await this.repository.dismiss(notificationId);
        this.logger.debug(`Dismissed notification ${notificationId}`);
    }

    /**
     * Get persistent (critical) notifications for a user
     * These are shown prominently in the UI (e.g., global banner)
     */
    async getPersistentNotifications(userId: string): Promise<Notification[]> {
        return await this.repository.getPersistentNotifications(userId);
    }

    /**
     * Clear a notification by its deduplication key
     * Useful when the underlying issue is resolved
     */
    async clearByDeduplicationKey(userId: string, deduplicationKey: string): Promise<void> {
        await this.repository.clearDeduplicationKey(userId, deduplicationKey);
        this.logger.debug(
            `Cleared notification with deduplication key ${deduplicationKey} for user ${userId}`,
        );
    }

    async notifyAiCreditsDepleted(
        userId: string,
        provider: string,
        errorMessage?: string,
    ): Promise<void> {
        await this.create({
            userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.AI_CREDITS,
            title: 'AI Credits Depleted',
            message:
                errorMessage ||
                `Your ${provider} credits have been exhausted. Please add more credits to continue.`,
            actionUrl: '/settings',
            actionLabel: 'Add Credits',
            isPersistent: true,
            deduplicationKey: `ai_credits_depleted_${provider.toLowerCase()}`,
        });
        await this.dispatchFanout({
            userId,
            eventKey: 'ai_credits_depleted',
            title: 'AI Credits Depleted',
            message:
                errorMessage ||
                `Your ${provider} credits have been exhausted. Please add more credits to continue.`,
            actionUrl: '/settings',
            actionLabel: 'Add Credits',
            urgent: true,
        });
    }

    /**
     * Pricing Wave 9 M2 — platform credits balance could not cover a
     * run's metered spend. Emitted by the run-cost settlement when a
     * CONSUMPTION debit comes back insufficient (a zero-or-partial debit
     * was recorded per the billing PRD policy; the run itself is never
     * failed). Category reuses AI_CREDITS — the nearest existing
     * billing-shaped category (no BILLING category exists yet).
     */
    async notifyCreditsBalanceExhausted(args: {
        userId: string;
        runId: string;
        requiredCredits: number;
        balanceCredits: number;
    }): Promise<void> {
        const balance = Math.max(0, Math.trunc(args.balanceCredits));
        const message =
            `A run's metered usage needed ${Math.trunc(args.requiredCredits)} credits but your ` +
            `balance is ${balance}. The run finished normally; the uncovered remainder was not ` +
            `debited. Top up credits to keep usage billing normally.`;
        await this.create({
            userId: args.userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.AI_CREDITS,
            title: 'Credits Balance Exhausted',
            message,
            actionUrl: '/settings',
            actionLabel: 'Top Up Credits',
            isPersistent: true,
            metadata: {
                runId: args.runId,
                requiredCredits: Math.trunc(args.requiredCredits),
                balanceCredits: balance,
            },
            deduplicationKey: 'credits_balance_exhausted',
        });
        await this.dispatchFanout({
            userId: args.userId,
            eventKey: 'credits_balance_exhausted',
            title: 'Credits Balance Exhausted',
            message,
            actionUrl: '/settings',
            actionLabel: 'Top Up Credits',
            urgent: true,
        });
    }

    /**
     * Billing spec FR-20 — pay-as-you-go usage reached 80% / 100% of the
     * owner's monthly cap. At 100% new runs are parked until the cap is
     * raised, a pack is bought, or the cycle rolls. One notification per
     * threshold per cycle (the caller latches on the billing profile).
     */
    async notifyPaygCapThreshold(args: {
        userId: string;
        percent: 80 | 100;
        usedCredits: number;
        capCredits: number;
        periodEnd: Date | null;
    }): Promise<void> {
        const used = Math.max(0, Math.trunc(args.usedCredits));
        const cap = Math.max(0, Math.trunc(args.capCredits));
        const resets = args.periodEnd
            ? ` The cycle resets on ${args.periodEnd.toISOString().slice(0, 10)}.`
            : '';
        const reached = args.percent >= 100;
        const cycleKey = args.periodEnd?.toISOString().slice(0, 10) ?? 'unknown-period';
        const title = reached ? 'Pay-as-you-go cap reached' : 'Pay-as-you-go at 80% of cap';
        const message = reached
            ? `Your pay-as-you-go usage reached your monthly cap (${used} of ${cap} credits). New runs ` +
              `that need credits are paused until you raise the cap, buy a credit pack, or the cycle ` +
              `resets.${resets}`
            : `Your pay-as-you-go usage is at ${used} of ${cap} credits this cycle (80%). Raise the cap ` +
              `in Billing if you want to keep going past it.${resets}`;
        await this.create({
            userId: args.userId,
            type: reached ? NotificationType.WARNING : NotificationType.INFO,
            category: NotificationCategory.AI_CREDITS,
            title,
            message,
            actionUrl: '/settings/billing',
            actionLabel: 'Manage pay-as-you-go',
            isPersistent: reached,
            metadata: { percent: args.percent, usedCredits: used, capCredits: cap },
            deduplicationKey: `payg_cap_${args.percent}_${cycleKey}`,
        });
        await this.dispatchFanout({
            userId: args.userId,
            eventKey: `payg_cap_${args.percent}`,
            title,
            message,
            actionUrl: '/settings/billing',
            actionLabel: 'Manage pay-as-you-go',
            urgent: reached,
        });
    }

    /**
     * Billing spec FR-21 — a pay-as-you-go invoice could not be collected.
     * Overflow is suspended until it is paid (the portal link recovers it).
     */
    async notifyPaygPastDue(args: { userId: string; amountCents: number | null }): Promise<void> {
        const amount =
            typeof args.amountCents === 'number'
                ? ` ($${(args.amountCents / 100).toFixed(2)})`
                : '';
        const message =
            `We could not collect your latest pay-as-you-go invoice${amount}. Pay-as-you-go is paused ` +
            `until it is settled; prepaid credits keep working. Update your card or retry the payment ` +
            `from Billing.`;
        await this.create({
            userId: args.userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.AI_CREDITS,
            title: 'Pay-as-you-go payment failed',
            message,
            actionUrl: '/settings/billing',
            actionLabel: 'Fix payment',
            isPersistent: true,
            metadata: { amountCents: args.amountCents },
            deduplicationKey: 'payg_past_due',
        });
        await this.dispatchFanout({
            userId: args.userId,
            eventKey: 'payg_past_due',
            title: 'Pay-as-you-go payment failed',
            message,
            actionUrl: '/settings/billing',
            actionLabel: 'Fix payment',
            urgent: true,
        });
    }

    async notifyAiProviderError(
        userId: string,
        provider: string,
        errorMessage: string,
    ): Promise<void> {
        // Security: cap error message to 500 chars to prevent AI provider SDK
        // details (URLs, request IDs, stack traces) from leaking into stored notifications.
        const safeError = this.sanitizeErrorMessage(errorMessage);
        await this.create({
            userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.AI_CREDITS,
            title: 'AI Provider Error',
            message: `Error with ${provider}: ${safeError}`,
            actionUrl: '/settings',
            actionLabel: 'Check Settings',
            deduplicationKey: `ai_provider_error_${provider.toLowerCase()}`,
        });
        await this.dispatchFanout({
            userId,
            eventKey: 'ai_provider_error',
            title: 'AI Provider Error',
            message: `Error with ${provider}: ${safeError}`,
            actionUrl: '/settings',
            actionLabel: 'Check Settings',
            urgent: false,
        });
    }

    async notifyGenerationAccountError(
        userId: string,
        workId: string,
        workName: string,
        errorMessage: string,
    ): Promise<void> {
        // Security: strip HTML from user-supplied work name (defence-in-depth vs XSS)
        // and cap error message to prevent internal detail leakage.
        const safeName = this.sanitizeLabel(workName);
        const safeError = this.sanitizeErrorMessage(errorMessage);
        await this.create({
            userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.GENERATION,
            title: 'Generation Failed',
            message: `Generation for "${safeName}" failed: ${safeError}`,
            actionUrl: `/works/${workId}`,
            actionLabel: 'View Work',
            metadata: { workId, workName },
            deduplicationKey: `generation_error_${workId}`,
        });
        await this.dispatchFanout({
            userId,
            eventKey: 'generation_error',
            title: 'Generation Failed',
            message: `Generation for "${safeName}" failed: ${safeError}`,
            actionUrl: `/works/${workId}`,
            actionLabel: 'View Work',
            urgent: false,
        });
    }

    async notifySchedulePaused(
        userId: string,
        workId: string,
        workName: string,
        reason: string,
    ): Promise<void> {
        // Security: strip HTML from user-supplied work name (defence-in-depth vs XSS).
        const safeName = this.sanitizeLabel(workName);
        await this.create({
            userId,
            type: NotificationType.WARNING,
            category: NotificationCategory.GENERATION,
            title: 'Schedule Paused',
            message: `Scheduled updates for "${safeName}" paused: ${reason}`,
            actionUrl: `/works/${workId}/generator/schedule`,
            actionLabel: 'View Schedule',
            metadata: { workId, workName },
            deduplicationKey: `schedule_paused_${workId}`,
        });
        await this.dispatchFanout({
            userId,
            eventKey: 'schedule_paused',
            title: 'Schedule Paused',
            message: `Scheduled updates for "${safeName}" paused: ${reason}`,
            actionUrl: `/works/${workId}/generator/schedule`,
            actionLabel: 'View Schedule',
            urgent: false,
        });
    }

    async notifyBudgetThresholdCrossed(args: {
        userId: string;
        workId: string;
        budgetId: string;
        threshold: '75' | '90' | '100' | 'overage';
        scope: 'global' | 'plugin';
        pluginId?: string | null;
        currentSpendCents: number;
        capCents: number;
        currency: string;
    }): Promise<void> {
        const isError = args.threshold === '100' || args.threshold === 'overage';
        // Security: strip HTML from pluginId (defence-in-depth vs XSS in notification messages).
        const scopeLabel =
            args.scope === 'plugin' && args.pluginId
                ? `plugin '${this.sanitizeLabel(args.pluginId)}'`
                : 'this directory';
        const titleByThreshold: Record<typeof args.threshold, string> = {
            '75': 'Budget at 75%',
            '90': 'Budget at 90%',
            '100': 'Budget cap reached',
            overage: 'Budget overage in progress',
        };
        await this.create({
            userId: args.userId,
            type: isError ? NotificationType.ERROR : NotificationType.WARNING,
            category: NotificationCategory.AI_CREDITS,
            title: titleByThreshold[args.threshold],
            message: `${scopeLabel} has used ${args.currentSpendCents} / ${args.capCents} ${args.currency.toUpperCase()} cents this period.`,
            // EW-602 review fix (Codex P2 + Greptile P1): per-Work page,
            // not the per-User /settings namespace.
            actionUrl: `/works/${args.workId}/settings/budgets-usage`,
            actionLabel: 'Manage budgets',
            isPersistent: isError,
            metadata: {
                workId: args.workId,
                budgetId: args.budgetId,
                threshold: args.threshold,
                scope: args.scope,
                pluginId: args.pluginId,
            },
            deduplicationKey: `budget_${args.budgetId}_${args.threshold}`,
        });
    }

    /**
     * State-aware sweeper (Wave 4 M6) — a run has been queued past the
     * configured bound and nobody knows.
     *
     * This is the plan's `agent_run.queued_too_long` attention event. It
     * is a WARNING, not an error: nothing was reaped, the run is still
     * queued, and the notification exists so a capacity problem is seen
     * instead of inferred from a board that stopped moving.
     *
     * Deduplicated per RUN, not per user: two stuck runs are two separate
     * facts. The sweeper additionally CAS-guards its flag write, so this
     * producer is reached at most once per run even across replicas.
     */
    async notifyAgentRunQueuedTooLong(args: {
        userId: string;
        runId: string;
        taskId?: string | null;
        waitedMinutes: number;
        queuedReason?: string | null;
    }): Promise<void> {
        // `queuedReason` is a machine token written by the platform, but
        // it is rendered inside the message, so it goes through the same
        // label sanitizer as every other interpolated value.
        const reasonSuffix = args.queuedReason
            ? ` (waiting on: ${this.sanitizeLabel(args.queuedReason)})`
            : '';
        const message =
            `An agent run has been queued for ${args.waitedMinutes} minutes without ` +
            `starting${reasonSuffix}. It has NOT been cancelled.`;
        const actionUrl = '/agents/sessions?attention=1';
        await this.create({
            userId: args.userId,
            type: NotificationType.WARNING,
            category: NotificationCategory.AGENT,
            title: 'Agent run queued too long',
            message,
            actionUrl,
            actionLabel: 'View sessions',
            metadata: {
                runId: args.runId,
                taskId: args.taskId ?? null,
                waitedMinutes: args.waitedMinutes,
                queuedReason: args.queuedReason ?? null,
            },
            deduplicationKey: `agent_run_queued_too_long_${args.runId}`,
        });
        await this.dispatchFanout({
            userId: args.userId,
            eventKey: 'agent_run_queued_too_long',
            title: 'Agent run queued too long',
            message,
            actionUrl,
            actionLabel: 'View sessions',
            urgent: false,
        });
    }

    /**
     * Judgment layer G3 — an agent gave up and a human has to decide.
     *
     * One notification per escalation record (the escalation store is
     * itself idempotent per `dedupKey`, and this dedup key mirrors it), so
     * a retried worker cannot spam the owner.
     */
    async notifyAgentEscalation(args: {
        userId: string;
        escalationId: string;
        reasonCode: string;
        summary: string;
        taskId?: string | null;
    }): Promise<void> {
        const safeSummary = sanitizeDescription(args.summary, 300);
        const actionUrl = args.taskId ? `/tasks/${args.taskId}` : '/agents/sessions?attention=1';
        await this.create({
            userId: args.userId,
            type: NotificationType.WARNING,
            category: NotificationCategory.AGENT,
            title: 'Agent needs a decision',
            message: safeSummary,
            actionUrl,
            actionLabel: 'Review',
            isPersistent: true,
            metadata: {
                escalationId: args.escalationId,
                reasonCode: args.reasonCode,
                taskId: args.taskId ?? null,
            },
            deduplicationKey: `agent_escalation_${args.escalationId}`,
        });
        await this.dispatchFanout({
            userId: args.userId,
            eventKey: 'agent_run_escalated',
            title: 'Agent needs a decision',
            message: safeSummary,
            actionUrl,
            actionLabel: 'Review',
            urgent: false,
        });
    }

    /**
     * Fleet local-runner fallback — a run that PREFERRED the owner's own
     * machine was handed to the platform runtime instead.
     *
     * Why this is a notification and not just a log line: the whole point
     * of choosing a local runner is that WHERE a run executes is
     * load-bearing (the checkout, the credentials, the GPU live there).
     * A silent relocation is therefore not a graceful degradation, it is
     * a changed outcome the owner has to be able to see — and the reason
     * ("your laptop was busy" vs "you have no runner enrolled") is what
     * tells them whether to wait, enrol another machine, or switch the
     * Work to `local-wait`.
     *
     * Dedup key is per (task, reason), so a Task retried in a loop while
     * a laptop is closed produces one notification rather than one per
     * attempt — but a DIFFERENT reason still gets through, because
     * "busy" becoming "offline" is news.
     */
    async notifyFleetRunnerFallback(args: {
        userId: string;
        taskId?: string | null;
        /** Machine token: `no-runners` | `runners-offline` | `runners-busy`. */
        reason: string;
        /** Enrolled runners at decision time (0 when none). */
        runnerCount: number;
    }): Promise<void> {
        const safeReason = this.sanitizeLabel(args.reason);
        const detail =
            args.reason === 'no-runners'
                ? 'no local runner is enrolled'
                : args.reason === 'runners-offline'
                  ? 'your local runner is offline'
                  : 'your local runner was busy';
        const title = 'Local runner fallback → cloud';
        const message =
            `A run that preferred your local runner ran in the cloud instead because ${detail}. ` +
            'Set the Work to "Local runner (wait for a free slot)" if it must run on your machine.';
        const actionUrl = '/settings/fleet';
        await this.create({
            userId: args.userId,
            type: NotificationType.INFO,
            category: NotificationCategory.AGENT,
            title,
            message,
            actionUrl,
            actionLabel: 'View fleet',
            metadata: {
                taskId: args.taskId ?? null,
                reason: safeReason,
                runnerCount: args.runnerCount,
            },
            deduplicationKey: `fleet_runner_fallback_${args.taskId ?? 'unknown'}_${safeReason}`,
        });
        await this.dispatchFanout({
            userId: args.userId,
            eventKey: 'fleet_runner_fallback',
            title,
            message,
            actionUrl,
            actionLabel: 'View fleet',
            urgent: false,
        });
    }

    async notifyGitAuthExpired(userId: string, provider: string): Promise<void> {
        await this.create({
            userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.SECURITY,
            title: 'Git Authentication Expired',
            message: `Your ${provider} authentication has expired. Please reconnect.`,
            actionUrl: '/settings/oauth',
            actionLabel: 'Reconnect',
            isPersistent: true,
            deduplicationKey: `git_auth_expired_${provider.toLowerCase()}`,
        });
        await this.dispatchFanout({
            userId,
            eventKey: 'git_auth_expired',
            title: 'Git Authentication Expired',
            message: `Your ${provider} authentication has expired. Please reconnect.`,
            actionUrl: '/settings/oauth',
            actionLabel: 'Reconnect',
            urgent: true,
        });
    }

    /**
     * Digest briefings (Wave 7) — in-app digest row + notifications-v2
     * channel fanout. `message` is the deterministic one-line summary
     * (capped like every other producer); the full markdown body rides
     * in `metadata.markdown` for richer renderers. Dedup key is
     * per-user+period+window-day so a re-run of the same cron window
     * updates nothing instead of stacking duplicates.
     */
    async notifyDigest(args: {
        userId: string;
        period: 'daily' | 'weekly';
        title: string;
        message: string;
        markdown?: string;
        deduplicationKey?: string;
    }): Promise<void> {
        const safeMessage = sanitizeDescription(args.message, 500);
        const metadata: Record<string, any> = { period: args.period };
        if (args.markdown) {
            // Defensive cap — markdown is composed from repository rows
            // (titles/summaries are user content) and stored as simple-json.
            metadata.markdown =
                args.markdown.length > 8000 ? args.markdown.slice(0, 8000) : args.markdown;
        }
        await this.create({
            userId: args.userId,
            type: NotificationType.INFO,
            category: NotificationCategory.DIGEST,
            title: args.title,
            message: safeMessage,
            actionUrl: '/activity',
            actionLabel: 'View activity',
            metadata,
            deduplicationKey: args.deduplicationKey ?? `digest_${args.period}`,
        });
        await this.dispatchFanout({
            userId: args.userId,
            eventKey: 'digest_ready',
            title: args.title,
            message: safeMessage,
            actionUrl: '/activity',
            actionLabel: 'View activity',
            urgent: false,
        });
    }

    /**
     * Memory consolidation cadence (memory upgrades M9) — in-app row +
     * notifications-v2 channel fanout announcing that a scheduled
     * consolidation pass produced something to review.
     *
     * Deliberately reuses the generic producer path (no new category, no
     * new transport): the message is the deterministic
     * "N promoted / M synthesized / K superseded" line and the action
     * link lands on the Memory page where Apply / the review queue live.
     * Dedup key is per-org+day, so a re-run of the same cron window
     * updates nothing instead of stacking duplicates.
     */
    async notifyMemoryConsolidation(args: {
        userId: string;
        organizationId: string;
        title: string;
        message: string;
        /** `dry-run` (preview only) or `propose` (documents landed for review). */
        mode: 'dry-run' | 'propose';
        metadata?: Record<string, unknown>;
        deduplicationKey?: string;
    }): Promise<void> {
        const safeMessage = sanitizeDescription(args.message, 500);
        const actionUrl = '/memory';
        await this.create({
            userId: args.userId,
            type: NotificationType.INFO,
            category: NotificationCategory.SYSTEM,
            title: this.sanitizeLabel(args.title),
            message: safeMessage,
            actionUrl,
            actionLabel: 'Review memory',
            metadata: {
                organizationId: args.organizationId,
                mode: args.mode,
                ...(args.metadata ?? {}),
            },
            deduplicationKey:
                args.deduplicationKey ?? `memory_consolidation_${args.organizationId}`,
        });
        await this.dispatchFanout({
            userId: args.userId,
            eventKey: 'memory_consolidation_ready',
            title: args.title,
            message: safeMessage,
            actionUrl,
            actionLabel: 'Review memory',
            urgent: false,
        });
    }

    /**
     * Inbox (operator message center) — bell row + channel fanout for a
     * freshly-created inbox item, so the message reaches the human on
     * every channel they enabled (quiet hours / mutes are applied by the
     * fanout listener downstream, like every other producer here).
     *
     * One notification per item (`inbox_item_<id>` dedup key), so a
     * retried producer cannot ring twice. `question` items are urgent by
     * definition: a run is parked until the reply.
     *
     * The action URL carries `?id=` — the inbox page reads it and opens
     * THAT message. A bare `/inbox` link opens whatever happens to be
     * newest, so on a busy inbox the notification about item A lands the
     * human on item B; the deep-link plumbing exists on the page for
     * exactly this producer.
     */
    async notifyInboxItem(args: {
        userId: string;
        itemId: string;
        kind: 'question' | 'approval' | 'escalation' | 'notice';
        title: string;
        message: string;
    }): Promise<void> {
        const eventKeyByKind: Record<typeof args.kind, string> = {
            question: 'inbox_question',
            approval: 'inbox_approval_requested',
            escalation: 'inbox_escalation',
            notice: 'inbox_notice',
        };
        const urgent = args.kind === 'question';
        // Title/body originate from agents and system producers, but an
        // askHuman question is MODEL-authored — same sanitizer posture as
        // every other interpolated value in this file.
        const safeTitle = this.sanitizeLabel(args.title);
        const safeMessage = sanitizeDescription(args.message, 500);
        // The id is a generated uuid, but it is interpolated into a URL —
        // encode it rather than trusting the shape of a value that reaches
        // here through a producer input.
        const actionUrl = `/inbox?id=${encodeURIComponent(args.itemId)}`;
        await this.create({
            userId: args.userId,
            type: urgent ? NotificationType.WARNING : NotificationType.INFO,
            category: NotificationCategory.AGENT,
            title: safeTitle,
            message: safeMessage,
            actionUrl,
            actionLabel: 'Open inbox',
            metadata: { inboxItemId: args.itemId, kind: args.kind },
            deduplicationKey: `inbox_item_${args.itemId}`,
        });
        await this.dispatchFanout({
            userId: args.userId,
            eventKey: eventKeyByKind[args.kind],
            title: safeTitle,
            message: safeMessage,
            actionUrl,
            actionLabel: 'Open inbox',
            urgent,
        });
    }

    /**
     * Delete expired and old notifications
     * Should be called periodically by a cleanup job
     */
    async cleanup(): Promise<{ expired: number; dismissed: number; old: number }> {
        const expired = await this.repository.deleteExpired();
        const dismissed = await this.repository.deleteOlderThan({
            olderThanDays: 7,
            isDismissed: true,
        });
        const old = await this.repository.deleteOlderThan({
            olderThanDays: 30,
        });

        this.logger.log(
            `Notification cleanup: ${expired} expired, ${dismissed} dismissed (>7d), ${old} old (>30d)`,
        );

        return { expired, dismissed, old };
    }
}
