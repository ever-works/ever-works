'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { buildAttachmentRefs, type ComposerAttachment } from '@/components/common/PromptComposer';
import type { PromptChip } from '@/components/common/PromptChipsRow';
import { seedFromExample, usePromptSeed } from '@/components/common/composer/use-prompt-seed';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { useStartFromPrompt } from '@/lib/hooks/use-start-from-prompt';
import { attachUploadToMissionAction, createMissionAction } from '@/app/actions/dashboard/missions';
import { canonicalRepositoryUrl } from '@/lib/work-kinds/repository-url';
import {
    CHIP_ICONS,
    CHIP_INTENT_LABEL,
    CHIP_ORDER,
    CHIP_TO_CANVAS_ROUTE,
    CHIP_TO_WORK_KIND,
    NEW_PROMPT_MIN_LENGTH,
    PLACEHOLDERS_BY_CHIP,
    STORE_CHIP_ICON,
    type ChipType,
} from './new-prompt.shared';

export type { ChipType };

export interface UseNewPromptOptions {
    /** Chip selected on first paint. Defaults to Mission. */
    initialType?: ChipType | null;
    initialPrompt?: string;
    /**
     * A Mission template to persist on the created Mission. Only `/new`
     * supplies this (`/new?type=mission&template=<id>`), where the chat AI
     * cannot carry it.
     */
    initialTemplateId?: string;
    /**
     * Chip values whose `works-<value>` PostHog flag resolved to `false`.
     * Evaluated server-side (the web app keeps `posthog-js` out of the
     * client bundle). Defaults to `[]` → everything enabled (fail-open).
     */
    disabledKinds?: readonly string[];
    /** The Company chip was submitted, or was preselected on mount. The caller owns the dialog. */
    onCompanyRequest?: () => void;
    /** The Mission-template path inline-created a Mission. The caller decides where to go. */
    onMissionCreated?: (mission: { id: string }) => void;
    /** `id` of the composer's textarea, so a chip pick can focus and seed it. */
    inputId?: string;
}

/**
 * The "start something" controller, shared by `/new` and the Dashboard
 * composer.
 *
 * Owns the prompt text, the selected kind, the attachments and the one
 * submit path that turns them into something: a Mission or Idea, a Work of a
 * named kind, a Repository import, an Agent/Task canvas, or the Company
 * dialog. Extracted from `NewPageClient` so both surfaces route identically —
 * a chip that behaves one way on `/new` and another way on Home would be a
 * bug in the product's most-used entry point.
 *
 * `store` remains the one inert "Soon" chip: it is never selectable and the
 * chip row never emits it.
 */
