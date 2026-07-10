'use client';

import { useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import {
    Bot,
    Building2,
    ChevronLeft,
    ChevronRight,
    FolderClosed,
    Lightbulb,
    Sparkles,
    Target,
    type LucideIcon,
} from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SkillMarkdownEditor } from '@/components/skills/SkillMarkdownEditor';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Skill, SkillFrontmatter, SkillOwnerType } from '@/lib/api/skills';
import { listAstTemplates, type AstTemplateEntry } from '@/lib/api/agent-templates';

type CreateSkillFn = (input: {
    ownerType: SkillOwnerType;
    ownerId: string;
    title: string;
    description: string;
    instructionsMd: string;
    frontmatter?: SkillFrontmatter;
    slug?: string;
}) => Promise<Skill>;

/**
 * Wizard steps. `template` (optional) → `scope` → `details`. The
 * `template` step is skipped when no templates are available, so it
 * never shows empty. Mirrors NewAgentDialog (Agents/Skills/Tasks
 * PR #1017) so the two `/new` flows feel identical.
 */
type WizardStep = 'template' | 'scope' | 'details';

export interface SkillScopeParentOption {
    id: string;
    label: string;
}

export interface NewSkillDialogProps {
    createSkill: CreateSkillFn;
    /** Catalogs surfaced for the scope-parent picker on the scope step.
     *  Empty lists collapse the corresponding scope to a "no candidates
     *  yet" hint without breaking the flow. */
    missions?: SkillScopeParentOption[];
    works?: SkillScopeParentOption[];
    ideas?: SkillScopeParentOption[];
    agents?: SkillScopeParentOption[];
    /**
     * Optional skill-template catalog. When non-empty the wizard opens
     * on an optional template-pick step; picking one pre-fills title,
     * description, and the instructions body. Empty → the step is
     * skipped entirely so it never renders blank.
     */
    templates?: AstTemplateEntry[];
}

function defaultInstructions(title: string, description: string): string {
    return `# ${title}\n\n${description || '_Describe what this Skill teaches your Agent..._'}\n`;
}

