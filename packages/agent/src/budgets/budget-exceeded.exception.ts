import { HttpException, HttpStatus } from '@nestjs/common';
import type { WorkBudgetScope } from '@src/entities/work-budget.entity';

export interface BudgetExceededDetails {
    readonly workId: string;
    readonly scope: WorkBudgetScope;
    readonly pluginId?: string | null;
    readonly currentSpendCents: number;
    readonly capCents: number;
    readonly currency: string;
}

/**
 * EW-602 — Thrown by BudgetGuardService when a Work has reached its
 * monthly cap and `allowOverage` is false. HTTP 402 Payment Required.
 *
 * The response body carries enough context for the frontend to show
 * a "you've hit your cap; raise it or enable overage" banner with a
 * direct deep-link to the relevant /settings/budgets-usage entry.
 */
export class BudgetExceededException extends HttpException {
    constructor(public readonly details: BudgetExceededDetails) {
        const scopeLabel =
            details.scope === 'plugin' && details.pluginId
                ? `plugin '${details.pluginId}'`
                : 'this directory';
        const message = `Monthly budget cap reached for ${scopeLabel} (spent ${
            details.currentSpendCents
        } / ${details.capCents} ${details.currency.toUpperCase()} cents). Raise the cap or enable overage in /settings/budgets-usage.`;

        super(
            {
                statusCode: HttpStatus.PAYMENT_REQUIRED,
                error: 'BudgetExceeded',
                message,
                details,
            },
            HttpStatus.PAYMENT_REQUIRED,
        );
    }
}
