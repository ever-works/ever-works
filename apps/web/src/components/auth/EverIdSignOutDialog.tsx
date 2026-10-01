'use client';

import { useCallback, useId, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { logout } from '@/app/actions/auth';
import { getEverIdLogoutUrl, logoutWithEverId } from '@/app/actions/ever-id';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils/cn';

/**
 * The `Button` primitive's shape, as plain markup: this dialog is mounted by
 * `CommandPalette` and `DashboardSidebar`, and `Button` pulls in the locale-aware
 * `Link` this dialog never needs (the same reason the other dialogs here style
 * native buttons).
 */
const BUTTON_BASE =
    'inline-flex cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors h-9 px-4 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 dark:focus-visible:ring-white/20 disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * Whether the current session was opened with Ever ID (`GET /logout-url` answers
 * `200` only then). NEVER throws: anything but a usable answer means "no", and
 * the caller signs out exactly as it always has.
 */
async function isEverIdSession(): Promise<boolean> {
    try {
        return (await getEverIdLogoutUrl()) !== null;
    } catch {
        return false;
    }
}

/**
 * APW-12 (Ever ID) — the decision every "Sign out" entry point makes first (S7,
 * spec FR-36, T26).
 *
 * `offerEverIdSignOut()` asks the API once. For a session opened with Ever ID it
 * opens {@link EverIdSignOutDialog} and resolves `true` — the caller stops there.
 * For every other session it resolves `false` and the caller goes on to call
 * `logout()` exactly as it did before this feature existed (no dialog).
 */
export function useEverIdSignOut() {
    const [open, setOpen] = useState(false);

    const offerEverIdSignOut = useCallback(async (): Promise<boolean> => {
        const everIdSession = await isEverIdSession();
        if (everIdSession) {
            setOpen(true);
        }
        return everIdSession;
    }, []);

    return { offerEverIdSignOut, dialogProps: { open, onOpenChange: setOpen } };
}

interface EverIdSignOutDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

/**
 * "Sign out of Ever Works?" with the unticked checkbox "Also sign out of Ever ID"
 * (spec §6.5). Unticked, "Sign out" calls `logout()` — the same action the menu
 * item calls for every other session. Ticked, it calls `logoutWithEverId()`,
 * which performs that same sign-out and then sends the browser to the provider's
 * end-session page.
 *
 * Keyboard: the dialog traps focus, `Esc` cancels and returns focus to its
 * opener, and `Enter` signs out unless focus is on the checkbox (spec §6.7).
 */
export function EverIdSignOutDialog({ open, onOpenChange }: EverIdSignOutDialogProps) {
    const t = useTranslations('dashboard.signOut');
    const [alsoEverId, setAlsoEverId] = useState(false);
    const [isPending, startTransition] = useTransition();
    const checkboxId = useId();

    const close = () => {
        if (isPending) return;
        // Unticked by default — every time the dialog opens (FR-36).
        setAlsoEverId(false);
        onOpenChange(false);
    };

    const signOut = () => {
        if (isPending) return;
        startTransition(async () => {
            if (alsoEverId) {
                await logoutWithEverId();
            } else {
                await logout();
            }
        });
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next) close();
            }}
        >
            <DialogContent className="max-w-md">
                <form
                    data-testid="ever-id-sign-out-dialog"
                    onSubmit={(event) => {
                        event.preventDefault();
                        signOut();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('title')}
                        </DialogTitle>
                    </DialogHeader>

                    <label
                        htmlFor={checkboxId}
                        className="flex items-center gap-2 text-sm text-text dark:text-text-dark cursor-pointer"
                    >
                        <input
                            id={checkboxId}
                            type="checkbox"
                            data-testid="ever-id-sign-out-also"
                            checked={alsoEverId}
                            onChange={(event) => setAlsoEverId(event.target.checked)}
                            onKeyDown={(event) => {
                                // Enter on the checkbox must not sign out (spec §6.7).
                                if (event.key === 'Enter') event.preventDefault();
                            }}
                            disabled={isPending}
                            className="w-4 h-4 rounded border-border dark:border-border-dark text-primary focus:ring-primary"
                        />
                        {t('alsoSignOutEverId')}
                    </label>

                    <DialogFooter>
                        <button
                            type="button"
                            data-testid="ever-id-sign-out-cancel"
                            onClick={close}
                            disabled={isPending}
                            className={cn(
                                BUTTON_BASE,
                                'bg-transparent hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark text-text dark:text-text-dark',
                            )}
                        >
                            {t('cancel')}
                        </button>
                        <button
                            type="submit"
                            data-testid="ever-id-sign-out-confirm"
                            disabled={isPending}
                            aria-busy={isPending}
                            className={cn(BUTTON_BASE, 'bg-danger hover:bg-danger/90 text-white')}
                        >
                            {isPending ? (
                                <span
                                    aria-hidden="true"
                                    className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"
                                />
                            ) : null}
                            {t('confirm')}
                        </button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
