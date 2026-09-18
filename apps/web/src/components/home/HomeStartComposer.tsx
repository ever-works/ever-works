'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PromptComposer } from '@/components/common/PromptComposer';
import { PromptChipsRow } from '@/components/common/PromptChipsRow';
import { useNewPrompt } from '@/components/new/use-new-prompt';
import { RegisterCompanyDialog } from '@/components/organizations/RegisterCompanyDialog';
import { HOME_COMPOSER_INPUT_ID } from './home.shared';

interface HomeStartComposerProps {
    /**
     * Work-kind chip values whose `works-<value>` PostHog flag resolved to
     * `false`, evaluated server-side on the dashboard page. Defaults to `[]`
     * → every kind enabled (fail-open).
     */
    disabledKinds?: readonly string[];
}

/**
 * Home (AW-19, owner 2026-09-18) — the Dashboard's "start something" composer.
 *
 * It is the `/new` page's composer, deliberately: same input, same kind chips,
 * same submit routing (`useNewPrompt`) — so a user who can start a Mission on
 * `/new` can start one from the Dashboard and get the identical result. What
 * differs is only the SIZE: `rows={1}` here instead of `rows={5}`, so the
 * Dashboard gives the prompt one line of its own and it grows with the text
 * (the shared composer's own auto-grow, up to its three-row ceiling) instead of
 * reserving a five-row block on the landing screen.
 *
 * The input id stays `home-composer-input`: Working now's empty state focuses
 * this field, and the Dashboard's own specs address it by that id.
 */
export function HomeStartComposer({ disabledKinds = [] }: HomeStartComposerProps) {
    const t = useTranslations('dashboard.home.composer');
    const tNew = useTranslations('dashboard.newPage');
    const [companyDialogOpen, setCompanyDialogOpen] = useState(false);

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
    } = useNewPrompt({
        initialType: 'mission',
        disabledKinds,
        inputId: HOME_COMPOSER_INPUT_ID,
        onCompanyRequest: () => setCompanyDialogOpen(true),
    });

    return (
        <div className="mb-6" data-testid="home-composer">
            <PromptComposer
                inputId={HOME_COMPOSER_INPUT_ID}
                value={prompt}
                onChange={setPrompt}
                onSubmit={submit}
                submitting={submitting}
                placeholderExamples={placeholderExamples}
                rows={1}
                ariaLabel={t('label')}
                submitTitle={t('send')}
                testId="home-start"
                onAttachmentsChange={setAttachments}
                chipsBelow={
                    <PromptChipsRow
                        chips={allChips}
                        value={selectedChip}
                        onChange={pickChip}
                        ariaLabel={tNew('chipLabel')}
                        testIdPrefix="home-chip"
                    />
                }
            />
            {/* EW-662 Phase 10 — the Company chip opens the same
                Register-Company dialog `/new` opens. */}
            <RegisterCompanyDialog open={companyDialogOpen} onOpenChange={setCompanyDialogOpen} />
        </div>
    );
}
