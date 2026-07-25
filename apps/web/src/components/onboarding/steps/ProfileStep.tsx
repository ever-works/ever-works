'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Loader2, Plus, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { ROLE_OPTIONS, TEAM_SIZE_OPTIONS } from '@ever-works/contracts/api';
import {
    filterSuggestedTemplates,
    shouldShowSuggestions,
    type SuggestableAgentTemplate,
} from '../profile-suggestions';
import {
    createAgentFromTemplateForOnboarding,
    listAgentTemplatesForOnboarding,
} from '@/app/actions/onboarding/agent-suggestions';

export interface ProfileStepProps {
    /** Currently selected role ids (kebab-case ROLE_OPTIONS ids). */
    readonly roles: readonly string[];
    /** Currently selected team-size id, if any. */
    readonly teamSize?: string;
    readonly onToggleRole: (roleId: string) => void;
    readonly onSelectTeamSize: (teamSizeId: string) => void;
}

/**
 * Wave 11 — "What do you do" onboarding step. Multi-select role cards
 * (selecting several or all is fine) + single-select team-size pills.
 * Selections are suggestion hints only — nothing is gated on them —
 * and persist through the same wizard-state save path as every other
 * step. Always skippable via the wizard footer.
 *
 * When the selected roles include a go-to-market trigger role, a
 * best-effort "suggested agents" block appears with 2-3 prebuilt
 * templates from `GET /api/agents/templates` (filtered client-side by
 * `suggestedRoles`) and a one-click Create agent affordance calling
 * `POST /api/agents/from-template/:slug`. The block hides itself when
 * the catalog fetch fails.
 */
export function ProfileStep({ roles, teamSize, onToggleRole, onSelectTeamSize }: ProfileStepProps) {
    const t = useTranslations('onboarding.profileStep');

    return (
        <div className="space-y-6 max-w-3xl">
            <header>
                <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h3>
                <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                    {t('description')}
                </p>
            </header>

            <section>
                <h4 className="text-sm font-semibold text-text dark:text-text-dark mb-2">
                    {t('rolesLabel')}
                </h4>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {ROLE_OPTIONS.map((role) => {
                        const selected = roles.includes(role.id);
                        return (
                            <button
                                key={role.id}
                                type="button"
                                aria-pressed={selected}
                                data-testid={`onboarding-profile-role-${role.id}`}
                                onClick={() => onToggleRole(role.id)}
                                className={cn(
                                    'group relative w-full text-left rounded-xl border bg-surface dark:bg-surface-dark p-3 transition-all',
                                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                                    'cursor-pointer hover:border-primary/40 hover:bg-surface-secondary/40 dark:hover:bg-white/5',
                                    selected
                                        ? 'border-primary ring-1 ring-primary/40 shadow-sm'
                                        : 'border-border dark:border-border-dark',
                                )}
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-sm font-semibold text-text dark:text-text-dark truncate">
                                        {t(`roles.${role.id}.label`)}
                                    </span>
                                    {selected ? (
                                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-white">
                                            <Check className="h-3 w-3" />
                                        </span>
                                    ) : null}
                                </div>
                                <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark leading-relaxed">
                                    {t(`roles.${role.id}.description`)}
                                </p>
                            </button>
                        );
                    })}
                </div>
            </section>

            <section>
                <h4 className="text-sm font-semibold text-text dark:text-text-dark mb-2">
                    {t('teamSizeLabel')}
                </h4>
                <div className="flex flex-wrap gap-2" role="group" aria-label={t('teamSizeLabel')}>
                    {TEAM_SIZE_OPTIONS.map((size) => {
                        const selected = teamSize === size.id;
                        return (
                            <button
                                key={size.id}
                                type="button"
                                aria-pressed={selected}
                                data-testid={`onboarding-profile-team-size-${size.id}`}
                                onClick={() => onSelectTeamSize(size.id)}
                                className={cn(
                                    'inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm transition-all',
                                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                                    selected
                                        ? 'border-primary bg-primary text-white font-medium'
                                        : 'border-border dark:border-border-dark text-text-secondary dark:text-text-secondary-dark hover:border-primary/40 hover:bg-surface-secondary/40 dark:hover:bg-white/5',
                                )}
                            >
                                {selected ? <Check className="h-3.5 w-3.5" /> : null}
                                {t(`teamSizes.${size.id}`)}
                            </button>
                        );
                    })}
                </div>
            </section>

            <SuggestedAgents roles={roles} />

            <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('skipHint')}</p>
        </div>
    );
}

// ─── Suggested agents (best-effort) ─────────────────────────────────────────

function SuggestedAgents({ roles }: { readonly roles: readonly string[] }) {
    const t = useTranslations('onboarding.profileStep.suggestions');
    const show = shouldShowSuggestions(roles);

    const [templates, setTemplates] = useState<SuggestableAgentTemplate[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [creating, setCreating] = useState<string | null>(null);
    const [created, setCreated] = useState<readonly string[]>([]);

    // Fetch the catalog once, lazily, the first time a trigger role is
    // selected. Best-effort: a failed fetch marks the block hidden for
    // the rest of the wizard session (no retry storm mid-onboarding).
    useEffect(() => {
        if (!show || failed || templates !== null) return;
        let cancelled = false;
        void listAgentTemplatesForOnboarding().then((result) => {
            if (cancelled) return;
            if (result.success && result.data) {
                setTemplates(result.data);
            } else {
                setFailed(true);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [show, failed, templates]);

    if (!show || failed || templates === null) return null;

    const suggested = filterSuggestedTemplates(templates, roles);
    if (suggested.length === 0) return null;

    const handleCreate = async (slug: string) => {
        setCreating(slug);
        try {
            const result = await createAgentFromTemplateForOnboarding(slug);
            if (result.success) {
                setCreated((prev) => (prev.includes(slug) ? prev : [...prev, slug]));
                toast.success(t('createdToast'));
            } else {
                toast.error(result.error ?? t('createFailed'));
            }
        } finally {
            setCreating(null);
        }
    };

    return (
        <section data-testid="onboarding-profile-suggestions">
            <h4 className="flex items-center gap-1.5 text-sm font-semibold text-text dark:text-text-dark mb-1">
                <Sparkles className="h-4 w-4" />
                {t('title')}
            </h4>
            <p className="text-xs text-text-muted dark:text-text-muted-dark mb-2">
                {t('description')}
            </p>
            <div className="space-y-2">
                {suggested.map((template) => {
                    const isCreated = created.includes(template.slug);
                    const isCreating = creating === template.slug;
                    return (
                        <div
                            key={template.slug}
                            className="rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-3"
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-semibold text-text dark:text-text-dark truncate">
                                        {template.name}
                                        <span className="ml-2 font-normal text-xs text-text-muted dark:text-text-muted-dark">
                                            {template.title}
                                        </span>
                                    </p>
                                    <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark leading-relaxed line-clamp-2">
                                        {template.description}
                                    </p>
                                </div>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={isCreated || isCreating}
                                    data-testid={`onboarding-profile-suggestion-create-${template.slug}`}
                                    onClick={() => void handleCreate(template.slug)}
                                >
                                    {isCreated ? (
                                        <>
                                            <Check className="mr-1.5 h-3.5 w-3.5" />
                                            {t('created')}
                                        </>
                                    ) : isCreating ? (
                                        <>
                                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                            {t('creating')}
                                        </>
                                    ) : (
                                        <>
                                            <Plus className="mr-1.5 h-3.5 w-3.5" />
                                            {t('create')}
                                        </>
                                    )}
                                </Button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
