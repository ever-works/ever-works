import { Injectable, Logger, Optional } from '@nestjs/common';
import { BillingProfileRepository } from '@src/database/repositories/billing-profile.repository';
import { CreditMeterEventRepository } from '@src/database/repositories/credit-meter-event.repository';
import {
    BillingProfile,
    isPastDueSubscriptionStatus,
    type BillingSubscriptionStatus,
} from '@src/entities/billing-profile.entity';
import {
    CreditMeterEventStatus,
    type CreditMeterEvent,
} from '@src/entities/credit-meter-event.entity';
import { NotificationService } from '@src/notifications/notification.service';
import { config } from '@src/config';
import {
    BillingProvider,
    BillingProviderNotConfiguredError,
    type BillingInvoiceSnapshot,
    type BillingSubscriptionSnapshot,
    type BillingWebhookEvent,
} from './billing.provider';
import {
    estimatePaygCents,
    getPaygCatalog,
    paygLookupKey,
    type CatalogPaygTier,
} from './stripe-catalog';

/** Owner asked to enable pay-as-you-go without a stored payment method. */
export class PaygPaymentMethodRequiredError extends Error {
    constructor() {
        super('Add a payment method before enabling pay-as-you-go');
        this.name = 'PaygPaymentMethodRequiredError';
    }
}

/** A cap outside `[PAYG_MIN_CAP, max]`. Stable name → 400 at the API boundary. */
export class PaygCapOutOfRangeError extends Error {
    constructor(
        public readonly requested: number,
        public readonly min: number,
        public readonly max: number,
    ) {
        super(`Monthly cap must be between ${min} and ${max} credits (got ${requested})`);
        this.name = 'PaygCapOutOfRangeError';
    }
}

/** Smallest self-service cap. Below this the mid-cycle invoice threshold would never trigger. */
export const PAYG_MIN_MONTHLY_CAP_CREDITS = 500;

/** Usage statuses under which overflow may be metered. */
const OVERFLOW_STATUSES: readonly BillingSubscriptionStatus[] = ['active', 'trialing'];

/**
 * Stripe's request-idempotency and meter-identifier de-duplication windows
 * are 24 hours. Past this point an automatic retry could double-bill an
 * event that Stripe accepted before our local `markSent` write failed.
 */
const METER_SAFE_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

/** Flush only rows older than this so the settlement path's own send has had its chance. */
const FLUSH_MIN_AGE_MS = 60 * 1000;

export interface PaygStateView {
    /** The provider is configured, so the feature can be turned on at all. */
    available: boolean;
    enabled: boolean;
    /** Lifecycle of the usage subscription (named to stay clear of the API's `status` envelope). */
    subscriptionStatus: BillingSubscriptionStatus;
    /** `past_due` / `unpaid` — overflow suspended until the invoice settles. */
    pastDue: boolean;
    /** Effective cap (owner's, else catalog default), clamped to the deployment max. */
    monthlyCapCredits: number;
    defaultMonthlyCapCredits: number;
    maxMonthlyCapCredits: number;
    minMonthlyCapCredits: number;
    /** Credits reported/queued in the current cycle. */
    cycleUsedCredits: number;
    /** What those credits will be billed at under the graduated tiers, in cents. */
    cycleEstimateCents: number;
    periodStart: Date | null;
    periodEnd: Date | null;
    tiers: readonly CatalogPaygTier[];
    invoiceThresholdCents: number;
}

export interface OverflowRequest {
    userId: string;
    runId: string;
    /** Credits the prepaid debit could not cover. */
    remainderCredits: number;
    costCentsRef?: number | null;
    organizationId?: string | null;
    tenantId?: string | null;
    now?: Date;
}

export type OverflowOutcome =
    /** Pay-as-you-go is off / suspended / not configured — nothing metered. */
    | { status: 'not-eligible'; billedCredits: 0; writtenOffCredits: number }
    /** Metered (some or all of the remainder; the rest written off beyond the cap). */
    | {
          status: 'metered';
          billedCredits: number;
          writtenOffCredits: number;
          sent: boolean;
          capReached: boolean;
      }
    /** Cap already exhausted — everything written off. */
    | { status: 'cap-exhausted'; billedCredits: 0; writtenOffCredits: number };

