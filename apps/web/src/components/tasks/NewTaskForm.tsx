'use client';

import { useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { ListChecks } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Task, TaskPriority } from '@/lib/api/tasks';
// PASS-4 review fix (CRITICAL): templates dead end. Pre-fill from
// ?from=<slug> when the user clicked "Use template" on /tasks/templates.
import { listAstTemplates } from '@/lib/api/agent-templates';

type CreateTaskFn = (input: {
    title: string;
    description?: string | null;
    priority?: TaskPriority;
    labels?: string[];
}) => Promise<Task>;

/**
 * Agents/Skills/Tasks PR #1017 — Phase 12.7. v1 form. Title +
 * description + priority + labels. Scope, assignees, parent, and
 * recurring chips land in a follow-up sub-tick (component is the
 * primitive, the surrounding context wires the picker UIs).
 */
export function NewTaskForm({ createTask }: { createTask: CreateTaskFn }) {
    const t = useTranslations('dashboard.tasksPage.newDialog');
    const router = useRouter();
    const searchParams = useSearchParams();
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [priority, setPriority] = useState<TaskPriority>('p3');
    const [labelsRaw, setLabelsRaw] = useState('');
    const [templateSlug, setTemplateSlug] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    // PASS-4 fix: read ?from=<slug> and pre-fill title + description
    // + labels (tags carry over from the template entry). Without
    // this the "Use template" button on /tasks/templates landed on
    // a blank form.
    useEffect(() => {
        const from = searchParams?.get('from');
        if (!from || templateSlug === from) return;
        void (async () => {
            try {
                const all = await listAstTemplates('task');
                const entry = all.find((e) => e.slug === from);
                if (entry) {
                    setTemplateSlug(from);
                    if (!title) setTitle(entry.title);
                    if (!description && entry.description) setDescription(entry.description);
                    if (!labelsRaw && entry.tags && entry.tags.length > 0) {
                        setLabelsRaw(entry.tags.join(', '));
                    }
                }
            } catch {
                // Best-effort.
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams]);

    // Pre-fill from `?prompt=` so the global `/new` page can hand off
    // the user's free-text description into the Task form's title /
    // description fields. The first line becomes the title and the
    // remainder seeds the description, so a single-line prompt still
    // lands cleanly without an empty description block.
    useEffect(() => {
        const promptParam = searchParams?.get('prompt');
        if (!promptParam) return;
        const trimmed = promptParam.trim();
        if (!trimmed) return;
        const firstBreak = trimmed.indexOf('\n');
        const candidateTitle =
            firstBreak > 0 ? trimmed.slice(0, firstBreak).trim() : trimmed.slice(0, 120).trim();
        const candidateDescription =
            firstBreak > 0
                ? trimmed.slice(firstBreak + 1).trim()
                : trimmed.length > 120
                  ? trimmed
                  : '';
        if (!title && candidateTitle) setTitle(candidateTitle);
        if (!description && candidateDescription) setDescription(candidateDescription);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim()) return;
        setError(null);
        startTransition(() => {
            void (async () => {
                try {
                    const labels = labelsRaw
                        .split(',')
                        .map((l) => l.trim())
                        .filter(Boolean);
                    const task = await createTask({
                        title: title.trim(),
                        description: description.trim() || null,
                        priority,
                        labels: labels.length ? labels : undefined,
                    });
                    router.push(ROUTES.DASHBOARD_TASK(task.id));
                } catch (err) {
                    setError(err instanceof Error ? err.message : 'Failed to create Task');
                }
            })();
        });
    };

    return (
        <div className="max-w-xl mx-auto p-6">
            <div className="flex items-center gap-3 mb-6">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-info/10 border border-info/20 flex items-center justify-center">
                    <ListChecks className="w-4 h-4 text-info" />
                </div>
                <h1 className="text-xl font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h1>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                    <label className="block text-xs text-text-secondary mb-1">{t('name')}</label>
                    <input
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder={t('namePlaceholder')}
                        maxLength={200}
                        autoFocus
                        className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 text-sm text-text dark:text-text-dark"
                    />
                </div>
                <div>
                    <label className="block text-xs text-text-secondary mb-1">
                        {t('description')}
                    </label>
                    <textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        rows={5}
                        placeholder={t('descriptionPlaceholder')}
                        className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-3 text-sm text-text dark:text-text-dark"
                    />
                </div>
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-xs text-text-secondary mb-1">
                            {t('priority')}
                        </label>
                        <select
                            value={priority}
                            onChange={(e) => setPriority(e.target.value as TaskPriority)}
                            className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 text-sm text-text dark:text-text-dark"
                        >
                            <option value="p0">P0 — urgent</option>
                            <option value="p1">P1</option>
                            <option value="p2">P2</option>
                            <option value="p3">P3 — default</option>
                            <option value="p4">P4 — low</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-xs text-text-secondary mb-1">
                            {t('labels')}
                        </label>
                        <input
                            type="text"
                            value={labelsRaw}
                            onChange={(e) => setLabelsRaw(e.target.value)}
                            placeholder={t('labelsPlaceholder')}
                            className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 text-sm text-text dark:text-text-dark"
                        />
                    </div>
                </div>
                {error && (
                    <p className="text-xs text-danger" role="alert">
                        {error}
                    </p>
                )}
                <div className="flex items-center justify-end gap-2">
                    <Button type="button" variant="ghost" size="sm" onClick={() => router.back()}>
                        {t('cancel')}
                    </Button>
                    <Button type="submit" size="sm" disabled={pending || !title.trim()}>
                        {pending ? '…' : t('create')}
                    </Button>
                </div>
            </form>
        </div>
    );
}
