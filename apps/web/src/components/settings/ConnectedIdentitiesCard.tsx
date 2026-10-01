'use client';

import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Diamond, ExternalLink, Fingerprint } from 'lucide-react';
import {
    disconnectEverId,
    signInAgainToConnectEverId,
    startEverIdConnect,
} from '@/app/actions/ever-id';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
} from '@/components/ui/dialog';
import { Link, useRouter } from '@/i18n/navigation';
import type { EverIdIdentity, EverIdIdentityList } from '@/lib/api/ever-id';
import {
    EVER_ID_CONNECTED_NOTICE,
    everIdMessageKey,
    type EverIdFailureCode,
    type EverIdSecurityNotice,
} from '@/lib/auth/ever-id';
import { ROUTES } from '@/lib/constants';

export interface ConnectedIdentitiesCardProps {
    /** `GET /auth/ever-id/identities`, or `null` when it could not be read. */
    identities: EverIdIdentityList | null;
    /**
     * Whether "Connect Ever ID" is offered: an administrator enabled Ever ID
     * **and** the `ever-id` flag is on for this person.
     */
    canConnect: boolean;
    /** Whether an administrator has turned Ever ID off (spec §6.3 variant, S18). */
    turnedOff: boolean;
    /** A notice carried back to Settings by `?everId=` — an error code or `connected`. */
    notice?: EverIdSecurityNotice | null;
    /** The wait, in seconds, for a rate-limit notice. */
    noticeRetryAfter?: number;
}

/** Only an absolute http(s) address is ever rendered as an off-site link. */
function isHttpUrl(value: string | undefined): value is string {
    if (!value) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
        return false;
    }
}

function toDate(value: string | null | undefined): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

type ErrorTranslator = ReturnType<typeof useTranslations<'auth.error.everId'>>;

/** The copy for a failure code (`auth.error.everId.*`). */
function failureMessage(
    tError: ErrorTranslator,
    code: EverIdFailureCode,
    retryAfterSeconds?: number,
): string {
    const key = everIdMessageKey(code) ?? 'providerUnavailable';
    return key === 'rateLimited'
        ? tError('rateLimited', { seconds: retryAfterSeconds ?? 60 })
        : tError(key);
}

/**
 * APW-12 (Ever ID) — Settings → Security → **Connected identities** (spec §6.3,
 * §6.4, T26). The states:
 *
 * - **connected** — the identity, when it was connected and last used, and
 *   Disconnect (behind the §6.4 confirmation);
 * - **not connected, connect offered** — "Not connected" and "Connect Ever ID";
 * - **cannot disconnect (S14)** — Disconnect disabled, the reason beside it and
 *   "Set a password";
 * - **turned off by an administrator (S18)** — the rows and Disconnect stay,
 *   with the turned-off line and no Connect;
 * - **nothing to show** — no identity and nothing to offer: the card is absent.
 *
 * The delegated apps list (FR-48) shows each app's display name and when it last
 * read the person's App Works, with "Manage in Ever ID" when the provider has a
 * page for it. Every state is named in text, never by colour alone, and every
 * error is announced (FR-52).
 */
