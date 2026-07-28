'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Loader2, Plus, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { ROLE_OPTIONS, TEAM_SIZE_OPTIONS } from '@ever-works/contracts/api';
import type { OnboardingSeedSuggestionsResponse } from '@ever-works/contracts/api';
import {
    createAgentFromTemplateForOnboarding,
    getRoleSeedSuggestions,
    seedRoleStarterAgents,
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

// ─── Suggested starter kit (server-resolved, best-effort) ───────────────────

/**
 * A55 — the suggestion block.
 *
 * Resolution moved to the API: this component no longer downloads the
 * agent catalog and filters it locally (which covered 3 of the 14 roles
 * and knew nothing about skills). It asks
 * `GET /api/onboarding/suggestions` for the kit that matches the
 * selected roles and renders what comes back, so every role produces a
 * starting point and the mapping is the same everywhere.
 *
 * Still best-effort: a failed resolve hides the block for the rest of
 * the wizard session rather than retrying, and nothing here gates the
 * step.
 */
function SuggestedAgents({ roles }: { readonly roles: readonly string[] }) {
    const t = useTranslations('onboarding.profileStep.suggestions');
    const roleKey = [...roles].sort().join(',');

    const [kit, setKit] = useState<OnboardingSeedSuggestionsResponse | null>(null);
    const [failed, setFailed] = useState(false);
    const [creating, setCreating] = useState<string | null>(null);
    const [created, setCreated] = useState<readonly string[]>([]);
    const [seeding, setSeeding] = useState(false);

    // Re-resolve whenever the selected roles change: the kit is a
    // function of the answers, and the previous kit would be stale.
    useEffect(() => {
        if (failed || roleKey === '') {
            setKit(null);
            return;
        }
        let cancelled = false;
        void getRoleSeedSuggestions(roleKey.split(',')).then((result) => {
            if (cancelled) return;
            if (result.success && result.data) {
                setKit(result.data);
            } else {
                setFailed(true);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [roleKey, failed]);

    if (failed || kit === null || kit.agents.length === 0) return null;

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

    // One call creates the whole kit server-side. Idempotent, so a
    // second click reports "already set up" instead of duplicating.
    const handleSeedAll = async () => {
        setSeeding(true);
        try {
            const result = await seedRoleStarterAgents(kit.roles);
            if (!result.success || !result.data) {
                toast.error(result.error ?? t('seedFailed'));
                return;
            }
            const { createdCount, skippedCount, failedCount, agents } = result.data;
            setCreated((prev) => {
                const next = new Set(prev);
                for (const entry of agents) {
                    if (entry.outcome === 'created' || entry.outcome === 'already-exists') {
                        next.add(entry.slug);
                    }
                }
                return [...next];
            });
            if (failedCount > 0) {
                toast.warning(t('seedPartial', { created: createdCount, failed: failedCount }));
            } else if (createdCount === 0 && skippedCount > 0) {
                toast.success(t('seedAlreadyDone'));
            } else {
                toast.success(t('seedDone', { count: createdCount }));
            }
        } finally {
            setSeeding(false);
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
                {kit.agents.map((template) => {
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
                                    disabled={isCreated || isCreating || seeding}
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

            {kit.skills.length > 0 ? (
                <div className="mt-3">
                    <p className="text-xs font-semibold text-text dark:text-text-dark mb-1.5">
                        {t('skillsTitle')}
                    </p>
                    <div
                        className="flex flex-wrap gap-1.5"
                        data-testid="onboarding-profile-suggested-skills"
                    >
                        {kit.skills.map((skill) => (
                            <span
                                key={skill.slug}
                                title={skill.description}
                                className="inline-flex items-center rounded-full border border-border dark:border-border-dark px-2.5 py-1 text-xs text-text-secondary dark:text-text-secondary-dark"
                            >
                                {skill.title}
                            </span>
                        ))}
                    </div>
                </div>
            ) : null}

            <div className="mt-3">
                <Button
                    size="sm"
                    disabled={seeding}
                    data-testid="onboarding-profile-suggestion-seed-all"
                    onClick={() => void handleSeedAll()}
                >
                    {seeding ? (
                        <>
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            {t('seeding')}
                        </>
                    ) : (
                        <>
                            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                            {t('seedAll')}
                        </>
                    )}
                </Button>
            </div>
        </section>
    );
}
