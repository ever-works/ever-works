'use client';

import { useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, ListChecks } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import type { TaskAcceptanceCheck } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils/cn';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Task, TaskPriority } from '@/lib/api/tasks';
import { TASK_PRIORITY_PRESENTATION } from '@/lib/task-priorities/catalog';
import { ChecksEditor } from './ChecksEditor';
import { WorkSelect } from './WorkSelect';
// PASS-4 review fix (CRITICAL): templates dead end. Pre-fill from
// ?from=<slug> when the user clicked "Use template" on /tasks/templates.
import { listAstTemplates } from '@/lib/api/agent-templates';
// Tasks upgrades — workflow Task Templates (parent + steps).
import type { TaskTemplateRow } from '@/lib/api/task-templates.shared';
import {
    instantiateTaskTemplateAction,
    listTaskTemplatesAction,
} from '@/app/actions/task-templates';
// Security: sanitizers strip control characters from untrusted URL-derived
// input (mirrors the pattern used in NewAgentDialog.tsx).
import { sanitizeName, sanitizePrompt } from '@/lib/utils/sanitize';

type CreateTaskFn = (input: {
    title: string;
    description?: string | null;
    priority?: TaskPriority;
    labels?: string[];
    missionId?: string | null;
    ideaId?: string | null;
    workId?: string | null;
    acceptanceChecks?: TaskAcceptanceCheck[] | null;
    maxGateAttempts?: number | null;
}) => Promise<Task>;

/**
 * Agents/Skills/Tasks PR #1017 — Phase 12.7. v1 form. Title +
 * description + priority + labels. Scope, assignees, parent, and
 * recurring chips land in a follow-up sub-tick (component is the
 * primitive, the surrounding context wires the picker UIs).
 */
/** Priority rows in display order (most urgent first), paired with their
 *  message keys so the labels stay translated. */
const PRIORITY_OPTIONS: ReadonlyArray<{
    value: TaskPriority;
    labelKey: 'priorityP0' | 'priorityP1' | 'priorityP2' | 'priorityP3' | 'priorityP4';
}> = [
    { value: 'p0', labelKey: 'priorityP0' },
    { value: 'p1', labelKey: 'priorityP1' },
    { value: 'p2', labelKey: 'priorityP2' },
    { value: 'p3', labelKey: 'priorityP3' },
    { value: 'p4', labelKey: 'priorityP4' },
];

/**
 * Slugify the task title into a label: lowercase, spaces (and other
 * non-alphanumerics) collapse to a single hyphen, with no leading or
 * trailing hyphens. So "Redesign onboarding flow" → "redesign-onboarding-flow".
 */
/**
 * The API caps each label at 80 characters (`@MaxLength(80, { each: true })`
 * on both the create and update DTOs), while the Title input allows 200. Since
 * the Labels field mirrors the slugified title until the user edits it, ANY
 * title longer than 80 characters derived an over-length label and made the
 * Task uncreatable — with no hint that the *label* was the problem, because the
 * server action surfaces the rejection as a generic
 * "An error occurred in the Server Components render" alert.
 *
 * Verified on production before the fix: an 88-character title produced an
 * 88-character label, Create stayed on /tasks/new, and no row was written.
 *
 * Truncating on a hyphen boundary keeps the label readable rather than cutting
 * mid-word, and the trailing-hyphen strip runs afterwards so a boundary cut
 * cannot leave "foo-bar-" behind.
 */
const MAX_LABEL_LENGTH = 80;

function slugifyTitle(title: string): string {
    const slug = title
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

    if (slug.length <= MAX_LABEL_LENGTH) return slug;

    const cut = slug.slice(0, MAX_LABEL_LENGTH);
    const lastBoundary = cut.lastIndexOf('-');
    // Only prefer the hyphen boundary when it does not throw most of the label
    // away — a title whose first "word" is itself longer than the cap should
    // still yield a usable label rather than an empty string.
    const trimmed = lastBoundary > MAX_LABEL_LENGTH / 2 ? cut.slice(0, lastBoundary) : cut;
    return trimmed.replace(/-+$/g, '');
}

/** "Blank task" vs "From template" — the two shapes this form creates. */
type CreationMode = 'blank' | 'template';

