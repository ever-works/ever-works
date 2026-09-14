import { useTranslations } from 'next-intl';
import { Globe, LayoutTemplate, Target } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { CatalogStartingPoint, CatalogStartingPointKind } from './catalog-data';

const ICONS: Record<CatalogStartingPointKind, typeof Globe> = {
    work: LayoutTemplate,
    website: Globe,
    mission: Target,
};

/**
 * The Work, Website and Mission template kinds with a count each. Each links
 * to the existing template page for that kind; browsing and forking stay
 * there.
 */
export function StartingPointsRow({ points }: { points: readonly CatalogStartingPoint[] }) {
    const t = useTranslations('dashboard.catalogPage.startingPoints');
    return (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {points.map((point) => {
                const Icon = ICONS[point.kind];
                return (
                    <li key={point.kind}>
                        <Link
                            href={`${ROUTES.DASHBOARD_TEMPLATES}?kind=${point.kind}`}
                            data-catalog-card
                            data-testid="starting-point-card"
                            className="flex items-center gap-3 rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-4 py-3 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        >
                            <Icon className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
                            <span className="flex-1 text-sm font-medium text-text dark:text-text-dark">
                                {t(point.kind)}
                            </span>
                            <span className="text-sm tabular-nums text-text-secondary dark:text-text-secondary-dark">
                                {point.count}
                            </span>
                            <span className="text-xs text-primary">{t('browse')} →</span>
                        </Link>
                    </li>
                );
            })}
        </ul>
    );
}
