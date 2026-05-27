'use client';

import { useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, ChevronLeft, ChevronRight } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { AgentScope, CreateAgentInput } from '@/lib/api/agents';
// PASS-4 review fix (CRITICAL): templates browser was a dead end —
// "Use template" routed to /agents/new?from=<slug> but the dialog
// never read searchParams. Pre-fill name + title from the fallback
// template catalog so the templates flow has an actual on-ramp into
// Agent creation.
import { listAstTemplates } from '@/lib/api/agent-templates';

type CreateAgentFn = (input: CreateAgentInput) => Promise<{ id: string }>;

export interface ScopeParentOption {
    id: string;
    label: string;
}

/**
 * Agents/Skills/Tasks PR #1017 — Phase 5. 2-step create form per
 * UX-DESIGN §10. Step 1 picks a scope (now including
 * Mission/Work/Idea — when the page passes the corresponding
 * catalog lists), step 2 collects a name + optional title.
 * Defaults the rest from CreateAgentDto so the server can fill in
 * the safe permissions baseline.
 */
export interface NewAgentDialogPinnedScope {
    scope: Exclude<AgentScope, 'tenant'>;
    missionId?: string;
    ideaId?: string;
    workId?: string;
    /** Optional parent name to show in step 2 instead of the bare scope. */
    parentLabel?: string;
}

export interface NewAgentDialogProps {
    createAgent: CreateAgentFn;
    /**
     * FU-3 — when set, the scope picker (step 1) is skipped and the
     * scope-bound ids are forwarded to `createAgent`. Used by the
     * `/missions/[id]/agents/new`, `/works/[id]/agents/new`, and
     * `/ideas/[id]/agents/new` routes so the user lands directly on
     * step 2 with the parent already chosen.
     */
    pinned?: NewAgentDialogPinnedScope;
    /** Catalogs surfaced for the scope-parent picker on step 1.
     *  Empty lists collapse the corresponding scope to a "no
     *  candidates yet" hint without breaking the flow. */
    missions?: ScopeParentOption[];
    works?: ScopeParentOption[];
    ideas?: ScopeParentOption[];
}