export function ConnectedIdentitiesCard({
    identities,
    canConnect,
    turnedOff,
    notice = null,
    noticeRetryAfter,
}: ConnectedIdentitiesCardProps) {
    const t = useTranslations('dashboard.settings.security.connectedIdentities');
    const tEverId = useTranslations('auth.everId');
    const tError = useTranslations('auth.error.everId');
    const format = useFormatter();
    const router = useRouter();
    const headingId = useId();
    const blockedId = useId();

    const [isConnecting, startConnect] = useTransition();
    const [isSigningInAgain, startSignInAgain] = useTransition();
    const [isDisconnecting, startDisconnect] = useTransition();
    // A failure carried back from the provider round trip (`?everId=<code>`) arrives
    // on a full page load, so it is shown on the card, like any other connect
    // failure, rather than as a toast that the page could fire before its toaster
    // is listening.
    const [connectError, setConnectError] = useState<{
        message: string;
        code: string;
    } | null>(() =>
        notice && notice !== EVER_ID_CONNECTED_NOTICE && notice !== 'reauth_required'
            ? { message: failureMessage(tError, notice, noticeRetryAfter), code: notice }
            : null,
    );
    // S15 can also arrive from the provider round trip (`?everId=reauth_required`).
    const [reauthFromNotice] = useState(notice === 'reauth_required');
    const [disconnectTarget, setDisconnectTarget] = useState<EverIdIdentity | null>(null);
    const [disconnectError, setDisconnectError] = useState<string | null>(null);

    // Announce a notice carried back in the address once, then drop it from the
    // address so a reload does not announce it again. The success toast waits one
    // task: on a full page load this effect can run before the root layout's
    // toaster subscribes, and a toast fired then is never shown.
    const announced = useRef(false);
    useEffect(() => {
        if (!notice || announced.current) return;
        announced.current = true;

        if (notice === EVER_ID_CONNECTED_NOTICE) {
            setTimeout(() => toast.success(t('connectedToast')), 0);
        }
        router.replace(ROUTES.DASHBOARD_SETTINGS_SECURITY, { scroll: false });
    }, [notice, router, t]);

    const items = identities?.items ?? [];
    const canDisconnect = identities?.canDisconnect !== false;
    const manageUrl = isHttpUrl(identities?.manageUrl) ? identities?.manageUrl : undefined;
    const reauthRequired = connectError?.code === 'reauth_required' || reauthFromNotice;

    if (items.length === 0 && !canConnect) {
        return null;
    }

    const formatDate = (value: string): string => {
        const date = toDate(value);
        return date
            ? format.dateTime(date, { day: 'numeric', month: 'short', year: 'numeric' })
            : value;
    };

    const formatAgo = (value: string): string => {
        const date = toDate(value);
        return date ? format.relativeTime(date) : value;
    };

    const connect = () => {
        setConnectError(null);
        startConnect(async () => {
            // Only a failure comes back: success navigates away to Ever ID.
            const result = await startEverIdConnect();
            if (result && !result.success) {
                setConnectError({ message: result.error, code: result.code });
            }
        });
    };

    const signInAgain = () => {
        startSignInAgain(async () => {
            await signInAgainToConnectEverId();
        });
    };

    const closeDisconnect = () => {
        if (isDisconnecting) return;
        setDisconnectTarget(null);
        setDisconnectError(null);
    };

    const confirmDisconnect = () => {
        if (!disconnectTarget) return;
        const target = disconnectTarget;
        setDisconnectError(null);
        startDisconnect(async () => {
            const result = await disconnectEverId(target.id);
            if (result.success) {
                setDisconnectTarget(null);
                toast.success(t('disconnectedToast'));
                router.refresh();
            } else {
                setDisconnectError(result.error);
            }
        });
    };

    return (
        <section
            aria-labelledby={headingId}
            className="space-y-4"
            data-testid="connected-identities-card"
        >
            <div className="flex items-center gap-2">
                <Fingerprint
                    className="w-5 h-5 text-text-muted dark:text-text-muted-dark"
                    aria-hidden="true"
                />
                <h3 id={headingId} className="text-lg font-medium text-text dark:text-text-dark">
                    {t('title')}
                </h3>
            </div>

            <div className="space-y-4 pl-7">
                <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('subtitle')}</p>

                {items.length === 0 ? (
                    <div
                        data-testid="ever-id-not-connected"
                        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border dark:border-border-dark p-4"
                    >
                        <p className="flex items-center gap-2 text-sm text-text dark:text-text-dark">
                            <Diamond className="w-4 h-4 shrink-0" aria-hidden="true" />
                            <span className="font-medium">{t('everIdLabel')}</span>
                            <span className="text-text-muted dark:text-text-muted-dark">
                                {t('notConnected')}
                            </span>
                        </p>
                        <Button
                            type="button"
                            size="sm"
                            data-testid="ever-id-connect"
                            onClick={connect}
                            loading={isConnecting}
                            aria-busy={isConnecting}
                        >
                            {isConnecting ? tEverId('redirecting') : t('connect')}
                        </Button>
                    </div>
                ) : (
                    <ul className="space-y-3">
                        {items.map((identity) => (
                            <li
                                key={identity.id}
                                data-testid="ever-id-identity"
                                className="space-y-3 rounded-lg border border-border dark:border-border-dark p-4"
                            >
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0 space-y-1">
                                        <p className="flex items-center gap-2 text-sm font-medium text-text dark:text-text-dark">
                                            <Diamond
                                                className="w-4 h-4 shrink-0"
                                                aria-hidden="true"
                                            />
                                            {identity.displayName || t('everIdLabel')}
                                        </p>
                                        <p className="text-sm text-text dark:text-text-dark break-all">
                                            {t('connectedLine', {
                                                email: identity.email,
                                                date: formatDate(identity.linkedAt),
                                            })}
                                        </p>
                                        {identity.lastLoginAt ? (
                                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                                {t('lastUsed', {
                                                    ago: formatAgo(identity.lastLoginAt),
                                                })}
                                            </p>
                                        ) : null}
                                    </div>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="secondary"
                                        data-testid="ever-id-disconnect"
                                        onClick={() => setDisconnectTarget(identity)}
                                        disabled={!canDisconnect}
                                        aria-describedby={canDisconnect ? undefined : blockedId}
                                    >
                                        {t('disconnect')}
                                    </Button>
                                </div>

                                {identity.delegatedClients.length > 0 ? (
                                    <div data-testid="ever-id-delegated-apps" className="space-y-2">
                                        <h4 className="text-sm font-medium text-text dark:text-text-dark">
                                            {t('appsTitle')}
                                        </h4>
                                        <ul className="space-y-1">
                                            {identity.delegatedClients.map((client) => (
                                                <li
                                                    key={client.clientId}
                                                    className="text-sm text-text-muted dark:text-text-muted-dark"
                                                >
                                                    {t('appLastUsed', {
                                                        app: client.displayName || client.clientId,
                                                        ago: formatAgo(client.lastSeenAt),
                                                    })}
                                                </li>
                                            ))}
                                        </ul>
                                        {manageUrl ? (
                                            <a
                                                href={manageUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                data-testid="ever-id-manage"
                                                className="inline-flex items-center gap-1 text-sm text-primary hover:text-primary-hover"
                                            >
                                                {t('manageInEverId')}
                                                <ExternalLink
                                                    className="w-3.5 h-3.5"
                                                    aria-hidden="true"
                                                />
                                                <span className="sr-only">
                                                    {t('opensInNewTab')}
                                                </span>
                                            </a>
                                        ) : null}
                                    </div>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                )}

                {items.length > 0 && !canDisconnect ? (
                    <div
                        id={blockedId}
                        data-testid="ever-id-cannot-disconnect"
                        className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/10 px-4 py-3 text-sm text-text dark:text-text-dark"
                    >
                        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                        <div className="space-y-1">
                            <p>{t('cannotDisconnect')}</p>
                            <Link
                                href={ROUTES.AUTH_FORGOT_PASSWORD}
                                className="font-medium text-primary hover:text-primary-hover"
                            >
                                {t('setPassword')}
                            </Link>
                        </div>
                    </div>
                ) : null}

                {items.length > 0 && turnedOff ? (
                    <p
                        data-testid="ever-id-turned-off"
                        className="text-sm text-text-muted dark:text-text-muted-dark"
                    >
                        {t('turnedOff')}
                    </p>
                ) : null}

                {reauthRequired ? (
                    <div
                        role="alert"
                        data-testid="ever-id-reauth"
                        className="space-y-2 rounded-lg border border-warning/20 bg-warning/10 px-4 py-3 text-sm text-text dark:text-text-dark"
                    >
                        <p>{tError('reauthRequired')}</p>
                        <Button
                            type="button"
                            size="sm"
                            data-testid="ever-id-sign-in-again"
                            onClick={signInAgain}
                            loading={isSigningInAgain}
                        >
                            {t('signInAgain')}
                        </Button>
                    </div>
                ) : connectError ? (
                    <p
                        role="alert"
                        data-testid="ever-id-connect-error"
                        className="rounded-lg border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger"
                    >
                        {connectError.message}
                    </p>
                ) : null}
            </div>

            <Dialog
                open={disconnectTarget !== null}
                onOpenChange={(next) => {
                    if (!next) closeDisconnect();
                }}
            >
                <DialogContent className="max-w-md">
                    <div data-testid="ever-id-disconnect-dialog">
                        <DialogTitle className="sr-only">{t('disconnect')}</DialogTitle>
                        <DialogDescription className="mt-0 text-sm text-text dark:text-text-dark">
                            {t('disconnectBody')}
                        </DialogDescription>

                        {disconnectError ? (
                            <p
                                role="alert"
                                data-testid="ever-id-disconnect-error"
                                className="mt-4 rounded-lg border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger"
                            >
                                {disconnectError}
                            </p>
                        ) : null}

                        <DialogFooter>
                            <Button
                                type="button"
                                variant="ghost"
                                data-testid="ever-id-disconnect-keep"
                                onClick={closeDisconnect}
                                disabled={isDisconnecting}
                            >
                                {t('keep')}
                            </Button>
                            <Button
                                type="button"
                                variant="danger"
                                data-testid="ever-id-disconnect-confirm"
                                onClick={confirmDisconnect}
                                loading={isDisconnecting}
                            >
                                {t('disconnect')}
                            </Button>
                        </DialogFooter>
                    </div>
                </DialogContent>
            </Dialog>
        </section>
    );
}