export interface FlushSummary {
    scanned: number;
    sent: number;
    retried: number;
    failed: number;
}

/**
 * Pay-as-you-go on Stripe Billing Meters (billing spec §3.5).
 *
 * Prepaid credits stay the primary currency and the platform's own ledger
 * stays the source of truth for them. This service owns ONLY what happens
 * when the prepaid balance cannot cover a run and the owner has opted in:
 *
 *  1. the remainder — capped by the owner's monthly headroom — is recorded
 *     as a `credit_meter_events` row (our idempotent mirror) and reported
 *     to the provider's usage meter; Stripe rates it under the catalog's
 *     graduated price and invoices it in arrears (and mid-cycle at the
 *     threshold);
 *  2. the dispatch gate admits runs while `balance > 0 || headroom > 0`;
 *  3. the owner is told at 80% and 100% of the cap, and a failed arrears
 *     invoice suspends overflow until it is paid.
 *
 * Nothing here moves the plan tier, and nothing here writes the credits
 * ledger — the two stay decoupled on purpose.
 */
@Injectable()
export class PaygService {
    private readonly logger = new Logger(PaygService.name);

    constructor(
        private readonly billingProvider: BillingProvider,
        private readonly billingProfileRepository: BillingProfileRepository,
        private readonly creditMeterEventRepository: CreditMeterEventRepository,
        @Optional() private readonly notificationService?: NotificationService,
    ) {}

    // ── State ─────────────────────────────────────────────────────────

    async getState(userId: string, now: Date = new Date()): Promise<PaygStateView> {
        const profile = await this.billingProfileRepository.findByUserId(userId);
        return this.toView(await this.withCurrentPeriod(profile, now));
    }

    /** Effective cap for a profile: owner's value, else the catalog default, clamped. */
    effectiveCap(profile: BillingProfile | null): number {
        const max = config.billing.payg.getMaxMonthlyCapCredits();
        const raw = profile?.paygMonthlyCapCredits ?? getPaygCatalog().defaultMonthlyCapCredits;
        return Math.max(PAYG_MIN_MONTHLY_CAP_CREDITS, Math.min(max, Math.trunc(raw)));
    }

    /** True when overflow for this owner may be metered right now. */
    isOverflowEligible(profile: BillingProfile | null): boolean {
        if (!profile || !profile.paygEnabled) return false;
        if (!profile.paygSubscriptionId) return false;
        if (!this.billingProvider.isConfigured()) return false;
        return OVERFLOW_STATUSES.includes(profile.paygStatus ?? 'none');
    }

    /** Credits still meterable this cycle (0 when not eligible). Refreshes a stale period. */
    async headroom(userId: string, now: Date = new Date()): Promise<number> {
        const profile = await this.withCurrentPeriod(
            await this.billingProfileRepository.findByUserId(userId),
            now,
        );
        if (
            !this.isOverflowEligible(profile) ||
            !profile?.paygPeriodStart ||
            !profile.paygPeriodEnd
        ) {
            return 0;
        }
        const used = await this.creditMeterEventRepository.sumCreditsForPeriod(
            userId,
            profile.paygPeriodStart,
            profile.paygPeriodEnd,
        );
        return Math.max(0, this.effectiveCap(profile) - used);
    }

    // ── Enable / cap / disable ────────────────────────────────────────

