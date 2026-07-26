import { Injectable, Logger } from '@nestjs/common';
import { BillingProfileRepository } from '@src/database/repositories/billing-profile.repository';
import { CreditLedgerService } from '../credits/credit-ledger.service';
import { BillingProvider } from './billing.provider';
import { defaultAutoRechargePack, findCreditPack } from './credit-packs';

export type AutoRechargeOutcome =
    /** Auto-recharge is off, unconfigured, or has no payment method. */
    | { status: 'disabled' }
    /** Balance is still above the threshold. */
    | { status: 'above-threshold'; balanceCredits: number }
    /** Another crossing already claimed the slot — this one must not fire. */
    | { status: 'already-in-flight' }
    /** Off-session charge placed; the webhook will credit the ledger. */
    | { status: 'charged'; paymentId: string; packId: string }
    /** The provider declined; the guard is released and the count bumped. */
    | { status: 'failed'; failureCode?: string };

/**
 * Threshold-triggered auto-recharge (billing PRD §3.4).
 *
 * Called best-effort after each credits debit (`RunCostSettlementService`
 * hooks it once a run settles). The whole contract is "fire AT MOST once
 * per crossing":
 *
 *   1. Read the owner's `billing_profiles` row. No row, disabled, no
 *      stored payment method, or an unconfigured provider ⇒ `disabled`.
 *   2. Compare the live ledger balance against the stored threshold.
 *   3. **Claim the in-flight slot with a compare-and-set** — a single SQL
 *      `UPDATE … WHERE autoRechargeInFlightKey IS NULL`. Two debits that
 *      both cross the threshold both reach here; exactly one wins the
 *      claim, the other returns `already-in-flight` and places no charge.
 *   4. Charge off-session through the provider seam using the SERVER-side
 *      pack (never a client amount), passing the claim key as the
 *      provider idempotency key so even a retried call resolves to one
 *      payment.
 *   5. The slot is released by the webhook that credits the ledger
 *      (`BillingService.applyPurchase`) or immediately on failure.
 *
 * This service NEVER writes to the ledger. Credits appear only when the
 * signature-verified webhook confirms the money actually moved.
 */
@Injectable()
export class AutoRechargeService {
    private readonly logger = new Logger(AutoRechargeService.name);

    constructor(
        private readonly billingProvider: BillingProvider,
        private readonly billingProfileRepository: BillingProfileRepository,
        private readonly creditLedgerService: CreditLedgerService,
    ) {}

    async maybeRecharge(userId: string, now: Date = new Date()): Promise<AutoRechargeOutcome> {
        if (!this.billingProvider.isConfigured()) {
            return { status: 'disabled' };
        }

        const profile = await this.billingProfileRepository.findByUserId(userId);
        if (
            !profile ||
            !profile.autoRechargeEnabled ||
            !profile.defaultPaymentMethodRef ||
            !profile.providerCustomerId
        ) {
            return { status: 'disabled' };
        }

        const threshold = profile.autoRechargeThresholdCredits;
        if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0) {
            return { status: 'disabled' };
        }

        // Cheap pre-check before the CAS: an already-claimed slot means a
        // charge is on its way and this crossing must be a no-op.
        if (profile.autoRechargeInFlightKey) {
            return { status: 'already-in-flight' };
        }

        const balanceCredits = await this.creditLedgerService.getBalance(userId);
        if (balanceCredits >= threshold) {
            return { status: 'above-threshold', balanceCredits };
        }

        const pack = findCreditPack(profile.autoRechargePackId) ?? defaultAutoRechargePack();
        // The claim key is stable per (user, pack, minute-of-crossing) so a
        // retried charge reuses the provider's idempotency record.
        const claimKey = `auto:${userId}:${pack.id}:${now.getTime()}`;

        const claimed = await this.billingProfileRepository.claimAutoRechargeSlot(
            userId,
            claimKey,
            now,
        );
        if (!claimed) {
            return { status: 'already-in-flight' };
        }

        try {
            const result = await this.billingProvider.chargeOffSession({
                customerId: profile.providerCustomerId,
                paymentMethodRef: profile.defaultPaymentMethodRef,
                pack,
                userId,
                idempotencyKey: claimKey,
            });

            if (result.status === 'failed') {
                await this.billingProfileRepository.recordAutoRechargeFailure(userId, now);
                return { status: 'failed', failureCode: result.failureCode };
            }

            // Slot stays claimed until the webhook credits the ledger —
            // that is what prevents a second charge while the first
            // payment is still settling.
            return { status: 'charged', paymentId: result.paymentId, packId: pack.id };
        } catch (error) {
            await this.billingProfileRepository.recordAutoRechargeFailure(userId, now);
            this.logger.warn(
                `Auto-recharge failed for user ${userId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return { status: 'failed' };
        }
    }
}
