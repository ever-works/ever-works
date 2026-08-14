import { getTranslations } from 'next-intl/server';
import { ListChecks, Zap } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';

/**
 * Task Triggers — tab strip shared by the Tasks list page and the
 * Triggers tab. Deliberately a tiny server component (plain links, no
 * client state) so adding future tabs (templates, schedules) stays a
 * one-line change and the Tasks page keeps server-rendering.
 */
export async function TasksTabsNav({ active }: { active: 'tasks' | 'triggers' }) {
    const t = await getTranslations('dashboard.taskTriggers.tabs');
    const tabs = [
        { key: 'tasks' as const, href: ROUTES.DASHBOARD_TASKS, label: t('tasks'), Icon: ListChecks },
        {
            key: 'triggers' as const,
            href: ROUTES.DASHBOARD_TASK_TRIGGERS,
            label: t('triggers'),
            Icon: Zap,
        },
    ];
    return (
        <nav
            data-testid="tasks-tabs-nav"
            className="mb-4 flex items-center gap-0.5 rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-0.5 w-fit"
        >
            {tabs.map(({ key, href, label, Icon }) => (
                <Link
                    key={key}
                    href={href}
                    aria-current={active === key ? 'page' : undefined}
                    className={cn(
                        'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all duration-150',
                        active === key
                            ? 'bg-card dark:bg-card-primary-dark text-text dark:text-text-dark shadow-sm'
                            : 'text-text-muted dark:text-text-muted-dark hover:text-text-secondary dark:hover:text-text-secondary-dark',
                    )}
                >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                </Link>
            ))}
        </nav>
    );
}