export function useNewPrompt({
    initialType = 'mission',
    initialPrompt,
    initialTemplateId,
    disabledKinds = [],
    onCompanyRequest,
    onMissionCreated,
    inputId,
}: UseNewPromptOptions = {}) {
    const t = useTranslations('dashboard.newPage');
    const router = useRouter();
    const [prompt, setPrompt] = useState(initialPrompt ?? '');
    const [selectedChip, setSelectedChip] = useState<ChipType>(initialType ?? 'mission');
    const [attachments, setAttachments] = useState<ReadonlyArray<ComposerAttachment>>([]);
    const [submitting, startSubmit] = useTransition();
    const startFromPrompt = useStartFromPrompt();
    const seedPrompt = usePromptSeed({ value: prompt, onChange: setPrompt, inputId });

    // Set of chip values whose `works-<value>` flag resolved to false
    // server-side. A disabled chip must never be the active selection
    // (and thus never submittable).
    const disabledSet = useMemo(() => new Set(disabledKinds), [disabledKinds]);

    // Effective selection — derived during render so a disabled chip is
    // never the active selection (no effect/setState round-trip; see the
    // project's "derive state, don't store it in an effect" rule). If the
    // raw `selectedChip` is flag-disabled, fall back to the safe default
    // (`mission` is never flag-gated here). Everything that reads/acts on
    // the selection uses `effectiveChip`, so a disabled kind can never be
    // submitted or handed off.
    const effectiveChip: ChipType = disabledSet.has(selectedChip) ? 'mission' : selectedChip;

    // `/new?type=company` lands straight on the Register-Company dialog.
    // The chip is already the selection; mirror it into the caller's dialog
    // open state once. Chip switches afterwards are handled by the row's
    // own click handler.
    const companyRequest = onCompanyRequest;
    useEffect(() => {
        if (initialType === 'company') companyRequest?.();
        // Only on mount — a later chip switch must not re-open the dialog.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const submit = () => {
        // EW-662 Phase 10 — the Company chip short-circuits the chat-AI
        // path. There's no prompt-to-mission/work pipeline here: the user
        // is going to register an Organization-backed Company, and that
        // flow is owned by `<RegisterCompanyDialog>` (which collects the
        // name + countryCode form). Open it and bail out of the rest of
        // the submit logic — no min-length check, because the prompt input
        // is incidental for this chip.
        if (effectiveChip === 'company') {
            onCompanyRequest?.();
            return;
        }
        const description = prompt.trim();
        if (description.length < NEW_PROMPT_MIN_LENGTH) {
            toast.error(t('hints.minLength'));
            return;
        }
        startSubmit(async () => {
            // Special case: Mission with a template-id in scope.
            // `/new?type=mission&template=<id>` comes from "Use this
            // template" buttons elsewhere in the app and needs the
            // template persisted as `missionTemplateRepo` on the new
            // Mission. The chat AI doesn't yet have a template-aware
            // Mission-creation tool, so dropping the id would silently
            // lose the template link (Greptile P1 on PR #1038). Keep the
            // legacy inline-create path here.
            //
            // Importantly, we DO NOT then send the same prompt into
            // the chat AI: the chat has `createMission` registered as
            // a tool and the system prompt instructs it to use tools
            // for mutations (Codex P2), so re-sending "I want to
            // create a Mission. <description>" would trigger a SECOND
            // non-template Mission creation. Just hand control back so
            // the user can iterate manually if they want.
            if (effectiveChip === 'mission' && initialTemplateId) {
                try {
                    const mission = await createMissionAction({
                        description,
                        type: 'one-shot',
                        missionTemplateRepo: initialTemplateId,
                    });
                    // Wire any completed PromptComposer uploads onto the
                    // newly created Mission via the attachments endpoint.
                    // Failures here are non-fatal: the Mission is created
                    // either way, so we toast a warning and proceed rather
                    // than rolling back. github-repo entries are skipped —
                    // they're metadata refs, not uploaded files.
                    // Single source of truth — `buildAttachmentRefs`
                    // already filters in-flight + failed uploads and
                    // carries the `uploadId` on each `upload` ref
                    // (Greptile P2 on PR #1044: avoids re-scanning the
                    // raw attachments with a divergent filter).
                    const uploadIds = buildAttachmentRefs(attachments)
                        .filter((r) => r.kind === 'upload' && r.uploadId)
                        .map((r) => r.uploadId!);
                    if (uploadIds.length > 0) {
                        const failed: string[] = [];
                        for (const uploadId of uploadIds) {
                            try {
                                await attachUploadToMissionAction(mission.id, uploadId);
                            } catch {
                                failed.push(uploadId);
                            }
                        }
                        if (failed.length > 0) {
                            toast.warning(
                                `${failed.length} attachment(s) couldn't be linked to the Mission — they're still saved in your uploads.`,
                            );
                        }
                    }
                    toast.success(t('toasts.missionCreated'));
                    onMissionCreated?.(mission);
                } catch (err) {
                    toast.error(err instanceof Error ? err.message : t('toasts.submitError'));
                }
                return;
            }

            // A Repository Work has nothing to generate, so there is
            // nothing for the chat AI to iterate on: hand the text (a repo
            // URL, typically) straight to the Repository form on the Work
            // canvas instead of opening a chat turn.
            if (effectiveChip === 'repo') {
                // Only canonical coordinates may ride in the query string:
                // pasted remotes routinely carry a token in the user-info
                // section, and a query parameter reaches browser history,
                // the referrer of every later request and any proxy log.
                // Anything that does not reduce to owner/repo routes with
                // no seed at all, and the user types it into the form.
                const canonical = canonicalRepositoryUrl(description);
                const params = new URLSearchParams({
                    mode: 'manual',
                    kind: 'repo',
                    ...(canonical ? { prompt: canonical } : {}),
                });
                router.push(`${ROUTES.DASHBOARD_WORKS_NEW}?${params.toString()}`);
                return;
            }

            // Send the prompt into the chat AI so the user can keep
            // iterating in chat — replaces the old "submit + redirect
            // with the same prompt pre-filled" pattern. The chat AI's
            // currentPageUrl context tells it where the user is, and
            // the intent prefix narrows it further.
            startFromPrompt(description, {
                intent: CHIP_INTENT_LABEL[effectiveChip],
                attachments: buildAttachmentRefs(attachments),
            });

            // Then navigate to the canvas for that intent. The canvas
            // page does NOT pre-fill the prompt — the user already
            // sent it, chat is the live channel from here on. The
            // canvas is for optional manual editing of the entity.
            if (effectiveChip === 'mission') {
                router.push(ROUTES.DASHBOARD_MISSIONS);
                return;
            }
            if (effectiveChip === 'idea') {
                router.push(ROUTES.DASHBOARD_IDEAS);
                return;
            }
            const canvasRoute = CHIP_TO_CANVAS_ROUTE[effectiveChip];
            const workKind = CHIP_TO_WORK_KIND[effectiveChip];
            if (canvasRoute && workKind) {
                // Work canvases need `mode=ai` so /works/new skips its
                // own composer entry view and renders the form. They
                // also need `kind` so the AI generator hints at the
                // right Work shape. Critically, no `prompt=` — the chat
                // already carries it.
                const params = new URLSearchParams({ mode: 'ai', kind: workKind });
                router.push(`${canvasRoute}?${params.toString()}`);
                return;
            }
            if (canvasRoute) {
                router.push(canvasRoute);
                return;
            }
        });
    };

    // Per-chip placeholder cycle. New reference on each chip flip
    // resets the typewriter inside PromptComposer.
    const placeholderExamples = useMemo(
        () => PLACEHOLDERS_BY_CHIP[effectiveChip] ?? PLACEHOLDERS_BY_CHIP.mission,
        [effectiveChip],
    );

    // Full chip catalog. `store` is appended after the live `CHIP_ORDER`
    // chips so it sits at the end of the horizontal scroll the way the
    // marketing site does it. Its `comingSoon` is driven by the
    // `works-store` PostHog flag like every other kind (the flag currently
    // resolves to `false`, so the chip still renders as inert "Soon" with
    // no user-facing change — but it's now controllable from PostHog).
    //
    // EW-662 Phase 10 — `company` graduated from "Soon" to live; it
    // sits at the end of the live `CHIP_ORDER` list so we render it
    // automatically from the loop below. Picking it opens the
    // Register-Company dialog on submit (see `submit()` above).
    //
    // `comingSoon` per chip is `disabledSet.has(value)` — i.e. driven
    // entirely by `works-<value>` PostHog flags resolved server-side.
    // Missing/undefined flags stay enabled (fail-open).
    const allChips = useMemo<ReadonlyArray<PromptChip<ChipType | 'store'>>>(
        () => [
            ...CHIP_ORDER.map((c) => ({
                value: c,
                label: t(`chips.${c}`),
                Icon: CHIP_ICONS[c],
                comingSoon: disabledSet.has(c),
            })),
            // store is flag-controlled via works-store like every other kind.
            // The `works-store` PostHog flag exists as `active: false`, so
            // the chip continues to render as the inert "Soon" baseline
            // until the flag is flipped — no code change required to enable.
            {
                value: 'store' as const,
                label: 'Store',
                Icon: STORE_CHIP_ICON,
                comingSoon: disabledSet.has('store'),
            },
        ],
        [t, disabledSet],
    );

    /** Pick a chip and hand the user that kind's example as an editable prompt. */
    const pickChip = (next: ChipType | 'store' | null) => {
        // `store` is the last remaining inert "Soon" chip — the chips row
        // never emits it. Narrow back to ChipType before persisting.
        // (`company` graduated to live in EW-662 Phase 10 and is handled
        // like any other ChipType.)
        if (next === null || next === 'store') return;
        setSelectedChip(next);
        // Picking a chip writes that chip's example into the input — the
        // chip hands over a real prompt to edit, not just a hint.
        seedPrompt(seedFromExample(PLACEHOLDERS_BY_CHIP[next][0]));
    };

    return {
        prompt,
        setPrompt,
        selectedChip: effectiveChip,
        pickChip,
        attachments,
        setAttachments,
        submitting,
        submit,
        placeholderExamples,
        allChips,
        /** The chip's own one-line description, for surfaces that show it. */
        chipDescription: t(`chipDescriptions.${effectiveChip}`),
    };
}
