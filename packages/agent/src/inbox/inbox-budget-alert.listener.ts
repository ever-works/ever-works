import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BudgetThresholdCrossedEvent } from '../budgets/budget-threshold-crossed.event';
import { InboxService } from './inbox.service';

/**
 * Inbox (operator message center) — the SYSTEM-NOTICE producer.
 *
 * `BudgetThresholdCrossedEvent` is emitted by `BudgetGuardService` once
 * per (budget, threshold, period) — the idempotency is enforced upstream
 * by the unique index behind `WorkBudgetAlertStateRepository.record`, so
 * this handler may file unconditionally without a dedup key of its own.
 *
 * Filing the crossing as an inbox notice is the one wired example of
 * `InboxService.notice`: a budget that is about to stop the work belongs
 * on the surface the human checks for "what needs me", not only in the
 * bell.
 *
 * `notify: false` on purpose — the api-side `BudgetAlertHandler` already
 * subscribes to this SAME event and writes the in-app notification plus
 * the templated email. Ringing again from here would give every threshold
 * crossing two bell rows and two channel fanouts for one event. The
 * unread sidebar badge still counts the row.
 *
 * Best-effort by contract — spend enforcement already happened inside
 * the guard; a failure to TELL the human must never propagate back into
 * the capability call that triggered it (the emit is fire-and-forget on
 * the guard side, but an unhandled rejection here would still be noise).
 */
@Injectable()
export class InboxBudgetAlertListener {
    private readonly logger = new Logger(InboxBudgetAlertListener.name);

    constructor(private readonly inbox: InboxService) {}

    @OnEvent(BudgetThresholdCrossedEvent.EVENT_NAME, { async: true })
    async handleBudgetThresholdCrossed(event: BudgetThresholdCrossedEvent): Promise<void> {
        try {
            const spend = formatMoney(event.currentSpendCents, event.currency);
            const cap = formatMoney(event.capCents, event.currency);
            const percent =
                event.capCents > 0
                    ? Math.round((event.currentSpendCents / event.capCents) * 100)
                    : 100;
            await this.inbox.notice(event.userId, {
                title: `Budget ${event.threshold} reached (${percent}% of cap)`,
                body:
                    `The ${event.capability} budget for this work has reached ${spend} of its ` +
                    `${cap} cap for the current period (threshold ${event.threshold}` +
                    `${event.pluginId ? `, plugin ${event.pluginId}` : ''}). ` +
                    'Raise the cap, allow overage, or let the period roll over.',
                workId: event.workId,
                // BudgetAlertHandler already rang for this event.
                notify: false,
            });
        } catch (error) {
            this.logger.warn(
                `Budget alert for work ${event.workId} could not be filed in the inbox: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}

/** Cents → `"12.34 USD"`. Currency codes are already normalized upstream. */
function formatMoney(cents: number, currency: string): string {
    return `${(Math.max(0, cents) / 100).toFixed(2)} ${currency.toUpperCase()}`;
}