    /**
     * Turn pay-as-you-go on (billing spec FR-16). Requires a stored default
     * payment method (the arrears invoices charge it). Idempotent: an owner
     * with a live usage subscription just gets the cap updated and the
     * flag re-asserted.
     */
    async enable(
        userId: string,
        options: { monthlyCapCredits?: number | null } = {},
        now: Date = new Date(),
    ): Promise<PaygStateView> {
        if (!this.billingProvider.isConfigured()) {
            throw new BillingProviderNotConfiguredError();
        }
        const profile = await this.billingProfileRepository.findByUserId(userId);
        if (!profile || !profile.providerCustomerId || !profile.defaultPaymentMethodRef) {
            throw new PaygPaymentMethodRequiredError();
        }
        const cap = this.validateCap(options.monthlyCapCredits ?? this.effectiveCap(profile));

        let snapshot: BillingSubscriptionSnapshot | null = null;
        const hasLiveSubscription =
            Boolean(profile.paygSubscriptionId) &&
            profile.paygStatus !== 'canceled' &&
            profile.paygStatus !== 'incomplete_expired';
        if (hasLiveSubscription) {
            // Re-read so an enable after a provider-side change reconciles. A
            // provider failure must propagate: treating "unknown" as "missing"
            // could create a second live metered subscription.
            snapshot = await this.billingProvider.retrieveSubscriptionSnapshot(
                profile.paygSubscriptionId as string,
            );
        }
        if (
            !snapshot ||
            snapshot.status === 'canceled' ||
            snapshot.status === 'incomplete_expired'
        ) {
            snapshot = await this.billingProvider.createMeteredSubscription({
                userId,
                customerId: profile.providerCustomerId,
                paymentMethodRef: profile.defaultPaymentMethodRef,
                lookupKey: paygLookupKey(),
                invoiceThresholdCents: getPaygCatalog().invoiceThresholdCents,
                referenceId: `${userId}:payg`,
                idempotencyKey:
                    `payg-enable:${userId}:${profile.providerCustomerId}:` +
                    (profile.paygSubscriptionId
                        ? `after:${profile.paygSubscriptionId}`
                        : 'initial'),
            });
        }

        const updated = await this.billingProfileRepository.updatePayg(userId, {
            paygEnabled: true,
            paygSubscriptionId: snapshot.subscriptionId,
            paygSubscriptionItemId: snapshot.subscriptionItemId ?? null,
            paygStatus: snapshot.status,
            paygPeriodStart: snapshot.currentPeriodStart ?? null,
            paygPeriodEnd: snapshot.currentPeriodEnd ?? null,
            paygMonthlyCapCredits: cap,
            paygCapNotifiedPercent: 0,
        });
        return this.toView(updated);
    }

    async updateCap(
        userId: string,
        monthlyCapCredits: number,
        now: Date = new Date(),
    ): Promise<PaygStateView> {
        const cap = this.validateCap(monthlyCapCredits);
        const profile = await this.billingProfileRepository.findByUserId(userId);
        if (!profile) {
            throw new PaygPaymentMethodRequiredError();
        }
        const updated = await this.billingProfileRepository.updatePayg(userId, {
            paygMonthlyCapCredits: cap,
            // A raised cap un-latches the 100% notice so it can fire again.
            paygCapNotifiedPercent: 0,
        });
        return this.toView(await this.withCurrentPeriod(updated, now));
    }

    /**
     * Turn pay-as-you-go off (billing spec FR-17). The flag is cleared
     * FIRST — overflow stops even if the provider call fails — then the
     * usage subscription is cancelled immediately with the accrued usage
     * invoiced now. A provider failure is surfaced (the owner sees an
     * error and the subscription is retried on the next disable); it never
     * leaves overflow running.
     */
    async disable(userId: string, now: Date = new Date()): Promise<PaygStateView> {
        const profile = await this.billingProfileRepository.findByUserId(userId);
        if (!profile) {
            return this.toView(null);
        }
        await this.billingProfileRepository.updatePayg(userId, { paygEnabled: false });

        if (profile.paygSubscriptionId && this.billingProvider.isConfigured()) {
            const live =
                profile.paygStatus !== 'canceled' && profile.paygStatus !== 'incomplete_expired';
            if (live) {
                const snapshot = await this.billingProvider.cancelMeteredSubscriptionNow({
                    subscriptionId: profile.paygSubscriptionId,
                });
                await this.billingProfileRepository.updatePayg(userId, {
                    paygStatus: snapshot.status,
                    paygPeriodEnd: snapshot.currentPeriodEnd ?? profile.paygPeriodEnd ?? null,
                });
            }
        }
        const updated = await this.billingProfileRepository.findByUserId(userId);
        return this.toView(updated);
    }

    // ── Overflow (settlement path) ────────────────────────────────────

