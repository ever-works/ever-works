'use client';

import { useState } from 'react';
import { ArrowRight, FolderPlus, Sparkles } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

export interface CreateWorkStepProps {
    readonly onLeave: () => void;
    /**
     * EW-617 G4: when a prompt is present (from the landing page `?prompt=…`
     * handoff, or typed into the wizard), this step swaps the
     * "Create your first work" link for a one-click "Generate now" button.
     * The button calls `onQuickCreate(prompt)` and shows progress; the
     * parent owns the API call so this component stays I/O-free.
     */
    readonly prompt?: string;
    readonly onQuickCreate?: (prompt: string) => Promise<{
        readonly workSlug?: string;
        readonly generationHistoryId?: string;
    } | void>;
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
export function CreateWorkStep({ onLeave, prompt, onQuickCreate }: CreateWorkStepProps) {
    const trimmedPrompt = prompt?.trim() ?? '';
    const hasPrompt = trimmedPrompt.length > 0 && Boolean(onQuickCreate);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleQuickCreate = async () => {
        if (!onQuickCreate || submitting) return;
        setSubmitting(true);
        setError(null);
        try {
            await onQuickCreate(trimmedPrompt);
            onLeave();
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            setError(message || 'Generation failed to start. Please try again.');
        } finally {
            setSubmitting(false);
        }
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
                        {hasPrompt ? 'Ready to generate' : 'Create your first work'}
                    </h3>
                    <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                        {hasPrompt
                            ? 'We saved your wizard choices. One click and we’ll generate the directory from your prompt — repos, items, and deploy all in one go.'
                            : "You're all set. Hit the button below to start building — your choices above are saved and any new work will pick them up."}
                    </p>
                    {hasPrompt ? (
                        <p className="mt-3 rounded-md border border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/30 px-3 py-2 text-sm text-text dark:text-text-dark">
                            <span className="font-medium">Prompt:</span> {trimmedPrompt}
                        </p>
                    ) : null}
                </div>
            </div>
            <div className="rounded-xl border border-dashed border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/30 p-5">
                {hasPrompt ? (
                    <>
                        <button
                            type="button"
                            onClick={handleQuickCreate}
                            disabled={submitting}
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
                        Create your first work
                        <ArrowRight className="w-4 h-4" />
                    </Link>
                )}
            </div>
        </div>
    );
}