export function NewTaskForm({ createTask }: { createTask: CreateTaskFn }) {
    const t = useTranslations('dashboard.tasksPage.newDialog');
    const router = useRouter();
    const searchParams = useSearchParams();
    // Tasks upgrades — workflow templates expand into a parent Task plus
    // one sub-task per step, so the template path posts to a different
    // endpoint (`/task-templates/:id/instantiate`) than the blank path.
    const [mode, setMode] = useState<CreationMode>('blank');
    const [templates, setTemplates] = useState<TaskTemplateRow[]>([]);
    const [templatesLoaded, setTemplatesLoaded] = useState(false);
    const [templatesError, setTemplatesError] = useState<string | null>(null);
    const [workflowTemplateId, setWorkflowTemplateId] = useState<string>('');
    const [branchName, setBranchName] = useState('');
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [priority, setPriority] = useState<TaskPriority>('p3');
    const [labelsRaw, setLabelsRaw] = useState('');
    // Once the user edits the Labels field (or a template/URL pre-fills it) we
    // stop auto-deriving labels from the title so we never clobber their input.
    const [labelsTouched, setLabelsTouched] = useState(false);
    const [templateSlug, setTemplateSlug] = useState<string | null>(null);
    // Security: track whether the form was pre-filled from a URL param so we
    // can show a visible notice to the user (guards against phishing deep-links
    // that silently inject content into the form before submission).
    const [preFillSource, setPreFillSource] = useState<'prompt' | 'template' | null>(null);
    // Quality gates (Wave 3 M6) — optional acceptance-checks declaration.
    const [checksOpen, setChecksOpen] = useState(false);
    const [checks, setChecks] = useState<TaskAcceptanceCheck[]>([]);
    const [maxGateAttempts, setMaxGateAttempts] = useState<string>('inherit');
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    const workId = searchParams?.get('workId') || null;
    const missionId = searchParams?.get('missionId') || null;
    const ideaId = searchParams?.get('ideaId') || null;
    const scopeCount = [workId, missionId, ideaId].filter(Boolean).length;
    // The Work picker is the source of truth for `workId`, seeded from
    // `?workId=` when the user arrived from a Work's Tasks tab. Without a
    // picker the only way to get a Work-scoped Task was that query param,
    // which left every Task created from /tasks or /new permanently
    // unable to take attachments.
    const [workChoice, setWorkChoice] = useState<string>(workId ?? '');
    const scopeKey =
        scopeCount === 1
            ? workId
                ? ('workScopedTask' as const)
                : missionId
                  ? ('missionScopedTask' as const)
                  : ('ideaScopedTask' as const)
            : null;

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
                    // Security: show a visible pre-fill notice so users
                    // notice form content was loaded from a URL parameter
                    // before they submit.
                    setPreFillSource('template');
                    if (!title) setTitle(entry.title);
                    if (!description && entry.description) setDescription(entry.description);
                    if (!labelsRaw && entry.tags && entry.tags.length > 0) {
                        setLabelsTouched(true);
                        setLabelsRaw(entry.tags.join(', '));
                    }
                }
            } catch {
                // Best-effort.
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams]);

    // Pre-fill from `?prompt=` — supports direct deep-link navigation
    // to `/tasks/new?prompt=…` (e.g. from external integrations or
    // callers that still want to pre-populate the form via URL). Note:
    // the global `/new` page no longer passes `?prompt=` for the Task
    // chip; it sends the prompt through the chat channel instead and
    // routes here without a query string. This effect is a no-op on
    // that path and only fires when something explicitly puts a
    // `prompt` param in the URL. The first line becomes the title and
    // the remainder seeds the description, so a single-line prompt
    // still lands cleanly without an empty description block.
    useEffect(() => {
        const promptParam = searchParams?.get('prompt');
        if (!promptParam) return;
        const trimmed = promptParam.trim();
        if (!trimmed) return;
        const firstBreak = trimmed.indexOf('\n');
        const rawTitle =
            firstBreak > 0 ? trimmed.slice(0, firstBreak).trim() : trimmed.slice(0, 120).trim();
        const rawDescription =
            firstBreak > 0
                ? trimmed.slice(firstBreak + 1).trim()
                : trimmed.length > 120
                  ? trimmed
                  : '';
        // Security: the `?prompt=` query param is untrusted (e.g. a shared
        // phishing deep-link). Strip control characters before pre-populating
        // the form. sanitizeName removes newlines + control chars from the
        // title; sanitizePrompt preserves intentional newlines in the
        // description but strips hidden control characters. Legitimate
        // plain-text prompts pass through unchanged.
        const candidateTitle = sanitizeName(rawTitle, 120);
        const candidateDescription = sanitizePrompt(rawDescription, 5000);
        if (!title && candidateTitle) setTitle(candidateTitle);
        if (!description && candidateDescription) setDescription(candidateDescription);
        if (candidateTitle || candidateDescription) setPreFillSource('prompt');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams]);

    // Workflow templates load on first switch into template mode — the
    // blank path never pays for the round-trip. The list endpoint seeds
    // the default "Compound Engineering Workflow" server-side, so a
    // first-time user still sees one.
    useEffect(() => {
        if (mode !== 'template' || templatesLoaded) return;
        void (async () => {
            try {
                const rows = await listTaskTemplatesAction();
                setTemplates(rows);
                setWorkflowTemplateId((prev) => prev || (rows[0]?.id ?? ''));
                setTemplatesError(null);
            } catch (err) {
                setTemplatesError(err instanceof Error ? err.message : t('templatesLoadError'));
            } finally {
                setTemplatesLoaded(true);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, templatesLoaded]);

    const selectedTemplate = templates.find((row) => row.id === workflowTemplateId) ?? null;

    // Until the field is touched, the Labels input mirrors the slugified
    // title — auto-filling directly as the user types (spaces become "-").
    const labelsValue = labelsTouched ? labelsRaw : slugifyTitle(title);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim()) return;
        setError(null);
        if (mode === 'template') {
            if (!selectedTemplate) {
                setError(t('templateRequired'));
                return;
            }
            startTransition(() => {
                void (async () => {
                    try {
                        const { parentTask } = await instantiateTaskTemplateAction(
                            selectedTemplate.id,
                            {
                                title: title.trim(),
                                description: description.trim() || null,
                                workId: workChoice || null,
                                missionId: scopeCount === 1 ? missionId : null,
                                ideaId: scopeCount === 1 ? ideaId : null,
                                branchName: branchName.trim() || null,
                            },
                        );
                        router.push(ROUTES.DASHBOARD_TASK(parentTask.id));
                    } catch (err) {
                        setError(err instanceof Error ? err.message : t('createError'));
                    }
                })();
            });
            return;
        }
        startTransition(() => {
            void (async () => {
                try {
                    const labels = labelsValue
                        .split(',')
                        .map((l) => l.trim())
                        .filter(Boolean);
                    const task = await createTask({
                        title: title.trim(),
                        description: description.trim() || null,
                        priority,
                        labels: labels.length ? labels : undefined,
                        workId: workChoice || null,
                        missionId: scopeCount === 1 ? missionId : null,
                        ideaId: scopeCount === 1 ? ideaId : null,
                        // Quality gates — only declared rows with a command
                        // count; empty declaration = inherit Work defaults.
                        acceptanceChecks: (() => {
                            const rows = checks.filter((c) => c.command.trim().length > 0);
                            return rows.length > 0 ? rows : undefined;
                        })(),
                        maxGateAttempts:
                            maxGateAttempts === 'inherit'
                                ? undefined
                                : parseInt(maxGateAttempts, 10),
                    });
                    router.push(ROUTES.DASHBOARD_TASK(task.id));
                } catch (err) {
                    setError(err instanceof Error ? err.message : t('createError'));
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
                <div className="min-w-0">
                    <h1 className="text-xl font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h1>
                    {scopeKey && (
                        <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5">
                            {t(scopeKey)}
                        </p>
                    )}
                </div>
            </div>
            {/* Security: visible notice when the form is pre-filled from a URL
                parameter so users notice potentially attacker-crafted content
                before submitting. */}
            {preFillSource === 'prompt' && (
                <div className="mb-4 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-text-secondary dark:text-text-secondary-dark">
                    {t('prefillPromptNotice')}
                </div>
            )}
            {preFillSource === 'template' && templateSlug && (
                <div className="mb-4 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-text-secondary dark:text-text-secondary-dark">
                    {t.rich('prefillTemplateNotice', {
                        slug: templateSlug,
                        name: (chunks) => (
                            <span className="font-medium text-text dark:text-text-dark">
                                {chunks}
                            </span>
                        ),
                    })}
                </div>
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
                {/* Tasks upgrades — blank Task vs workflow template. */}
                <div
                    role="radiogroup"
                    aria-label={t('modeLabel')}
                    className="flex items-center gap-1.5"
                >
                    {(['blank', 'template'] as CreationMode[]).map((value) => (
                        <button
                            key={value}
                            type="button"
                            role="radio"
                            aria-checked={mode === value}
                            onClick={() => setMode(value)}
                            data-testid={`new-task-mode-${value}`}
                            className={cn(
                                'px-3 py-1.5 text-xs font-medium rounded border transition-colors',
                                mode === value
                                    ? 'border-primary bg-primary/10 text-primary'
                                    : 'border-border/60 dark:border-border-dark/60 text-text-secondary hover:text-text dark:hover:text-text-dark',
                            )}
                        >
                            {value === 'blank' ? t('modeBlank') : t('modeTemplate')}
                        </button>
                    ))}
                </div>

                {mode === 'template' && (
                    <div className="space-y-3 rounded-md border border-border/60 dark:border-border-dark/60 p-3">
                        <div>
                            <label className="block text-xs text-text-secondary mb-1">
                                {t('template')}
                            </label>
                            <Select
                                value={workflowTemplateId}
                                onValueChange={setWorkflowTemplateId}
                                disabled={pending || templates.length === 0}
                                size="xs"
                                data-testid="new-task-template"
                            >
                                {templates.length === 0 ? (
                                    <option value="">{t('templatesEmpty')}</option>
                                ) : (
                                    templates.map((row) => (
                                        <option key={row.id} value={row.id}>
                                            {t('templateOption', {
                                                name: row.name,
                                                steps: row.steps.length,
                                            })}
                                        </option>
                                    ))
                                )}
                            </Select>
                            {templatesError && (
                                <p className="mt-1 text-[11px] text-danger" role="alert">
                                    {templatesError}
                                </p>
                            )}
                        </div>
                        <div>
                            <label className="block text-xs text-text-secondary mb-1">
                                {t('branchName')}
                            </label>
                            <input
                                type="text"
                                value={branchName}
                                onChange={(e) => setBranchName(e.target.value)}
                                placeholder={t('branchNamePlaceholder')}
                                maxLength={200}
                                data-testid="new-task-branch-name"
                                className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 text-sm font-mono text-text dark:text-text-dark"
                            />
                        </div>
                        {selectedTemplate && (
                            <div data-testid="new-task-template-preview">
                                <p className="text-[11px] font-medium text-text-secondary dark:text-text-secondary-dark mb-1">
                                    {t('willCreate', { steps: selectedTemplate.steps.length })}
                                </p>
                                <ol className="list-decimal pl-4 space-y-0.5">
                                    {selectedTemplate.steps.map((step) => (
                                        <li
                                            key={step.id}
                                            className="text-[11px] text-text-muted dark:text-text-muted-dark"
                                        >
                                            {step.title}
                                            {step.requiresApproval && (
                                                <span className="ml-1.5 text-[10px] uppercase tracking-wide text-warning">
                                                    {t('stepApproval')}
                                                </span>
                                            )}
                                        </li>
                                    ))}
                                </ol>
                            </div>
                        )}
                    </div>
                )}
                <div>
                    <label className="block text-xs text-text-secondary mb-1">
                        {mode === 'template' ? t('featureName') : t('name')}
                    </label>
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
                        {mode === 'template' ? t('featureDescription') : t('description')}
                    </label>
                    <textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        rows={5}
                        placeholder={t('descriptionPlaceholder')}
                        className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-3 text-sm text-text dark:text-text-dark"
                    />
                </div>
                <div>
                    <label className="block text-xs text-text-secondary mb-1">{t('work')}</label>
                    <WorkSelect
                        value={workChoice}
                        onValueChange={setWorkChoice}
                        disabled={pending}
                        noneLabel={t('workNone')}
                        placeholder={t('workPlaceholder')}
                        testId="new-task-work"
                    />
                    <p className="mt-1 text-[11px] text-text-muted dark:text-text-muted-dark">
                        {t('workHint')}
                    </p>
                </div>
                {/* Priority / labels / acceptance checks are blank-task
                    controls: a template instantiation takes its priority
                    and labels from the template itself. */}
                {mode === 'blank' && (
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs text-text-secondary mb-1">
                                {t('priority')}
                            </label>
                            <Select
                                value={priority}
                                onValueChange={(value) => setPriority(value as TaskPriority)}
                                disabled={pending}
                                size="xs"
                                data-testid="new-task-priority"
                            >
                                {PRIORITY_OPTIONS.map(({ value, labelKey }) => (
                                    <option
                                        key={value}
                                        value={value}
                                        data-dot={TASK_PRIORITY_PRESENTATION[value].dot}
                                    >
                                        {t(labelKey)}
                                    </option>
                                ))}
                            </Select>
                        </div>
                        <div>
                            <label className="block text-xs text-text-secondary mb-1">
                                {t('labels')}
                            </label>
                            <input
                                type="text"
                                value={labelsValue}
                                onChange={(e) => {
                                    setLabelsTouched(true);
                                    setLabelsRaw(e.target.value);
                                }}
                                placeholder={t('labelsPlaceholder')}
                                className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 text-sm text-text dark:text-text-dark"
                            />
                        </div>
                    </div>
                )}
                {/* Quality gates (Wave 3 M6) — collapsible acceptance-checks
                    declaration. Left empty, the Task inherits the Work's
                    checkDefaults untouched. */}
                {mode === 'blank' && (
                    <div className="rounded-md border border-border/60 dark:border-border-dark/60">
                        <button
                            type="button"
                            onClick={() => setChecksOpen((v) => !v)}
                            aria-expanded={checksOpen}
                            className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark"
                            data-testid="new-task-checks-toggle"
                        >
                            {checksOpen ? (
                                <ChevronDown className="w-3.5 h-3.5" />
                            ) : (
                                <ChevronRight className="w-3.5 h-3.5" />
                            )}
                            {t('acceptanceChecks')}
                            {checks.length > 0 && (
                                <span className="ml-1 text-[10px] font-mono text-text-muted">
                                    ({checks.length})
                                </span>
                            )}
                        </button>
                        {checksOpen && (
                            <div className="px-3 pb-3 space-y-3">
                                <p className="text-[11px] text-text-muted dark:text-text-muted-dark">
                                    {t('acceptanceChecksHint')}
                                </p>
                                <ChecksEditor
                                    value={checks}
                                    onChange={setChecks}
                                    disabled={pending}
                                    testIdPrefix="new-task-checks"
                                />
                                <label className="flex items-center gap-2 text-xs text-text-secondary dark:text-text-secondary-dark">
                                    {t('maxGateAttempts')}
                                    <Select
                                        value={maxGateAttempts}
                                        onValueChange={setMaxGateAttempts}
                                        disabled={pending}
                                        size="sm"
                                        data-testid="new-task-max-gate-attempts"
                                    >
                                        <option value="inherit">
                                            {t('maxGateAttemptsInherit')}
                                        </option>
                                        {[1, 2, 3, 4, 5].map((n) => (
                                            <option key={n} value={String(n)}>
                                                {n}
                                            </option>
                                        ))}
                                    </Select>
                                </label>
                            </div>
                        )}
                    </div>
                )}
                {error && (
                    <p className="text-xs text-danger" role="alert">
                        {error}
                    </p>
                )}
                <div className="flex items-center justify-end gap-2">
                    <Button type="button" variant="ghost" size="sm" onClick={() => router.back()}>
                        {t('cancel')}
                    </Button>
                    <Button
                        type="submit"
                        size="sm"
                        disabled={
                            pending || !title.trim() || (mode === 'template' && !selectedTemplate)
                        }
                    >
                        {pending
                            ? '…'
                            : mode === 'template'
                              ? t('createFromTemplate')
                              : t('create')}
                    </Button>
                </div>
            </form>
        </div>
    );
}