    /**
     * Meter the part of a run's cost the prepaid balance could not cover
     * (billing spec FR-18). Row first (idempotent on `run:{runId}`), send
     * second; a send failure leaves the row `pending` for the flush cron.
     * Anything beyond the cap headroom is written off — the platform never
     * bills past the cap it promised.
     */
    async recordOverflow(request: OverflowRequest): Promise<OverflowOutcome> {
        const now = request.now ?? new Date();
        const remainder = Math.max(0, Math.trunc(request.remainderCredits));
        if (remainder <= 0) {
            return { status: 'not-eligible', billedCredits: 0, writtenOffCredits: 0 };
        }

        const profile = await this.withCurrentPeriod(
            await this.billingProfileRepository.findByUserId(request.userId),
            now,
        );
        if (
            !this.isOverflowEligible(profile) ||
            !profile?.paygPeriodStart ||
            !profile.paygPeriodEnd
        ) {
            return { status: 'not-eligible', billedCredits: 0, writtenOffCredits: remainder };
        }

        const cap = this.effectiveCap(profile);
        const reservation = await this.creditMeterEventRepository.reserveIdempotentWithinCap({
            write: {
                userId: request.userId,
                organizationId: request.organizationId ?? null,
                tenantId: request.tenantId ?? null,
                runId: request.runId,
                identifier: `run:${request.runId}`,
                costCentsRef: request.costCentsRef ?? null,
                periodStart: profile.paygPeriodStart,
                periodEnd: profile.paygPeriodEnd,
            },
            requestedCredits: remainder,
            capCredits: cap,
        });

        if (reservation.status === 'cap-exhausted') {
            await this.notifyCapIfCrossed(profile, cap, reservation.usedCreditsAfter);
            return { status: 'cap-exhausted', billedCredits: 0, writtenOffCredits: remainder };
        }

        let sent = reservation.event.status === CreditMeterEventStatus.SENT;
        if (reservation.status === 'created') {
            sent = await this.send(reservation.event, profile, now);
        }

        await this.notifyCapIfCrossed(profile, cap, reservation.usedCreditsAfter);

        return {
            status: 'metered',
            billedCredits: reservation.event.credits,
            writtenOffCredits: reservation.event.writtenOffCredits,
            sent,
            capReached: reservation.usedCreditsAfter >= cap,
        };
    }

    /**
     * Resend meter events the settlement path could not deliver (billing
     * spec FR-23 — `credits-meter-flush`, every 5 minutes). Rows older
     * than Stripe's safe de-duplication window are marked `failed` and
     * logged for manual reconciliation rather than risking a double bill.
     */
    async flushPending(limit = 500, now: Date = new Date()): Promise<FlushSummary> {
        const summary: FlushSummary = { scanned: 0, sent: 0, retried: 0, failed: 0 };
        if (!this.billingProvider.isConfigured()) return summary;

        const rows = await this.creditMeterEventRepository.findUnsent(
            new Date(now.getTime() - FLUSH_MIN_AGE_MS),
            limit,
        );
        for (const row of rows) {
            summary.scanned += 1;
            if (now.getTime() - row.createdAt.getTime() > METER_SAFE_RETRY_WINDOW_MS) {
                await this.creditMeterEventRepository.recordAttempt(
                    row.id,
                    'older than the provider idempotency window — automatic retry stopped',
                    true,
                );
                summary.failed += 1;
                this.logger.error(
                    `Meter event ${row.identifier} (${row.credits} credits, user ${row.userId}) ` +
                        `is outside the safe idempotency window — reconcile manually before sending.`,
                );
                continue;
            }
            const profile = await this.billingProfileRepository.findByUserId(row.userId);
            if (!profile?.providerCustomerId) {
                await this.creditMeterEventRepository.recordAttempt(
                    row.id,
                    'no billing profile',
                    true,
                );
                summary.failed += 1;
                continue;
            }
            const ok = await this.send(row, profile, now);
            if (ok) summary.sent += 1;
            else summary.retried += 1;
        }
        return summary;
    }

    // ── Webhooks ──────────────────────────────────────────────────────

    /** `payg.updated` — reconcile the usage subscription's lifecycle onto the profile. */
    async applyWebhook(
        event: BillingWebhookEvent,
    ): Promise<'payg-reconciled' | 'unattributed' | 'ignored'> {
        if (event.kind !== 'payg.updated' || !event.subscription) return 'ignored';
        const profile = await this.resolveProfile(event);
        if (!profile) return 'unattributed';
        await this.reconcileSnapshot(profile, event.subscription);
        return 'payg-reconciled';
    }

