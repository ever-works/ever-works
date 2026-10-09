import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BillingProfileRepository } from '@src/database/repositories/billing-profile.repository';
import { SubscriptionPlanRepository } from '@src/database/repositories/subscription-plan.repository';
import { UserSubscriptionRepository } from '@src/database/repositories/user-subscription.repository';
import { SubscriptionPlanCode } from '@src/entities/types';
import { NotificationService } from '@src/notifications/notification.service';

/**
 * Emitted once per `(subscription, lead)` when a plan's free trial is about to end. The API's
 * mail handler (`apps/api/src/billing/trial-ending-mail.handler.ts`) turns it into the reminder
 * email through the existing `MailService`.
 */
export const BILLING_TRIAL_ENDING_EVENT = 'billing.trial-ending';

export interface BillingTrialEndingEvent {
    readonly userId: string;
    readonly planCode: string | null;
    readonly planName: string;
    readonly subscriptionId: string;
    readonly trialEnd: Date;
    /** How far ahead this reminder is: the 7-day sweep, or the provider's ~3-day notice. */
    readonly lead: '7d' | '3d';
}

/** How far ahead the sweep's reminder goes out. The provider sends its own at ~3 days. */
export const TRIAL_REMINDER_LEAD_DAYS = 7;
/** The sweep keeps retrying until this close to the end; the provider's notice takes over below. */
const TRIAL_REMINDER_FLOOR_DAYS = 3;
const SWEEP_PAGE = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrialReminderSweepSummary {
    scanned: number;
    reminded: number;
    alreadyReminded: number;
    failed: number;
}

/**
 * Trial-ending reminders (owner, 2026-10-09) for the 90-day Cloud trial.
 *
 * Two triggers, one sender:
 *
 *  - **3 days before** — the provider's own notice (Stripe `customer.subscription.trial_will_end`),
 *    normalized to `subscription.trial_will_end` and routed here by `BillingService`.
 *  - **7 days before** — a pass of the existing daily credits sweep (`credits-daily-grant` cron),
 *    over billing profiles whose subscription is `trialing`, not set to cancel, and whose current
 *    period (= the trial) ends 3 to 7 days from now (retried daily until sent).
 *
 * Exactly once per `(subscription, lead)`: the in-app notification's deduplication key is the
 * guard, and the email event is emitted only when THIS call created that row. A trial already set
 * to cancel gets no reminder — nothing will be charged.
 *
 * Changes nothing about the trial itself (length, credits, price): it only tells the customer.
 */
@Injectable()
export class TrialReminderService {
    private readonly logger = new Logger(TrialReminderService.name);

    constructor(
        private readonly billingProfileRepository: BillingProfileRepository,
        private readonly userSubscriptionRepository: UserSubscriptionRepository,
        private readonly planRepository: SubscriptionPlanRepository,
        @Optional() private readonly notificationService?: NotificationService,
        @Optional() private readonly eventEmitter?: EventEmitter2,
    ) {}

    /**
     * Send one reminder. Returns `true` when a reminder went out now, `false` when it had already
     * been sent (or there is nothing to remind about).
     */
    async remind(input: {
        userId: string;
        subscriptionId: string;
        planCode: string | null;
        trialEnd: Date;
        lead: '7d' | '3d';
        cancelAtPeriodEnd?: boolean | null;
    }): Promise<boolean> {
        if (input.cancelAtPeriodEnd) return false;
        if (!(input.trialEnd instanceof Date) || Number.isNaN(input.trialEnd.getTime())) {
            return false;
        }
        const planName = await this.planNameFor(input.planCode);

        // Dedup first. Without the notifications module (a stripped-down deployment) there is no
        // dedup row, so the email still goes out — the provider sends `trial_will_end` once, and
        // the sweep window is one day wide.
        if (this.notificationService) {
            const created = await this.notificationService.notifyTrialEnding({
                userId: input.userId,
                subscriptionId: input.subscriptionId,
                lead: input.lead,
                planName,
                trialEnd: input.trialEnd,
            });
            if (!created) return false;
        }

        const event: BillingTrialEndingEvent = {
            userId: input.userId,
            planCode: input.planCode,
            planName,
            subscriptionId: input.subscriptionId,
            trialEnd: input.trialEnd,
            lead: input.lead,
        };
        this.eventEmitter?.emit(BILLING_TRIAL_ENDING_EVENT, event);
        return true;
    }

    /**
     * The 7-day pass of the daily sweep. Idempotent (see `remind`), bounded, and best-effort per
     * profile: one failure is counted and the rest still run.
     */
    async sweepSevenDayReminders(now: Date = new Date()): Promise<TrialReminderSweepSummary> {
        const summary: TrialReminderSweepSummary = {
            scanned: 0,
            reminded: 0,
            alreadyReminded: 0,
            failed: 0,
        };
        // Every trial ending 3-7 days out, not just the 24 h at day 7: a reminder that failed (or a
        // sweep that did not run) is retried on the next pass, and the once-per-(subscription,
        // lead) dedup skips the ones already sent. Below 3 days the provider's own notice covers it.
        const from = new Date(now.getTime() + TRIAL_REMINDER_FLOOR_DAYS * DAY_MS);
        const to = new Date(now.getTime() + TRIAL_REMINDER_LEAD_DAYS * DAY_MS);
        const profiles: Awaited<ReturnType<BillingProfileRepository['findTrialsEndingBetween']>> =
            [];
        for (let skip = 0; ; skip += SWEEP_PAGE) {
            const page = await this.billingProfileRepository.findTrialsEndingBetween(
                from,
                to,
                SWEEP_PAGE,
                skip,
            );
            profiles.push(...page);
            if (page.length < SWEEP_PAGE) break;
        }
        for (const profile of profiles) {
            summary.scanned++;
            if (!profile.providerSubscriptionId || !profile.currentPeriodEnd) continue;
            try {
                const current = await this.userSubscriptionRepository.findByProviderSubscriptionId(
                    profile.providerSubscriptionId,
                );
                const sent = await this.remind({
                    userId: profile.userId,
                    subscriptionId: profile.providerSubscriptionId,
                    planCode: current?.planCode ?? null,
                    trialEnd: profile.currentPeriodEnd,
                    lead: '7d',
                    cancelAtPeriodEnd: profile.cancelAtPeriodEnd,
                });
                if (sent) summary.reminded++;
                else summary.alreadyReminded++;
            } catch (error) {
                summary.failed++;
                this.logger.warn(
                    `Trial reminder for user ${profile.userId} failed (next sweep retries): ${(error as Error).message}`,
                );
            }
        }
        return summary;
    }

    private async planNameFor(planCode: string | null): Promise<string> {
        if (!planCode) return 'paid plan';
        try {
            const normalized = String(planCode).toLowerCase();
            if (!Object.values(SubscriptionPlanCode).includes(normalized as SubscriptionPlanCode)) {
                return 'paid plan';
            }
            const plan = await this.planRepository.findByCode(normalized as SubscriptionPlanCode);
            return plan?.displayName ? `${plan.displayName} plan` : 'paid plan';
        } catch {
            return 'paid plan';
        }
    }
}