export function NewAgentDialog({
    createAgent,
    pinned,
    missions = [],
    works = [],
    ideas = [],
}: NewAgentDialogProps) {
    const t = useTranslations('dashboard.agentsPage.newDialog');
    const router = useRouter();
    const searchParams = useSearchParams();
    const [step, setStep] = useState<1 | 2>(pinned ? 2 : 1);
    const [scope, setScope] = useState<AgentScope>(pinned?.scope ?? 'tenant');
    const [parentId, setParentId] = useState<string>(
        pinned?.missionId ?? pinned?.workId ?? pinned?.ideaId ?? '',
    );
    const [name, setName] = useState('');
    const [title, setTitle] = useState('');
    const [templateSlug, setTemplateSlug] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    // PASS-4 review fix: pre-fill from ?from=<slug> when the user
    // clicked "Use template" on /agents/templates. We pre-populate
    // name + title and skip Step 1 so the user lands in step 2 with
    // the template's identity already filled in. The template body
    // (SOUL.md / AGENTS.md / HEARTBEAT.md / TOOLS.md / agent.yml)
    // gets pre-loaded by the future ADR-010 catalog merge — for now
    // we just carry the identity so the templates flow isn't a
    // dead end.
    useEffect(() => {
        const from = searchParams?.get('from');
        if (!from || templateSlug === from) return;
        void (async () => {
            try {
                const all = await listAstTemplates('agent');
                const entry = all.find((e) => e.slug === from);
                if (entry) {
                    setTemplateSlug(from);
                    if (!name) setName(entry.title);
                    if (!title && entry.description) setTitle(entry.description.slice(0, 80));
                    setStep(2);
                }
            } catch {
                // Best-effort — fall back to a blank form.
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams]);

    // Pre-fill from `?prompt=` (global `/new` page hands off the
    // user's free-text description as the Agent's name/title).
    useEffect(() => {
        const promptParam = searchParams?.get('prompt');
        if (!promptParam) return;
        const trimmed = promptParam.trim();
        if (!trimmed) return;
        const firstBreak = trimmed.indexOf('\n');
        const candidateName =
            firstBreak > 0 ? trimmed.slice(0, firstBreak).trim() : trimmed.slice(0, 80).trim();
        const candidateTitle =
            firstBreak > 0
                ? trimmed.slice(firstBreak + 1).trim().slice(0, 120)
                : trimmed.length > 80
                  ? trimmed.slice(0, 120)
                  : '';
        if (!name && candidateName) setName(candidateName);
        if (!title && candidateTitle) setTitle(candidateTitle);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams]);

    const scopeChoices: Array<{
        value: AgentScope;
        label: string;
        desc: string;
        disabled?: boolean;
        emptyHint?: string;
    }> = [
        { value: 'tenant', label: t('scopeTenantDesc'), desc: t('scopeTenantDesc') },
        {
            value: 'mission',
            label: t('scopeMissionDesc'),
            desc: t('scopeMissionDesc'),
            disabled: false,
            emptyHint: missions.length === 0 ? t('noMissions') : undefined,
        },
        {
            value: 'work',
            label: t('scopeWorkDesc'),
            desc: t('scopeWorkDesc'),
            disabled: false,
            emptyHint: works.length === 0 ? t('noWorks') : undefined,
        },
        {
            value: 'idea',
            label: t('scopeIdeaDesc'),
            desc: t('scopeIdeaDesc'),
            disabled: false,
            emptyHint: ideas.length === 0 ? t('noIdeas') : undefined,
        },
    ];

    const parentOptions =
        scope === 'mission' ? missions : scope === 'work' ? works : scope === 'idea' ? ideas : [];

    const canAdvance =
        scope === 'tenant' || (!!parentId && parentOptions.some((o) => o.id === parentId));

    const handleSubmit = () => {
        if (!name.trim()) return;
        if (scope !== 'tenant' && !parentId) {
            setError(t('parentRequired'));
            return;
        }
        setError(null);
        startTransition(() => {
            void (async () => {
                try {
                    const created = await createAgent({
                        scope,
                        name: name.trim(),
                        title: title.trim() || null,
                        // FU-3 — when the dialog is pinned to a parent
                        // entity, forward the matching id to the API.
                        missionId:
                            pinned?.missionId ?? (scope === 'mission' ? parentId : undefined),
                        workId: pinned?.workId ?? (scope === 'work' ? parentId : undefined),
                        ideaId: pinned?.ideaId ?? (scope === 'idea' ? parentId : undefined),
                    });
                    router.push(ROUTES.DASHBOARD_AGENT(created.id));
                } catch (err) {
                    setError(err instanceof Error ? err.message : 'Failed to create Agent');
                }
            })();
        });
    };

    return (
        <div className="max-w-xl mx-auto p-6">
            <div className="flex items-center gap-3 mb-6">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                    <Bot className="w-4 h-4 text-primary" />
                </div>
                <h1 className="text-xl font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h1>
            </div>

            {step === 1 && (
                <section>
                    <h2 className="text-sm font-medium text-text dark:text-text-dark mb-3">
                        {t('step1Title')}
                    </h2>
                    <ul className="space-y-2">
                        {scopeChoices.map((c) => (
                            <li key={c.value}>
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (c.disabled) return;
                                        setScope(c.value);
                                        if (c.value === 'tenant') setParentId('');
                                    }}
                                    disabled={c.disabled}
                                    className={`w-full text-left rounded-lg border p-3 transition-colors ${
                                        scope === c.value
                                            ? 'border-primary bg-primary/5'
                                            : 'border-border/60 dark:border-border-dark/60 hover:border-border dark:hover:border-border-dark'
                                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                                >
                                    <div className="text-sm font-medium text-text dark:text-text-dark capitalize">
                                        {c.value}
                                    </div>
                                    <div className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {c.desc}
                                        {c.disabled ? ' — coming soon' : ''}
                                    </div>
                                    {c.emptyHint && scope === c.value && (
                                        <div className="mt-1 text-xs text-warning">
                                            {c.emptyHint}
                                        </div>
                                    )}
                                </button>
                            </li>
                        ))}
                    </ul>

                    {scope !== 'tenant' && parentOptions.length > 0 && (
                        <div className="mt-4">
                            <label
                                htmlFor="agent-scope-parent"
                                className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1"
                            >
                                {t('parentLabel', { scope })}
                            </label>
                            <select
                                id="agent-scope-parent"
                                value={parentId}
                                onChange={(e) => setParentId(e.target.value)}
                                className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 text-sm text-text dark:text-text-dark"
                            >
                                <option value="">{t('parentPlaceholder')}</option>
                                {parentOptions.map((opt) => (
                                    <option key={opt.id} value={opt.id}>
                                        {opt.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}

                    <div className="flex items-center justify-end gap-2 mt-6">
                        <Button variant="ghost" size="sm" onClick={() => router.back()}>
                            {t('cancel')}
                        </Button>
                        <Button
                            size="sm"
                            onClick={() => setStep(2)}
                            disabled={!canAdvance}
                            className="gap-1.5"
                        >
                            {t('next')}
                            <ChevronRight className="w-3.5 h-3.5" />
                        </Button>
                    </div>
                </section>
            )}

            {step === 2 && (
                <section>
                    {pinned && (
                        <div className="mb-4 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-text-secondary dark:text-text-secondary-dark">
                            <span className="font-medium text-text dark:text-text-dark capitalize">
                                {pinned.scope}
                            </span>{' '}
                            scope
                            {pinned.parentLabel ? (
                                <>
                                    {' — '}
                                    <span className="font-medium text-text dark:text-text-dark">
                                        {pinned.parentLabel}
                                    </span>
                                </>
                            ) : null}
                        </div>
                    )}
                    {!pinned && scope !== 'tenant' && parentId && (
                        <div className="mb-4 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-text-secondary dark:text-text-secondary-dark">
                            <span className="font-medium text-text dark:text-text-dark capitalize">
                                {scope}
                            </span>{' '}
                            scope —{' '}
                            <span className="font-medium text-text dark:text-text-dark">
                                {parentOptions.find((o) => o.id === parentId)?.label}
                            </span>
                        </div>
                    )}
                    <h2 className="text-sm font-medium text-text dark:text-text-dark mb-3">
                        {t('step2Title')}
                    </h2>
                    <label className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1">
                        {t('nameLabel')}
                    </label>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t('namePlaceholder')}
                        className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 text-sm text-text dark:text-text-dark"
                        maxLength={120}
                        autoFocus
                    />
                    <input
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="Title (optional)"
                        className="w-full mt-2 rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 text-sm text-text dark:text-text-dark"
                        maxLength={120}
                    />
                    {error && (
                        <p className="text-xs text-danger mt-2" role="alert">
                            {error}
                        </p>
                    )}
                    <div className="flex items-center justify-between gap-2 mt-6">
                        {pinned ? (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => router.back()}
                                className="gap-1.5"
                            >
                                {t('cancel')}
                            </Button>
                        ) : (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setStep(1)}
                                className="gap-1.5"
                            >
                                <ChevronLeft className="w-3.5 h-3.5" />
                                {t('back')}
                            </Button>
                        )}
                        <Button size="sm" onClick={handleSubmit} disabled={pending || !name.trim()}>
                            {pending ? '…' : t('create')}
                        </Button>
                    </div>
                </section>
            )}
        </div>
    );
}