    /**
     * A pay-as-you-go invoice moved (billing spec FR-21): a payment failure
     * suspends overflow (`past_due`) and notifies; a paid invoice on a
     * suspended profile resumes it. Called by `BillingService.mirrorInvoice`
     * for invoices tagged `subscriptionKind: 'payg'`.
     */
    async applyInvoice(profile: BillingProfile, invoice: BillingInvoiceSnapshot): Promise<void> {
        if (invoice.subscriptionKind !== 'payg') return;
        if (invoice.paymentFailed) {
            if (profile.paygStatus !== 'past_due') {
                await this.billingProfileRepository.updatePayg(profile.userId, {
                    paygStatus: 'past_due',
                });
                await this.notify(() =>
                    this.notificationService?.notifyPaygPastDue({
                        userId: profile.userId,
                        amountCents: invoice.totalCents ?? null,
                    }),
                );
            }
            return;
        }
        if (invoice.status === 'paid' && isPastDueSubscriptionStatus(profile.paygStatus)) {
            await this.billingProfileRepository.updatePayg(profile.userId, {
                paygStatus: 'active',
            });
            await this.notify(() =>
                this.notificationService?.clearByDeduplicationKey(profile.userId, 'payg_past_due'),
            );
        }
    }

    // ── Internals ─────────────────────────────────────────────────────

    private validateCap(value: number): number {
        const max = config.billing.payg.getMaxMonthlyCapCredits();
        const cap = Math.trunc(Number(value));
        if (!Number.isFinite(cap) || cap < PAYG_MIN_MONTHLY_CAP_CREDITS || cap > max) {
            throw new PaygCapOutOfRangeError(cap, PAYG_MIN_MONTHLY_CAP_CREDITS, max);
        }
        return cap;
    }

    private async send(
        row: CreditMeterEvent,
        profile: BillingProfile,
        now: Date,
    ): Promise<boolean> {
        if (!profile.providerCustomerId) return false;
        try {
            const outcome = await this.billingProvider.reportMeterEvent({
                eventName: getPaygCatalog().meterEventName,
                customerId: profile.providerCustomerId,
                value: row.credits,
                identifier: row.identifier,
                // The run's settlement time, not the retry time, so usage
                // lands in the cycle it belongs to.
                timestamp: row.createdAt ?? now,
            });
            if (outcome.status === 'accepted') {
                await this.creditMeterEventRepository.markSent(row.id, now);
                return true;
            }
            await this.creditMeterEventRepository.recordAttempt(
                row.id,
                outcome.failureCode,
                outcome.terminal,
            );
            return false;
        } catch (error) {
            // A thrown provider error (network, not-configured) is retryable.
            await this.creditMeterEventRepository.recordAttempt(
                row.id,
                error instanceof Error ? error.message : String(error),
                false,
            );
            return false;
        }
    }

    /**
     * The profile with a current period. When the stored period has
     * passed (Stripe rolled the cycle but the webhook has not landed
     * yet), re-read the subscription from the provider so the cap is
     * measured over the right window and the notice latch resets.
     */
    private async withCurrentPeriod(
        profile: BillingProfile | null,
        now: Date,
    ): Promise<BillingProfile | null> {
        if (!profile || !profile.paygSubscriptionId || !this.billingProvider.isConfigured()) {
            return profile;
        }
        const stale = !profile.paygPeriodEnd || profile.paygPeriodEnd.getTime() <= now.getTime();
        if (!stale) return profile;
        if (profile.paygStatus === 'canceled' || profile.paygStatus === 'incomplete_expired') {
            return profile;
        }
        try {
            const snapshot = await this.billingProvider.retrieveSubscriptionSnapshot(
                profile.paygSubscriptionId,
            );
            return (await this.reconcileSnapshot(profile, snapshot)) ?? profile;
        } catch (error) {
            this.logger.warn(
                `PAYG: could not refresh the billing period for user ${profile.userId}: ${
                    (error as Error).message
                }`,
            );
            return profile;
        }
    }

