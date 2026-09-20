'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PromptComposer } from '@/components/common/PromptComposer';
import { PromptChipsRow } from '@/components/common/PromptChipsRow';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { useChatPanel } from '@/lib/hooks/use-chat-panel';
import { RegisterCompanyDialog } from '@/components/organizations/RegisterCompanyDialog';
import { ALL_NEW_CHIP_VALUES, type ChipType } from './new-prompt.shared';
import { useNewPrompt } from './use-new-prompt';

// Public surface kept where it has always been exported from — `/new`'s page
// and the sidebar read `ALL_NEW_CHIP_VALUES` / `ChipType` off this module.
export { ALL_NEW_CHIP_VALUES, type ChipType };

/**
 * Unified `/new` page — single prompt input + chips for every
 * creatable kind. No "Create Work Manually" / "Import Existing"
 * affordances here: those live on `/works/new` so this page stays
 * focused on the conversational entry point.
 *
 * Chip → submit routing lives in `useNewPrompt`, shared with the Dashboard
 * composer so the two surfaces cannot disagree:
 *   - mission / idea  — the prompt goes to the chat AI, then the canvas.
 *   - agent / task    — route to their respective `/new` pages (one-pager
 *                       creators there collect any remaining bits).
 *   - website + 4 work kinds — forwarded to `/works/new` with the
 *                       selected kind preserved.
 *   - repo            — the Repository form on the Work canvas, no chat turn.
 *   - company         — the Register-Company dialog (spec §5.4), which
 *                       creates an Organization with
 *                       `registrationProvider = 'manual'` and
 *                       `registrationStatus = 'registered'`. The full Stripe
 *                       Atlas SDK integration is deferred to a later phase;
 *                       for v1 the manual-completion path is the only way
 *                       Company Works produce Orgs.
 *
 * `store` is a catalog entry telegraphing roadmap scope (see Workspace
 * notes `2026-05-23-missions-ideas-works-spec.md` + AGENTS.md "stores
 * + companies are in-scope future use cases"). It's flag-controlled via
 * the `works-store` PostHog flag like every other kind; today the flag
 * resolves to `false`, so the chip still renders as an inert "Soon"
 * chip matching how the marketing site telegraphs it — but it can be
 * flipped from PostHog without a code change.
 *
 * The chat panel is auto-collapsed on mount so the prompt + chips
 * get the full main column on first land. Users can reopen it from
 * the layout's chat handle if they want it back.
 */
export interface NewPageClientProps {
    initialType?: ChipType | null;
    initialPrompt?: string;
    initialTemplateId?: string;
    /**
     * Work-kind chip values whose `works-<value>` PostHog flag resolved
     * to an explicit `false`. Evaluated server-side and passed down (the
     * web app keeps `posthog-js` out of the client bundle). Defaults to
     * `[]` → everything enabled (fail-open).
     */
    disabledKinds?: string[];
}

const PROMPT_INPUT_ID = 'new-prompt';

export function NewPageClient({
    initialType = 'mission',
    initialPrompt,
    initialTemplateId,
    disabledKinds = [],
}: NewPageClientProps) {
    const t = useTranslations('dashboard.newPage');
    const router = useRouter();

    // EW-662 Phase 10 — Company chip is a special chip whose submit
    // opens the Register-Company dialog instead of going through the
    // chat-AI / canvas pipeline. We hold the dialog open-state here so
    // it survives chip switches.
    const [companyDialogOpen, setCompanyDialogOpen] = useState(false);

    // Close the layout chat panel on mount so the prompt + chips
    // take the full main column. We depend ONLY on the (stable)
    // setter — not the whole context object — because the context
    // value is recreated on every `open` flip, so depending on
    // `chat` would re-fire `setOpen(false)` the moment the user
    // re-opens the panel and lock them out. The setter itself is
    // memoised by the provider so this effectively runs once on
    // mount. Hook is null-safe when rendered outside the dashboard
    // layout (e.g. previews/tests).
    const chat = useChatPanel();
    const setChatOpen = chat?.setOpen;
    useEffect(() => {
        setChatOpen?.(false);
    }, [setChatOpen]);

    const {
        prompt,
        setPrompt,
        selectedChip,
        pickChip,
        setAttachments,
        submitting,
        submit,
        placeholderExamples,
        allChips,
        chipDescription,
    } = useNewPrompt({
        initialType,
        initialPrompt,
        initialTemplateId,
        disabledKinds,
        inputId: PROMPT_INPUT_ID,
        onCompanyRequest: () => setCompanyDialogOpen(true),
        // The template path creates the Mission inline and hands control
        // back: open the chat so the user can iterate manually, then land
        // on the new Mission.
        onMissionCreated: (mission) => {
            setChatOpen?.(true);
            router.push(ROUTES.DASHBOARD_MISSION(mission.id));
        },
    });

    return (
        <div className="w-full overflow-auto p-6 max-w-screen-2xl mx-auto space-y-6">
            <div>
                <h1 className="text-3xl font-bold text-text dark:text-text-dark">{t('title')}</h1>
                <p className="text-text-secondary dark:text-text-secondary-dark mt-1">
                    {t('subtitle')}
                </p>
            </div>

            {/* Composer with chips rendered BELOW the card (matches the
                website's landing layout — chips sit outside the input
                container, not inside). */}
            <PromptComposer
                inputId={PROMPT_INPUT_ID}
                value={prompt}
                onChange={setPrompt}
                onSubmit={submit}
                submitting={submitting}
                placeholderExamples={placeholderExamples}
                rows={5}
                ariaLabel={t('promptLabel')}
                submitTitle={t('submitTitle')}
                testId="new-prompt"
                onAttachmentsChange={setAttachments}
                chipsBelow={
                    <div className="space-y-2">
                        <PromptChipsRow
                            chips={allChips}
                            value={selectedChip}
                            onChange={pickChip}
                            ariaLabel={t('chipLabel')}
                            testIdPrefix="new-chip"
                        />
                        <p className="px-1 text-xs text-text-muted dark:text-text-muted-dark">
                            {chipDescription}
                        </p>
                    </div>
                }
            />

            {/* EW-662 Phase 10 — Register-Company dialog. Opens when the
                user submits the Company chip or lands on
                `/new?type=company`. */}
            <RegisterCompanyDialog open={companyDialogOpen} onOpenChange={setCompanyDialogOpen} />
        </div>
    );
}
