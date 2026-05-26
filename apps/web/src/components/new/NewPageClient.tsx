'use client';

import { useState, useTransition } from 'react';
import { BookOpen, Files, Globe, Lightbulb, Plus, Star, Target } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { CreationBlockTrio } from '@/components/works/CreationBlockTrio';
import { createMissionAction } from '@/app/actions/dashboard/missions';
import { createIdeaAction } from '@/app/actions/dashboard/work-proposals';

/**
 * Phase 6.5 PR CC2 — unified `/new` page.
 *
 * Single creation entry point spec §8b carves out. The chip strip
 * pre-narrows the kind of thing the user is creating; the prompt
 * Textarea collects their description; the reused
 * CreationBlockTrio (PR CC1) gives a fallback path for users who
 * want the per-mode flows directly.
 *
 * Chip order is fixed per spec: Mission, Idea, Website, Landing
 * Page, Blog, Directory, Awesome Repo. The `type` query param
 * pre-selects a chip (e.g. `/new?type=mission` from the PR Q
 * "+ New Mission" button); default = no selection so the user
 * sees the full menu.
 *
 * Submit behavior (v1):
 *   - Mission → POST /me/missions (one-shot) + navigate to detail
 *   - Idea → POST /me/work-proposals + navigate to /ideas
 *   - Website/Landing Page/Blog/Directory/Awesome Repo → route to
 *     /works/new (the existing flow) with the prompt carried via
 *     a query param so the AI Creator pre-fills it
 *
 * AI Chat sidebar hide-until-submit: the layout-level chat panel
 * is OUT OF SCOPE for v1 — wiring "hide on /new" needs the
 * layout-client refactor a follow-up tick will pick up. For now
 * the page renders the form full-width; the chat panel still
 * appears in the right rail per the user's preference.
 */
export type ChipType =
    | 'mission'
    | 'idea'
    | 'website'
    | 'landing-page'
    | 'blog'
    | 'directory'
    | 'awesome-repo';

const CHIP_ORDER: ChipType[] = [
    'mission',
    'idea',
    'website',
    'landing-page',
    'blog',
    'directory',
    'awesome-repo',
];

const CHIP_ICONS: Record<ChipType, LucideIcon> = {
    mission: Target,
    idea: Lightbulb,
    website: Globe,
    'landing-page': Files,
    blog: BookOpen,
    directory: Files,
    'awesome-repo': Star,
};

export interface NewPageClientProps {
    initialType?: ChipType | null;
    /**
     * Phase 8 PR Y — when the user lands here from a Mission
     * Template's "Use this Template" button, the server page
     * resolves the template + passes its name+description as
     * the initial prompt. NewPageClient just renders it.
     */
    initialPrompt?: string;
    /**
     * Phase 8 PR Y — id of the source template, forwarded to
     * the Mission-create submit so the spawned Mission can be
     * tagged with `missionTemplateRepo` for the back-link.
     * Wired through `createMissionAction` when present.
     */
    initialTemplateId?: string;
}