export function NewSkillDialog({
    createSkill,
    missions = [],
    works = [],
    ideas = [],
    agents = [],
    templates = [],
}: NewSkillDialogProps) {
    const t = useTranslations('dashboard.skillsPage.newPage');
    const router = useRouter();
    const searchParams = useSearchParams();
    const [step, setStep] = useState<WizardStep>(templates.length > 0 ? 'template' : 'scope');
    const [scope, setScope] = useState<SkillOwnerType>('tenant');
    const [parentId, setParentId] = useState('');
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [instructionsMd, setInstructionsMd] = useState('');
    const [templateSlug, setTemplateSlug] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    // Pre-fill from `?from=<slug>` when the user clicked "Use template"
    // on /skills/templates. Mirrors the NewAgentDialog handler so the
    // templates browser is no longer a dead end for Skills. The slug is
    // only compared against the known catalog — never rendered — so no
    // sanitization is needed.
    useEffect(() => {
        const from = searchParams?.get('from');
        if (!from || templateSlug === from) return;
        void (async () => {
            try {
                const all = await listAstTemplates('skill');
                const entry = all.find((e) => e.slug === from);
                if (entry) {
                    setTemplateSlug(from);
                    setTitle((prev) => prev || entry.title);
                    setDescription((prev) => prev || entry.description);
                    if (entry.previewMd) {
                        setInstructionsMd((prev) => prev || entry.previewMd || '');
                    }
                }
            } catch {
                // Best-effort — fall back to a blank form.
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams]);

    const scopeChoices: Array<{
        value: SkillOwnerType;
        desc: string;
        icon: LucideIcon;
        /** Same per-concept tints the sidebar/PageHeader use for these entities. */
        iconClass: string;
        emptyHint?: string;
    }> = [
        {
            value: 'tenant',
            desc: t('scopeTenantDesc'),
            icon: Building2,
            iconClass: 'text-text-secondary dark:text-text-secondary-dark',
        },
        {
            value: 'mission',
            desc: t('scopeMissionDesc'),
            icon: Target,
            iconClass: 'text-concept-missions',
            emptyHint: missions.length === 0 ? t('noMissions') : undefined,
        },
        {
            value: 'work',
            desc: t('scopeWorkDesc'),
            icon: FolderClosed,
            iconClass: 'text-concept-works',
            emptyHint: works.length === 0 ? t('noWorks') : undefined,
        },
        {
            value: 'idea',
            desc: t('scopeIdeaDesc'),
            icon: Lightbulb,
            iconClass: 'text-concept-ideas',
            emptyHint: ideas.length === 0 ? t('noIdeas') : undefined,
        },
        {
            value: 'agent',
            desc: t('scopeAgentDesc'),
            icon: Bot,
            iconClass: 'text-concept-agents',
            emptyHint: agents.length === 0 ? t('noAgents') : undefined,
        },
    ];

    const parentOptions =
        scope === 'mission'
            ? missions
            : scope === 'work'
              ? works
              : scope === 'idea'
                ? ideas
                : scope === 'agent'
                  ? agents
                  : [];

    const canAdvance =
        scope === 'tenant' || (!!parentId && parentOptions.some((o) => o.id === parentId));

    // Optional template step. Picking a template pre-fills title +
    // description + body (without clobbering anything the user already
    // typed); "Start from scratch" passes null. Either way we advance
    // to the scope step.
    const handlePickTemplate = (tpl: AstTemplateEntry | null) => {
        if (tpl) {
            setTemplateSlug(tpl.slug);
            if (!title) setTitle(tpl.title);
            if (!description) setDescription(tpl.description);
            if (!instructionsMd && tpl.previewMd) setInstructionsMd(tpl.previewMd);
        }
        setStep('scope');
    };

    const handleSubmit = () => {
        const trimmedTitle = title.trim();
        if (!trimmedTitle) {
            setError(t('titleRequired'));
            return;
        }
        if (scope !== 'tenant' && !parentId) {
            setError(t('parentRequired'));
            return;
        }
        setError(null);
        startTransition(() => {
            void (async () => {
                try {
                    const trimmedDescription = description.trim();
                    const created = await createSkill({
                        ownerType: scope,
                        // Tenant ownerId is derived server-side from the
                        // auth cookie (createCustomSkillAction).
                        ownerId: scope === 'tenant' ? '' : parentId,
                        title: trimmedTitle,
                        description: trimmedDescription || `Custom Skill: ${trimmedTitle}`,
                        instructionsMd:
                            instructionsMd.trim() ||
                            defaultInstructions(trimmedTitle, trimmedDescription),
                    });
                    router.push(ROUTES.DASHBOARD_SKILL(created.id));
                } catch (err) {
                    setError(err instanceof Error ? err.message : t('createFailed'));
                }
            })();
        });
    };

    return (
        <div className="max-w-xl mx-auto p-6">
            <div className="flex items-center gap-3 mb-6">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-success/10 border border-success/20 flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-success" aria-hidden="true" />
                </div>
                <h1 className="text-lg font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h1>
            </div>

            {step === 'template' && (
                <section>
                    <h2 className="text-xs font-medium text-text dark:text-text-dark mb-3">
                        {t('templateStepTitle')}
                    </h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {templates.map((tpl) => (
                            <button
                                key={tpl.slug}
                                type="button"
                                onClick={() => handlePickTemplate(tpl)}
                                className="text-left rounded-lg border border-border/60 dark:border-border-dark/60 p-3 transition-colors hover:border-border-secondary dark:hover:border-border-secondary-dark hover:bg-surface-secondary/50 dark:hover:bg-surface-secondary-dark/50"
                                data-testid={`skill-template-step-${tpl.slug}`}
                            >
                                <div className="text-xs font-medium text-text dark:text-text-dark">
                                    {tpl.title}
                                </div>
                                <div className="mt-0.5 text-[11px] text-text-muted dark:text-text-muted-dark line-clamp-2">
                                    {tpl.description}
                                </div>
                            </button>
                        ))}
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-6">
                        <Button variant="ghost" size="sm" onClick={() => router.back()}>
                            {t('cancel')}
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => handlePickTemplate(null)}
                            className="gap-1.5"
                        >
                            {t('startFromScratch')}
                            <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                        </Button>
                    </div>
                </section>
            )}

            {step === 'scope' && (
                <section>
                    <h2 className="text-xs font-medium text-text dark:text-text-dark mb-3">
                        {t('scopeStepTitle')}
                    </h2>
                    <ul className="space-y-2">
                        {scopeChoices.map((c) => (
                            <li key={c.value}>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setScope(c.value);
                                        setParentId('');
                                    }}
                                    aria-pressed={scope === c.value}
                                    className={`w-full text-left rounded-lg border p-3 transition-colors ${
                                        scope === c.value
                                            ? 'border-border-secondary dark:border-border-secondary-dark bg-surface-secondary dark:bg-surface-secondary-dark'
                                            : 'border-border/60 dark:border-border-dark/60 hover:border-border dark:hover:border-border-dark'
                                    }`}
                                >
                                    <div className="flex items-start gap-2.5">
                                        <c.icon
                                            className={`w-4 h-4 mt-0.5 shrink-0 ${c.iconClass}`}
                                            aria-hidden="true"
                                        />
                                        <div className="min-w-0">
                                            <div className="text-xs font-medium text-text dark:text-text-dark capitalize">
                                                {c.value === 'tenant'
                                                    ? t('scopeTenantLabel')
                                                    : c.value}
                                            </div>
                                            <div className="text-[11px] text-text-muted dark:text-text-muted-dark">
                                                {c.desc}
                                            </div>
                                            {c.emptyHint && scope === c.value && (
                                                <div className="mt-1 text-[11px] text-warning">
                                                    {c.emptyHint}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </button>
                            </li>
                        ))}
                    </ul>

                    {scope !== 'tenant' && parentOptions.length > 0 && (
                        <div className="mt-4">
                            <label
                                htmlFor="skill-scope-parent"
                                className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1"
                            >
                                {t('parentLabel', { scope })}
                            </label>
                            <Select
                                id="skill-scope-parent"
                                size="xs"
                                value={parentId}
                                onValueChange={setParentId}
                                placeholder={t('parentPlaceholder')}
                                data-testid="skill-scope-parent"
                            >
                                {parentOptions.map((opt) => (
                                    <option key={opt.id} value={opt.id}>
                                        {opt.label}
                                    </option>
                                ))}
                            </Select>
                        </div>
                    )}

                    <div className="flex items-center justify-between gap-2 mt-6">
                        {templates.length > 0 ? (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setStep('template')}
                                className="gap-1.5"
                            >
                                <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
                                {t('back')}
                            </Button>
                        ) : (
                            <Button variant="ghost" size="sm" onClick={() => router.back()}>
                                {t('cancel')}
                            </Button>
                        )}
                        {/* When a non-tenant scope has no valid parent, Next
                            is disabled; surface WHY so the flow isn't a
                            silent dead-end. Workspace scope always advances. */}
                        <div className="flex flex-col items-end gap-1">
                            {!canAdvance && (
                                <p className="text-[11px] text-text-muted dark:text-text-muted-dark text-right">
                                    {t('pickParentHint', { scope })}
                                </p>
                            )}
                            <Button
                                size="sm"
                                onClick={() => setStep('details')}
                                disabled={!canAdvance}
                                title={canAdvance ? undefined : t('nextDisabledReason')}
                                className="gap-1.5"
                            >
                                {t('next')}
                                <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                            </Button>
                        </div>
                    </div>
                </section>
            )}

            {step === 'details' && (
                <section>
                    {scope !== 'tenant' && parentId && (
                        <div className="mb-4 rounded-md border border-border/60 dark:border-border-dark/60 bg-surface-secondary dark:bg-surface-secondary-dark px-3 py-2 text-[11px] text-text-secondary dark:text-text-secondary-dark">
                            <span className="font-medium text-text dark:text-text-dark capitalize">
                                {scope}
                            </span>{' '}
                            {t('scopeSuffix')}{' '}
                            <span className="font-medium text-text dark:text-text-dark">
                                {parentOptions.find((o) => o.id === parentId)?.label}
                            </span>
                        </div>
                    )}
                    <h2 className="text-xs font-medium text-text dark:text-text-dark mb-3">
                        {t('detailsStepTitle')}
                    </h2>
                    <div className="space-y-3">
                        <Input
                            id="new-skill-title"
                            variant="form"
                            label={t('titleLabel')}
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder={t('titlePlaceholder')}
                            className="h-8 px-2.5 text-xs"
                            maxLength={120}
                            autoFocus
                        />
                        <Input
                            id="new-skill-description"
                            variant="form"
                            label={t('descriptionLabel')}
                            type="text"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder={t('descriptionPlaceholder')}
                            className="h-8 px-2.5 text-xs"
                            maxLength={240}
                        />
                        <div>
                            <SkillMarkdownEditor
                                value={instructionsMd}
                                onChange={(e) => setInstructionsMd(e.target.value)}
                                rows={10}
                                placeholder={t('instructionsPlaceholder')}
                                idPrefix="new-skill-body"
                                textareaId="new-skill-instructions"
                                textareaClassName="px-2.5 py-2 text-xs font-mono resize-y leading-relaxed"
                                label={
                                    <label
                                        htmlFor="new-skill-instructions"
                                        className="text-sm font-medium text-text dark:text-text-dark"
                                    >
                                        {t('instructionsLabel')}
                                    </label>
                                }
                            />
                            <p className="mt-1.5 text-xs text-text-muted dark:text-text-muted-dark">
                                {t('instructionsHint')}
                            </p>
                        </div>
                    </div>
                    {error && (
                        <p className="text-xs text-danger mt-2" role="alert">
                            {error}
                        </p>
                    )}
                    <div className="flex items-center justify-between gap-2 mt-6">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setStep('scope')}
                            className="gap-1.5"
                        >
                            <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
                            {t('back')}
                        </Button>
                        <Button size="sm" onClick={handleSubmit} disabled={pending || !title.trim()}>
                            {pending ? t('creating') : t('create')}
                        </Button>
                    </div>
                </section>
            )}
        </div>
    );
}
