'use client';

import { useId, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Diamond } from 'lucide-react';
import { startEverIdSignIn } from '@/app/actions/ever-id';
import { Button } from '@/components/ui/button';

interface EverIdButtonProps {
    /** `signIn` on the sign-in page, `signUp` on the registration page (spec §6.1). */
    mode: 'signIn' | 'signUp';
    /** Where to land after signing in — validated again on the server. */
    returnTo?: string | null;
    /**
     * The registration page's consent gate — the same condition that blocks its
     * social buttons, so Ever ID cannot walk past an unticked box either.
     */
    disabled?: boolean;
    /** Shown under the button while `disabled`, so it is never mysteriously inert. */
    disabledReason?: string;
}

/**
 * APW-12 (Ever ID) — "Sign in with Ever ID" / "Sign up with Ever ID" (spec §6.1,
 * T24): full width, above the social buttons.
 *
 * The pages render this only when an administrator has enabled Ever ID **and**
 * the `ever-id` flag is on (`isEverIdOffered`); the component itself has no
 * opinion on availability, so a page that does not render it is unchanged.
 *
 * The click runs the `startEverIdSignIn` server action, which redirects the
 * browser to Ever ID; the label reads "Opening Ever ID…" until the page goes. A
 * failure (Ever ID turned off a moment ago, the provider not responding, a rate
 * limit) is announced in an alert under the button (FR-52).
 */
export function EverIdButton({
    mode,
    returnTo,
    disabled = false,
    disabledReason,
}: EverIdButtonProps) {
    const t = useTranslations('auth.everId');
    const [isPending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const reasonId = useId();
    const showReason = disabled && Boolean(disabledReason);

    const handleClick = () => {
        if (disabled || isPending) return;
        setError(null);
        startTransition(async () => {
            // Only a failure comes back: success navigates away to Ever ID.
            const result = await startEverIdSignIn(returnTo ?? null);
            if (result && !result.success) {
                setError(result.error);
            }
        });
    };

    return (
        <div className="space-y-2">
            <Button
                type="button"
                variant="secondary"
                fullWidth
                data-testid="ever-id-button"
                onClick={handleClick}
                disabled={disabled || isPending}
                aria-disabled={disabled || isPending}
                aria-busy={isPending}
                aria-describedby={showReason ? reasonId : undefined}
                title={disabled ? disabledReason : undefined}
                className="h-10 gap-2 text-sm"
            >
                <Diamond className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="truncate">
                    {isPending ? t('redirecting') : t(mode === 'signUp' ? 'signUp' : 'signIn')}
                </span>
            </Button>

            {showReason ? (
                <p
                    id={reasonId}
                    data-testid="ever-id-button-reason"
                    className="text-xs text-text-muted dark:text-text-muted-dark"
                >
                    {disabledReason}
                </p>
            ) : null}

            {error ? (
                <p
                    role="alert"
                    data-testid="ever-id-button-error"
                    className="bg-danger/10 border border-danger/20 text-danger px-4 py-3 rounded-lg text-sm"
                >
                    {error}
                </p>
            ) : null}
        </div>
    );
}
