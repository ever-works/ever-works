'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';

/**
 * Usage & cost on the fleet (FL-20, spec FR-9) — the payer sentence, ONE
 * component mounted on every surface that shows a fleet cost (the receipt
 * line, the Usage tab, the computer Overview line): "List price — what this
 * would cost on a pay-as-you-go key. The machine's own sign-in paid for it;
 * Ever Works charged nothing." The key's text equals contracts'
 * `FLEET_USAGE_PAYER_NOTE` verbatim (a unit spec holds them together).
 */
export function UsagePayerNote({ className }: { className?: string }) {
    const t = useTranslations('fleet.usage');
    return (
        <p
            className={cn('text-xs text-text-muted dark:text-text-muted-dark', className)}
            data-testid="fleet-usage-payer-note"
        >
            {t('payerNote')}
        </p>
    );
}