export function NewPageClient({
    initialType = null,
    initialPrompt,
    initialTemplateId,
}: NewPageClientProps) {
    const t = useTranslations('dashboard.newPage');
    const router = useRouter();
    const [prompt, setPrompt] = useState(initialPrompt ?? '');
    const [selectedChip, setSelectedChip] = useState<ChipType | null>(initialType);
    const [submitting, startSubmit] = useTransition();

    const canSubmit = selectedChip !== null && prompt.trim().length >= 10;

    const submit = () => {
        if (!canSubmit || !selectedChip) return;
        const description = prompt.trim();
        startSubmit(async () => {
            try {
                if (selectedChip === 'mission') {
                    // Mission is a one-shot in v1; the user can flip
                    // it to scheduled on the detail page (PR R).
                    // Phase 8 PR Y — when the user landed via a
                    // Mission Template's "Use this Template" button,
                    // forward the template id as `missionTemplateRepo`
                    // so the new Mission carries the back-link. The
                    // field accepts a string identifier — PR JJ's
                    // manifest service will resolve it to the actual
                    // repo coords at scaffold time.
                    const mission = await createMissionAction({
                        description,
                        type: 'one-shot',
                        ...(initialTemplateId ? { missionTemplateRepo: initialTemplateId } : {}),
                    });
                    toast.success(t('toasts.missionCreated'));
                    router.push(ROUTES.DASHBOARD_MISSION(mission.id));
                    return;
                }
                if (selectedChip === 'idea') {
                    await createIdeaAction({ description });
                    toast.success(t('toasts.ideaCreated'));
                    router.push(ROUTES.DASHBOARD_IDEAS);
                    return;
                }
                // The remaining 5 chip types route into the existing
                // /works/new flow; the `kind` query param hints
                // the AI Creator at which Work shape to bias toward.
                // The legacy page ignores unknown query params today,
                // so this is forward-compatible — the wiring lands
                // when the AI Creator reads `kind` (follow-up tick).
                const params = new URLSearchParams({
                    mode: 'ai',
                    kind: selectedChip,
                    prompt: description.slice(0, 4000),
                });
                router.push(`${ROUTES.DASHBOARD_WORKS_NEW}?${params.toString()}`);
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.submitError'));
            }
        });
    };

    return (
        <div className="w-full overflow-auto p-6 max-w-screen-2xl mx-auto space-y-6">
            <div>
                <h1 className="text-3xl font-bold text-text dark:text-text-dark">{t('title')}</h1>
                <p className="text-text-secondary dark:text-text-secondary-dark mt-1">
                    {t('subtitle')}
                </p>
            </div>

            {/* Prompt + chip strip card */}
            <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                <label
                    htmlFor="new-prompt"
                    className="text-xs uppercase tracking-wide text-text-muted dark:text-text-muted-dark"
                >
                    {t('promptLabel')}
                </label>
                <Textarea
                    id="new-prompt"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={5}
                    placeholder={t('promptPlaceholder')}
                    className="mt-2 text-base"
                />
                <div className="mt-3">
                    <div className="text-xs uppercase tracking-wide text-text-muted dark:text-text-muted-dark mb-2">
                        {t('chipLabel')}
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {CHIP_ORDER.map((c) => {
                            const Icon = CHIP_ICONS[c];
                            const active = selectedChip === c;
                            return (
                                <button
                                    key={c}
                                    type="button"
                                    onClick={() => setSelectedChip(c)}
                                    className={cn(
                                        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors',
                                        active
                                            ? 'bg-primary text-white border-primary'
                                            : 'bg-card dark:bg-card-primary-dark border-border dark:border-border-dark text-text-secondary dark:text-text-secondary-dark hover:border-primary/40',
                                    )}
                                    aria-pressed={active}
                                >
                                    <Icon className="w-3.5 h-3.5" />
                                    {t(`chips.${c}`)}
                                </button>
                            );
                        })}
                    </div>
                </div>
                <div className="mt-4 flex items-center justify-end gap-2">
                    <Button
                        type="button"
                        size="sm"
                        className="gap-1.5"
                        onClick={submit}
                        disabled={!canSubmit || submitting}
                    >
                        <Plus className="w-3.5 h-3.5" />
                        {t('submit')}
                    </Button>
                </div>
                {selectedChip === null && (
                    <p className="mt-2 text-xs text-text-muted dark:text-text-muted-dark">
                        {t('hints.pickChip')}
                    </p>
                )}
                {selectedChip !== null && prompt.trim().length < 10 && (
                    <p className="mt-2 text-xs text-text-muted dark:text-text-muted-dark">
                        {t('hints.minLength')}
                    </p>
                )}
            </div>

            {/* Or-divider + reused CreationBlockTrio in unified mode for
                users who want the per-mode flows directly. PR CC1
                already shipped the trio with the alternate label set. */}
            <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-border/60 dark:bg-border-dark/60" />
                <span className="text-xs uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                    {t('or')}
                </span>
                <div className="flex-1 h-px bg-border/60 dark:bg-border-dark/60" />
            </div>
            <CreationBlockTrio
                labelSet="unified"
                onSelect={(mode) => {
                    // The trio's mode → /works/new mapping mirrors the
                    // existing per-mode AI/manual/import flow. Carries
                    // the prompt forward if the user typed one but
                    // hadn't yet picked a chip.
                    const params = new URLSearchParams({ mode });
                    if (prompt.trim().length > 0) {
                        params.set('prompt', prompt.trim().slice(0, 4000));
                    }
                    router.push(`${ROUTES.DASHBOARD_WORKS_NEW}?${params.toString()}`);
                }}
            />
        </div>
    );
}
