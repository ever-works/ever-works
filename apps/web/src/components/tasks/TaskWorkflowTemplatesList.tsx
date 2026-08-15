'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { GitBranch, ShieldCheck, Trash2, Workflow } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { TaskTemplateRow } from '@/lib/api/task-templates.shared';
import { deleteTaskTemplateAction } from '@/app/actions/task-templates';

/**
 * Tasks upgrades — the user's own workflow Task Templates on
 * `/tasks/templates`, above the hand-curated catalog cards.
 *
 * These are the templates that actually expand into a task tree
 * (parent + one sub-task per step, dependencies as blockers): the
 * catalog below them is still the single-Task shape browser, so both
 * live on the page rather than one replacing the other.
 */
export function TaskWorkflowTemplatesList({
    templates,
    error = null,
}: {
    templates: TaskTemplateRow[];
    error?: string | null;
}) {
    const t = useTranslations('dashboard.tasksPage.templates');
    const router = useRouter();
    const [pendingId, setPendingId] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [actionError, setActionError] = useState<string | null>(null);

    const handleDelete = (template: TaskTemplateRow) => {
        if (!confirm(t('deleteConfirm', { name: template.name }))) return;
        setActionError(null);
        setPendingId(template.id);
        startTransition(() => {
            void (async () => {
                try {
                    await deleteTaskTemplateAction(template.id);
                    router.refresh();
                } catch (err) {
                    setActionError(err instanceof Error ? err.message : t('deleteError'));
                } finally {
                    setPendingId(null);
                }
            })();
        });
    };

    return (
        <section className="space-y-3" data-testid="task-workflow-templates">
            <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-text dark:text-text-dark flex items-center gap-2">
                    <Workflow className="w-4 h-4 text-text-muted" />
                    {t('workflowsSection')}
                </h2>
                <Link
                    href={ROUTES.DASHBOARD_TASK_NEW}
                    className="text-xs text-primary hover:underline"
                >
                    {t('useInNewTask')}
                </Link>
            </div>

            {(error || actionError) && (
                <p className="text-xs text-danger" role="alert">
                    {error ?? actionError}
                </p>
            )}

            {templates.length === 0 ? (
                <p className="text-xs text-text-muted">{t('workflowsEmpty')}</p>
            ) : (
                <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {templates.map((template) => (
                        <li
                            key={template.id}
                            data-testid="task-workflow-template-row"
                            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-4 space-y-2"
                        >
                            <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <h3 className="text-sm font-medium text-text dark:text-text-dark truncate">
                                        {template.name}
                                    </h3>
                                    <p className="text-[11px] font-mono text-text-muted">
                                        {t('stepCount', { count: template.steps.length })}
                                    </p>
                                </div>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className="text-danger shrink-0"
                                    disabled={pending && pendingId === template.id}
                                    onClick={() => handleDelete(template)}
                                    aria-label={t('delete')}
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                            </div>
                            {template.description && (
                                <p className="text-xs text-text-secondary dark:text-text-secondary-dark line-clamp-3">
                                    {template.description}
                                </p>
                            )}
                            <ol className="list-decimal pl-4 space-y-0.5">
                                {template.steps.map((step) => (
                                    <li
                                        key={step.id}
                                        className="text-[11px] text-text-muted dark:text-text-muted-dark"
                                    >
                                        {step.title}
                                        {step.requiresApproval && (
                                            <ShieldCheck
                                                className="inline-block w-3 h-3 ml-1 text-warning align-text-bottom"
                                                aria-label={t('requiresApproval')}
                                            />
                                        )}
                                        {step.agentTemplateSlug && (
                                            <span className="ml-1.5 font-mono text-[10px] text-text-muted">
                                                <GitBranch
                                                    className="inline-block w-3 h-3 mr-0.5 align-text-bottom"
                                                    aria-hidden
                                                />
                                                {step.agentTemplateSlug}
                                            </span>
                                        )}
                                    </li>
                                ))}
                            </ol>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
