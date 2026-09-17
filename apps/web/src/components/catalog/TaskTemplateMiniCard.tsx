import { useTranslations } from 'next-intl';
import { ListChecks } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { CatalogTaskTemplateCard } from './catalog-data';

/**
 * A multi-step Task template on the catalogue index. `Use it` goes to the
 * existing Task templates page, which owns instantiation — the catalogue
 * never duplicates that flow.
 */
export function TaskTemplateMiniCard({ template }: { template: CatalogTaskTemplateCard }) {
    const t = useTranslations('dashboard.catalogPage.taskTemplates');
    return (
        <div
            data-testid="task-template-card"
            className="flex items-center gap-3 rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-4 py-3"
        >
            <ListChecks className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text dark:text-text-dark">
                    {template.name}
                </p>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('steps', { count: template.stepCount })}
                    {template.needApprovalCount > 0 && (
                        <> · {t('needApproval', { count: template.needApprovalCount })}</>
                    )}
                </p>
            </div>
            <Link
                href={ROUTES.DASHBOARD_TASK_TEMPLATES}
                data-catalog-card
                className="rounded-md border border-border dark:border-border-dark px-3 py-1 text-xs font-medium hover:bg-surface-secondary dark:hover:bg-white/9 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-label={t('useItAria', { name: template.name })}
            >
                {t('useIt')}
            </Link>
        </div>
    );
}
