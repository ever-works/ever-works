import { createElement } from 'react';
import { useTranslations } from 'next-intl';
import {
    BookOpen,
    CalendarClock,
    ClipboardCheck,
    FileBarChart,
    Inbox,
    Link2,
    Puzzle,
    RefreshCw,
    Sunrise,
    Telescope,
    type LucideIcon,
} from 'lucide-react';
import type { PlaybookCategory, PlaybookSummary } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { ReadinessChip, useReadinessLabel } from './ReadinessChip';

/** Icon keys a provider may declare; anything else falls back to the category icon. */
const ICONS: Record<string, LucideIcon> = {
    report: FileBarChart,
    sunrise: Sunrise,
    link: Link2,
    puzzle: Puzzle,
    checklist: ClipboardCheck,
    refresh: RefreshCw,
    telescope: Telescope,
    inbox: Inbox,
};

const CATEGORY_ICONS: Record<PlaybookCategory, LucideIcon> = {
    reporting: FileBarChart,
    content: BookOpen,
    operations: CalendarClock,
    research: Telescope,
    inbox: Inbox,
};

export function playbookIcon(icon: string, category: PlaybookCategory): LucideIcon {
    return ICONS[icon] ?? CATEGORY_ICONS[category] ?? BookOpen;
}

/** The playbook's icon, resolved from its key with the category icon as fallback. */
export function PlaybookIcon({
    icon,
    category,
    className,
}: {
    icon: string;
    category: PlaybookCategory;
    className?: string;
}) {
    return createElement(playbookIcon(icon, category), { className, 'aria-hidden': true });
}

/**
 * One playbook on the catalogue index — a single focusable link whose
 * accessible name is `<title>, <category>, <readiness>`.
 */
export function PlaybookCard({ playbook }: { playbook: PlaybookSummary }) {
    const t = useTranslations('dashboard.catalogPage');
    const readinessLabel = useReadinessLabel();
    const category = t(`categories.${playbook.category}`);
    const readiness = readinessLabel(playbook.readiness, playbook.missingRequired.length);

    return (
        <Link
            href={ROUTES.DASHBOARD_CATALOG_PLAYBOOK(playbook.slug)}
            data-catalog-card
            data-testid="playbook-card"
            data-slug={playbook.slug}
            aria-label={t('card.ariaLabel', { title: playbook.title, category, readiness })}
            className="group flex h-full flex-col gap-3 rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
            <div className="flex items-start gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <PlaybookIcon
                        icon={playbook.icon}
                        category={playbook.category}
                        className="h-4 w-4"
                    />
                </span>
                <div className="min-w-0">
                    <h3 lang="en" className="text-sm font-semibold text-text dark:text-text-dark">
                        {playbook.title}
                    </h3>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">{category}</p>
                </div>
            </div>
            <p
                lang="en"
                className="text-sm text-text-secondary dark:text-text-secondary-dark line-clamp-3"
            >
                {playbook.outcome}
            </p>
            <div className="mt-auto space-y-2">
                <p lang="en" className="text-xs text-text-muted dark:text-text-muted-dark">
                    {playbook.triggerDescription}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                    <ReadinessChip
                        state={playbook.readiness}
                        missingCount={playbook.missingRequired.length}
                    />
                    <span
                        className="text-xs text-text-muted dark:text-text-muted-dark"
                        title={t('cost.tooltip')}
                    >
                        {t(`cost.${playbook.costBand}`)}
                    </span>
                </div>
            </div>
        </Link>
    );
}