    private async reconcileSnapshot(
        profile: BillingProfile,
        snapshot: BillingSubscriptionSnapshot,
    ): Promise<BillingProfile | null> {
        const periodRolled =
            Boolean(snapshot.currentPeriodStart) &&
            (profile.paygPeriodStart?.getTime() ?? -1) !== snapshot.currentPeriodStart?.getTime();
        return this.billingProfileRepository.updatePayg(profile.userId, {
            paygSubscriptionId: snapshot.subscriptionId,
            paygSubscriptionItemId:
                snapshot.subscriptionItemId ?? profile.paygSubscriptionItemId ?? null,
            paygStatus: snapshot.status,
            paygPeriodStart: snapshot.currentPeriodStart ?? profile.paygPeriodStart ?? null,
            paygPeriodEnd: snapshot.currentPeriodEnd ?? profile.paygPeriodEnd ?? null,
            ...(periodRolled ? { paygCapNotifiedPercent: 0 } : {}),
            // A provider-side cancel (portal, dashboard) turns the feature off.
            ...(snapshot.status === 'canceled' || snapshot.status === 'incomplete_expired'
                ? { paygEnabled: false }
                : {}),
        });
    }

    private async notifyCapIfCrossed(
        profile: BillingProfile,
        cap: number,
        used: number,
    ): Promise<void> {
        const percent = cap > 0 ? (used / cap) * 100 : 0;
        const reached: 80 | 100 | null = percent >= 100 ? 100 : percent >= 80 ? 80 : null;
        if (!reached || (profile.paygCapNotifiedPercent ?? 0) >= reached) return;
        await this.billingProfileRepository.updatePayg(profile.userId, {
            paygCapNotifiedPercent: reached,
        });
        await this.notify(() =>
            this.notificationService?.notifyPaygCapThreshold({
                userId: profile.userId,
                percent: reached,
                usedCredits: used,
                capCredits: cap,
                periodEnd: profile.paygPeriodEnd ?? null,
            }),
        );
    }

    private async notify(fn: () => Promise<void> | undefined): Promise<void> {
        try {
            await fn();
        } catch (error) {
            this.logger.warn(`PAYG notification failed (ignored): ${(error as Error).message}`);
        }
    }

    private async resolveProfile(event: BillingWebhookEvent): Promise<BillingProfile | null> {
        const provider = this.billingProvider.getProviderId();
        if (event.subscriptionId) {
            const bySubscription = await this.billingProfileRepository.findByPaygSubscriptionId(
                provider,
                event.subscriptionId,
            );
            if (bySubscription) return bySubscription;
        }
        if (event.customerId) {
            const byCustomer = await this.billingProfileRepository.findByCustomerId(
                provider,
                event.customerId,
            );
            if (byCustomer) return byCustomer;
        }
        if (event.referenceId) {
            const [userId] = event.referenceId.split(':');
            if (userId) return this.billingProfileRepository.findByUserId(userId);
        }
        return null;
    }

    private async toView(profile: BillingProfile | null): Promise<PaygStateView> {
        const payg = getPaygCatalog();
        const cap = this.effectiveCap(profile);
        let used = 0;
        if (profile?.paygSubscriptionId && profile.paygPeriodStart && profile.paygPeriodEnd) {
            used = await this.creditMeterEventRepository.sumCreditsForPeriod(
                profile.userId,
                profile.paygPeriodStart,
                profile.paygPeriodEnd,
            );
        }
        return {
            available: this.billingProvider.isConfigured(),
            enabled: Boolean(profile?.paygEnabled),
            subscriptionStatus: profile?.paygStatus ?? 'none',
            pastDue: isPastDueSubscriptionStatus(profile?.paygStatus),
            monthlyCapCredits: cap,
            defaultMonthlyCapCredits: payg.defaultMonthlyCapCredits,
            maxMonthlyCapCredits: config.billing.payg.getMaxMonthlyCapCredits(),
            minMonthlyCapCredits: PAYG_MIN_MONTHLY_CAP_CREDITS,
            cycleUsedCredits: used,
            cycleEstimateCents: estimatePaygCents(used),
            periodStart: profile?.paygPeriodStart ?? null,
            periodEnd: profile?.paygPeriodEnd ?? null,
            tiers: payg.tiers,
            invoiceThresholdCents: payg.invoiceThresholdCents,
        };
    }
}
