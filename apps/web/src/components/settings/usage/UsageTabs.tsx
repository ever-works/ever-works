import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/lib/constants';
import { USAGE_TAB_COSTS, USAGE_TAB_OVERVIEW, type UsageTab } from '@/lib/api/usage-tabs.shared';

interface UsageTabsProps {
    active: UsageTab;
    children: React.ReactNode;
}

/**
 * Settings → Usage & Credits tab bar.
 *
 * Server component with plain links rather than client-side state: each
 * tab fetches a DIFFERENT set of endpoints, so a link means the page
 * only ever loads the panels it is about to render, and a `?tab=costs`
 * URL is shareable and server-rendered.
 *
 * The Overview tab is the default arm and its subtree is unchanged — the
 * existing page is wrapped, not rewritten.
 */
export async function UsageTabs({ active, children }: UsageTabsProps) {
    const t = await getTranslations('dashboard.settings.usage.tabs');

    const tabs: { id: UsageTab; label: string; href: string }[] = [
        {
            id: USAGE_TAB_OVERVIEW,
            label: t('overview'),
            href: ROUTES.DASHBOARD_USAGE,
        },
        {
            id: USAGE_TAB_COSTS,
            label: t('costs'),
            href: `${ROUTES.DASHBOARD_USAGE}?tab=${USAGE_TAB_COSTS}`,
        },
    ];

    return (
        <div className="space-y-6">
            <nav
                aria-label={t('label')}
                data-testid="usage-tabs"
                className="flex items-center gap-1 border-b border-border dark:border-border-dark"
            >
                {tabs.map((tab) => (
                    <Link
                        key={tab.id}
                        href={tab.href}
                        data-testid={`usage-tab-${tab.id}`}
                        aria-current={tab.id === active ? 'page' : undefined}
                        className={cn(
                            '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                            tab.id === active
                                ? 'border-primary text-text dark:text-text-dark'
                                : 'border-transparent text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark',
                        )}
                    >
                        {tab.label}
                    </Link>
                ))}
            </nav>
            {children}
        </div>
    );
}
