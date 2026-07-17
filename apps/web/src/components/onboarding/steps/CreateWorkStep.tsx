'use client';

import { useRef, useState } from 'react';
import { ArrowRight, FolderPlus, Sparkles } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

export interface CreateWorkStepProps {
    readonly onLeave: () => void;
    /**
     * EW-617 G4: when a prompt is present (from the landing page `?prompt=…`
     * handoff, or typed into the wizard), this step swaps the
     * "Create your first Work" link for a one-click "Generate now" button.
     * The button calls `onQuickCreate(prompt)` and shows progress; the
     * parent owns the API call so this component stays I/O-free.
     */
    readonly prompt?: string;
    readonly onQuickCreate?: (prompt: string) => Promise<{
        readonly workSlug?: string;
        readonly generationHistoryId?: string;
    } | void>;
    /**
     * Called as the user edits the prompt textarea so the parent can persist
     * the edited value into the wizard state (`flow.setPrompt`). Keeps the
     * generated Work in sync with what the user actually sees before hitting
     * "Generate now".
     */
    readonly onPromptChange?: (value: string) => void;
}

/**
 * Final step — either:
 *  1. (legacy) navigates the user into the /works/new form, or
 *  2. (EW-617 G4) one-click "Generate now" when a `prompt` is set,
 *     calling `onQuickCreate(prompt)` which posts to
 *     `POST /api/works/quick-create` and returns the new work id +
 *     generation history id for status polling.
 *
 * The wizard closes once the action fires; the parent emits the
 * `onboarding_completed` telemetry event and marks the server flag.
 */
export function CreateWorkStep({
    onLeave,
    prompt,
    onQuickCreate,
    onPromptChange,
}: CreateWorkStepProps) {
    const trimmedPrompt = prompt?.trim() ?? '';
    // Latch the "generate" mode on first render. Once the step is entered via
    // the prompt hand-off it stays in generate mode for the component's
    // lifetime, so clearing the textarea disables the button rather than
    // collapsing the whole step back to the legacy "create" link.
    const hasPromptRef = useRef(trimmedPrompt.length > 0 && Boolean(onQuickCreate));
    const hasPrompt = hasPromptRef.current;
    const [editablePrompt, setEditablePrompt] = useState(trimmedPrompt);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const canSubmit = editablePrompt.trim().length > 0;

    const handleQuickCreate = async () => {
        const value = editablePrompt.trim();
        if (!onQuickCreate || submitting || !value) return;
        setSubmitting(true);
        setError(null);
        try {
            await onQuickCreate(value);
            onLeave();
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            setError(message || 'Generation failed to start. Please try again.');
        } finally {
            setSubmitting(false);
        }
    };

    const handlePromptChange = (value: string) => {
        setEditablePrompt(value);
        onPromptChange?.(value);
    };

    return (
        <div className="space-y-5 max-w-lg">
            <div className="flex items-start gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-secondary dark:bg-white/5">
                    {hasPrompt ? (
                        <Sparkles className="w-5 h-5 text-text-secondary dark:text-text-secondary-dark" />
                    ) : (
                        <FolderPlus className="w-5 h-5 text-text-secondary dark:text-text-secondary-dark" />
                    )}
                </div>
                <div>
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                        {hasPrompt ? 'Ready to generate' : 'Create your first Work'}
                    </h3>
                    <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                        {hasPrompt
                            ? 'We saved your wizard choices. Review or tweak the prompt below, then generate — repos, items, and deploy all in one go.'
                            : "You're all set. Hit the button below to start building — your choices above are saved and any new Work will pick them up."}
                    </p>
                    {hasPrompt ? (
                        <div className="mt-3">
                            <label
                                htmlFor="onboarding-prompt-input"
                                className="block text-sm font-medium text-text dark:text-text-dark mb-1.5"
                            >
                                Prompt
                            </label>
                            <textarea
                                id="onboarding-prompt-input"
                                data-testid="onboarding-prompt-input"
                                value={editablePrompt}
                                onChange={(event) => handlePromptChange(event.target.value)}
                                rows={4}
                                maxLength={5000}
                                className="w-full resize-y rounded-lg border border-card-border bg-white px-4 py-3 text-sm text-text outline-none transition-colors duration-200 placeholder-text-muted hover:border-border-secondary focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-white/9 dark:bg-card-primary-dark dark:text-text-dark dark:placeholder-text-muted-dark dark:hover:border-border-secondary-dark dark:focus:border-white/9"
                            />
                        </div>
                    ) : null}
                </div>
            </div>
            <div className="rounded-xl border border-dashed border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/30 p-5">
                {hasPrompt ? (
                    <>
                        <button
                            type="button"
                            onClick={handleQuickCreate}
                            disabled={submitting || !canSubmit}
                            data-testid="onboarding-generate-now"
                            className="inline-flex items-center gap-2 rounded-lg bg-black dark:bg-button-primary-dark px-4 py-2.5 text-sm font-medium text-white dark:text-black transition-colors hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {submitting ? 'Generating…' : 'Generate now'}
                            <Sparkles className="w-4 h-4" />
                        </button>
                        {error ? (
                            <p
                                role="alert"
                                className="mt-3 text-sm text-red-600 dark:text-red-400"
                                data-testid="onboarding-generate-error"
                            >
                                {error}
                            </p>
                        ) : null}
                    </>
                ) : (
                    <Link
                        href={ROUTES.DASHBOARD_NEW}
                        onClick={onLeave}
                        className="inline-flex items-center gap-2 rounded-lg bg-black dark:bg-button-primary-dark px-4 py-2.5 text-sm font-medium text-white dark:text-black transition-colors hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark"
                    >
                        Create your first Work
                        <ArrowRight className="w-4 h-4" />
                    </Link>
                )}
            </div>
        </div>
    );
}
