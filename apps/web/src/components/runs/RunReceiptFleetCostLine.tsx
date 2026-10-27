'use client';

import { useTranslations } from 'next-intl';
import type { RunReceiptFleetUsage } from '@ever-works/contracts';
import { UsagePayerNote } from '@/components/fleet/usage/UsagePayerNote';
import { usageCacheTokens, usageMoney, usageTokens } from '@/components/fleet/usage/usage.shared';

/**
 * Usage & cost on the fleet (FL-20, spec FR-11, §5.4) — the Run receipt's line
 * for model work on a computer: "Model work on build-01 · $0.42 at list price
 * (v1) · 61 k in · 9 k out · 212 k cache", then the payer sentence. Mounted in
 * AW-09's cost block only when the Run has scanned usage; renders nothing
 * otherwise, so every other receipt is unchanged.
 */
export function RunReceiptFleetCostLine({
    usage,
}: {
    usage: RunReceiptFleetUsage | null | undefined;
}) {
    const t = useTranslations('fleet.usage.receipt');
    if (!usage) return null;
    const cost = usageMoney(usage.costCents);
    const figures = {
        computer: usage.nodeName,
        in: usageTokens(usage.tokens.in),
        out: usageTokens(usage.tokens.out),
        cache: usageTokens(usageCacheTokens(usage.tokens)),
    };
    return (
        <div
            className="rounded-md border border-border/60 dark:border-border-dark/60 px-3 py-2 space-y-1"
            data-testid="run-receipt-fleet-cost-line"
        >
            <p className="text-xs text-text dark:text-text-dark tabular-nums">
                {cost
                    ? t('line', { ...figures, cost, version: usage.priceListVersion ?? 1 })
                    : t('lineTokensOnly', figures)}
            </p>
            {usage.unknownModels.length > 0 && (
                <p className="text-[11px] text-text-muted">
                    {t('unknownModels', { models: usage.unknownModels.join(', ') })}
                </p>
            )}
            <UsagePayerNote className="text-[11px]" />
        </div>
    );
}
