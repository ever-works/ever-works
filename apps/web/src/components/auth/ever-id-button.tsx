'use client';

import { useId, useState, useTransition, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { startEverIdSignIn } from '@/app/actions/ever-id';
import { EverIdWordmark } from './ever-id-wordmark';
import { EverStar } from './ever-star';

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
 * The Ever brand kit's Ever ID button (`ever-co/platform` packages/brand, README
 * "The Login with Ever ID button"), the same button as in Ever Teams and Gauzy: the full width
 * of the form, at least 40 px, radius 8, padding 0 16px, 8 px gaps, 14/20 px at weight 500.
 * Light: #0A0A0A with white text (hover #262626); dark: #EDEDED with #0A0A0A text (hover #FFF).
 * Focus ring 2 px, offset 2 (#231645 light, #CC66FF dark). Written as classes so it follows
 * this app's theme switch instead of the kit's global tokens. The words and the wordmark wrap
 * (the button grows) only when the text is enlarged or a translation is long.
 */
const EVER_ID_BUTTON_CLASS =
    'box-border flex w-full min-h-10 items-center justify-center gap-2 px-4 py-[9px] rounded-lg border text-sm leading-5 font-medium cursor-pointer select-none transition-colors duration-150 bg-[#0a0a0a] border-[#0a0a0a] text-white hover:bg-[#262626] dark:bg-[#ededed] dark:border-white/[0.09] dark:text-[#0a0a0a] dark:hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#231645] dark:focus-visible:outline-[#cc66ff] disabled:opacity-50 disabled:pointer-events-none';

/** The `<wordmark>` tag of the label: the drawn wordmark, and its words for screen readers. */
function renderWordmark(chunks: ReactNode) {
    return (
        <>
            <EverIdWordmark className="block h-3.5 w-auto" />
            <span className="sr-only">{chunks}</span>
        </>
    );
}

/**
 * APW-12 (Ever ID) — "Sign in with Ever ID" / "Sign up with Ever ID" (spec §6.1, T24): full
 * width, above the social buttons. The Ever star (one turn every 9 s like the ever.works logo,
 * still with a reduced-motion setting), the words, and "Ever ID" as its wordmark.
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
            <button
                type="button"
                data-testid="ever-id-button"
                onClick={handleClick}
                disabled={disabled || isPending}
                aria-disabled={disabled || isPending}
                aria-busy={isPending}
                aria-describedby={showReason ? reasonId : undefined}
                title={disabled ? disabledReason : undefined}
                className={EVER_ID_BUTTON_CLASS}
            >
                <EverStar className="h-5 w-auto shrink-0 motion-safe:animate-[spin_9s_linear_infinite]" />
                <span className="inline-flex flex-wrap items-center justify-center gap-2">
                    {isPending
                        ? t('redirecting')
                        : t.rich(mode === 'signUp' ? 'signUpWith' : 'signInWith', {
                              wordmark: renderWordmark,
                          })}
                </span>
            </button>

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
