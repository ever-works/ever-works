'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { AgentScope, CreateAgentInput } from '@/lib/api/agents';

type CreateAgentFn = (input: CreateAgentInput) => Promise<{ id: string }>;

/**
 * Agents/Skills/Tasks PR #1017 — Phase 5. 2-step create form per
 * UX-DESIGN §10. Step 1 picks a scope, step 2 collects a name +
 * optional title. Defaults the rest from CreateAgentDto so the
 * server can fill in the safe permissions baseline.
 *
 * For Mission/Work/Idea scopes the form leaves the parent ID
 * picker as a TODO — v1 only ships tenant-scope from the +New
 * page; scope-bound Agents are typically created from inside the
 * parent's detail screen (Mission tab strip, etc.) in later
 * phases. Picking a non-tenant scope here surfaces a "coming
 * soon" hint so the user knows where to find it.
 */
export function NewAgentDialog({ createAgent }: { createAgent: CreateAgentFn }) {
    const t = useTranslations('dashboard.agentsPage.newDialog');
    const router = useRouter();
    const [step, setStep] = useState<1 | 2>(1);
    const [scope, setScope] = useState<AgentScope>('tenant');
    const [name, setName] = useState('');
    const [title, setTitle] = useState('');
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    const scopeChoices: Array<{ value: AgentScope; label: string; desc: string; disabled?: boolean }> = [
        { value: 'tenant', label: t('scopeTenantDesc'), desc: t('scopeTenantDesc') },
        { value: 'mission', label: t('scopeMissionDesc'), desc: t('scopeMissionDesc'), disabled: true },
        { value: 'work', label: t('scopeWorkDesc'), desc: t('scopeWorkDesc'), disabled: true },
        { value: 'idea', label: t('scopeIdeaDesc'), desc: t('scopeIdeaDesc'), disabled: true },
    ];

    const handleSubmit = () => {
        if (!name.trim()) return;
        setError(null);
        startTransition(() => {
            void (async () => {
                try {
                    const created = await createAgent({
                        scope,
                        name: name.trim(),
                        title: title.trim() || null,
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
                <h1 className="text-xl font-semibold text-text dark:text-text-dark">{t('title')}</h1>
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
                                    onClick={() => !c.disabled && setScope(c.value)}
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
                                </button>
                            </li>
                        ))}
                    </ul>
                    <div className="flex items-center justify-end gap-2 mt-6">
                        <Button variant="ghost" size="sm" onClick={() => router.back()}>
                            {t('cancel')}
                        </Button>
                        <Button size="sm" onClick={() => setStep(2)} className="gap-1.5">
                            {t('next')}
                            <ChevronRight className="w-3.5 h-3.5" />
                        </Button>
                    </div>
                </section>
            )}

            {step === 2 && (
                <section>
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
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setStep(1)}
                            className="gap-1.5"
                        >
                            <ChevronLeft className="w-3.5 h-3.5" />
                            {t('back')}
                        </Button>
                        <Button
                            size="sm"
                            onClick={handleSubmit}
                            disabled={pending || !name.trim()}
                        >
                            {pending ? '…' : t('create')}
                        </Button>
                    </div>
                </section>
            )}
        </div>
    );
}
