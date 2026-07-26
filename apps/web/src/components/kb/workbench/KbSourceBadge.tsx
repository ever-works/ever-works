'use client';

import { useTranslations } from 'next-intl';
import { Bot, Plug, Sparkles, User } from 'lucide-react';
import {
    deriveKbMemorySourceBadge,
    readKbConnectorSource,
    type KbDocumentDto,
    type KbMemorySourceBadge,
} from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';

/**
 * Memory facets — provenance badge for one KB / memory document.
 *
 * The badge is DERIVED, never stored: `deriveKbMemorySourceBadge` is a
 * pure function of the existing `source` column plus the ingest
 * provenance the event-ingest spine already stamps into
 * `metadata.provenance`. That is what makes connector-derived memory
 * identifiable at a glance without a migration or a backfill — and it
 * keeps the badge honest, because there is no second field that can
 * drift away from the truth.
 */

const BADGE_ICONS: Record<KbMemorySourceBadge, typeof User> = {
    human: User,
    agent: Bot,
    synthesized: Sparkles,
    connector: Plug,
};

/**
 * One class string per badge. Deliberately low-contrast: provenance is
 * metadata, not a status — it must never out-shout the review-state or
 * decision-status chips next to it.
 */
const BADGE_STYLES: Record<KbMemorySourceBadge, string> = {
    human: 'bg-card-hover text-text-muted dark:bg-card-primary-dark/40 dark:text-text-muted-dark/80',
    agent: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
    synthesized: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
    connector: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
};

export interface KbSourceBadgeProps {
    document: Pick<KbDocumentDto, 'source' | 'path' | 'tags'> & {
        metadata?: Record<string, unknown> | null;
    };
    /** Render only the icon (dense list rows). */
    compact?: boolean;
    className?: string;
    testId?: string;
}

export function KbSourceBadge({ document, compact, className, testId }: KbSourceBadgeProps) {
    const t = useTranslations('dashboard.workDetail.kb.facets');
    const badge = deriveKbMemorySourceBadge(document);
    const connector = readKbConnectorSource(document);
    const Icon = BADGE_ICONS[badge];

    // A connector badge names the tool it came from — "Connector" alone
    // tells the reader nothing actionable, "slack" does.
    const label = badge === 'connector' && connector ? connector : t(`badge.${badge}`);
    const aria =
        badge === 'connector'
            ? t('badgeAria.connector', { source: connector ?? label })
            : t(`badgeAria.${badge}`);

    return (
        <span
            data-testid={testId ?? 'kb-source-badge'}
            data-badge={badge}
            data-connector={connector ?? undefined}
            title={aria}
            aria-label={aria}
            className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5',
                'text-[10px] font-medium uppercase tracking-wide',
                BADGE_STYLES[badge],
                className,
            )}
        >
            <Icon className="h-3 w-3" aria-hidden="true" />
            {compact ? null : <span className="max-w-[8rem] truncate">{label}</span>}
        </span>
    );
}
