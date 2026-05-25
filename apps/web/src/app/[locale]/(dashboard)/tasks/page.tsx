import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ListChecks } from 'lucide-react';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.tasksPage');
    return { title: t('title') };
}

/**
 * Agents/Skills/Tasks PR #1017 — Phase 5 placeholder so the
 * sidebar nav route resolves. Real Tasks UI lands in Phase 12.
 */
export default async function TasksPage() {
    const t = await getTranslations('dashboard.tasksPage');
    return (
        <div className="w-full overflow-auto p-6 max-w-screen-2xl mx-auto">
            <div className="flex items-start gap-3 mb-6">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-info/10 border border-info/20 flex items-center justify-center">
                    <ListChecks className="w-4 h-4 text-info" />
                </div>
                <div>
                    <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h1>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1 max-w-2xl">
                        {t('subtitle')}
                    </p>
                </div>
            </div>
            <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-6">
                <p className="text-sm text-text dark:text-text-dark">{t('empty.title')}</p>
                <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1 max-w-2xl">
                    {t('empty.subtitle')}
                </p>
            </div>
        </div>
    );
}
