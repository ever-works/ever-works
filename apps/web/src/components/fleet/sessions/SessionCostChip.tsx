'use client';

import { useTranslations } from 'next-intl';
import type { FleetSessionUsage } from '@ever-works/contracts';
import { sessionCostChipModel } from '../usage/usage.shared';

/**
 * Usage & cost on the fleet (FL-20, spec FR-10, §5.3, CONTRACTS R-22) — the
 * session card's `cost` slot: `$0.42 · list` when the session's model work is
 * priced, `tokens only · <model>` when it is not (a model the price list does
 * not know is never shown as $0). The tooltip is the payer sentence (FR-9).
 * Renders nothing until the computer's usage scan reported the session.
 */
export function SessionCostChip({
    costCents,
    tokens,
}: {
    costCents?: number | null;
    tokens?: FleetSessionUsage | null;
}) {
    const t = useTranslations('fleet.usage');
    const model = sessionCostChipModel({ costCents, tokens });
    if (!model) return null;
    const label =
        model.kind === 'cost'
            ? t('chip.cost', { cost: model.cost })
            : model.model
              ? t('chip.tokensOnlyModel', { model: model.model, tokens: model.tokens })
              : t('chip.tokensOnly', { tokens: model.tokens });
    const note = t('payerNote');
    return (
        <span
            className="inline-flex items-center rounded-full border border-border dark:border-border-dark px-1.5 py-0.5 tabular-nums"
            title={note}
            aria-label={`${label}. ${note}`}
            data-testid="fleet-session-cost-chip"
            data-kind={model.kind}
        >
            {label}
        </span>
    );
}
