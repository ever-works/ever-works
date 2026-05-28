'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import type {
    CheckSlugAvailabilityResponse,
    OrganizationResponse,
} from '@ever-works/contracts/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { useRouter } from '@/i18n/navigation';
import { useOrganizations } from '@/lib/hooks/use-organizations';
import { UpgradeOrCreateDialog } from './UpgradeOrCreateDialog';

/**
 * Mirror of `User.deriveSlugIfMissing` (and the server-side
 * `UsernameAllocatorService.normalize`) so the live preview matches
 * what the server would allocate when the user submits. We deliberately
 * do NOT call out to the API on every keystroke for normalization —
 * only the availability check is debounced and remote.
 */
function normalizeSlugPreview(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
}

const DEBOUNCE_MS = 300;
const MAX_NAME_LENGTH = 200;

export interface CreateOrganizationModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

type SlugStatus =
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'available'; normalized: string }
    | { kind: 'taken'; normalized: string; suggestion?: string }
    | { kind: 'error'; message: string };

/**
 * EW-661 (Tenants & Organizations Phase 9) — first half of the
 * create-Org flow from spec §5.2.
 *
 * Form contract:
 *   - Single input `Name` (required, 1-200 chars).
 *   - Live, debounced slug-availability check against
 *     `GET /api/organizations/check-slug?value=<name>` shows
 *     "Available" / "Taken (try: acme-2)" hints.
 *   - Submit → `POST /api/organizations` with `{ name }`. The server
 *     allocates the slug + creates the lazy Tenant.
 *
 * Post-submit branching:
 *   - First Org (organizations.length === 0 before submit) → hands off
 *     to `<UpgradeOrCreateDialog>` so the user can choose the upgrade
 *     vs empty branch.
 *   - 2nd+ Org → close modal and navigate to `/{slug}/dashboard`
 *     directly. Subsequent Orgs skip the upgrade dialog entirely
 *     (spec §5.3).
 *
 * Wires into `useOrganizations().mutate()` on success so the
 * `<WorkspaceSwitcher>` populates without a full page reload.
 */
export function CreateOrganizationModal({ open, onOpenChange }: CreateOrganizationModalProps) {
    const t = useTranslations('organizations.create');
    const router = useRouter();
    const { organizations, mutate } = useOrganizations();

    const [name, setName] = useState('');
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [slugStatus, setSlugStatus] = useState<SlugStatus>({ kind: 'idle' });
    const [createdOrg, setCreatedOrg] = useState<OrganizationResponse | null>(null);
    const [showUpgradeDialog, setShowUpgradeDialog] = useState(false);
    /**
     * Captures whether THIS submission is the user's first Org. Read
     * once at submit-time so the post-mutate `organizations.length`
     * can't flip the decision underneath us (post-mutate it's 1).
     */
    const wasFirstOrgRef = useRef(false);

    const slugPreview = useMemo(() => normalizeSlugPreview(name.trim()), [name]);

    // Reset state whenever the modal is closed so reopening starts fresh.
    useEffect(() => {
        if (!open) {
            setName('');
            setSubmitError(null);
            setSlugStatus({ kind: 'idle' });
            setCreatedOrg(null);
            setShowUpgradeDialog(false);
        }
    }, [open]);

    // Debounced slug-availability check. Each keystroke resets the
    // 300ms timer; the request only fires once typing pauses.
    useEffect(() => {
        if (!open) return;
        const trimmed = name.trim();
        if (trimmed.length === 0) {
            setSlugStatus({ kind: 'idle' });
            return;
        }
        setSlugStatus({ kind: 'checking' });
        const controller = new AbortController();
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const res = await fetch(
                        `/api/organizations/check-slug?value=${encodeURIComponent(trimmed)}`,
                        {
                            method: 'GET',
                            signal: controller.signal,
                            cache: 'no-store',
                        },
                    );
                    if (!res.ok) {
                        setSlugStatus({ kind: 'error', message: `HTTP ${res.status}` });
                        return;
                    }
                    const body = (await res.json()) as CheckSlugAvailabilityResponse;
                    if (body.available) {
                        setSlugStatus({ kind: 'available', normalized: body.normalized });
                    } else {
                        setSlugStatus({
                            kind: 'taken',
                            normalized: body.normalized,
                            suggestion: body.suggestion,
                        });
                    }
                } catch (err) {
                    if ((err as { name?: string })?.name === 'AbortError') return;
                    setSlugStatus({
                        kind: 'error',
                        message: err instanceof Error ? err.message : 'Network error',
                    });
                }
            })();
        }, DEBOUNCE_MS);
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [name, open]);

    const handleSubmit = useCallback(() => {
        const trimmed = name.trim();
        if (trimmed.length === 0) {
            setSubmitError(t('errors.nameRequired'));
            return;
        }
        if (trimmed.length > MAX_NAME_LENGTH) {
            setSubmitError(t('errors.nameTooLong'));
            return;
        }
        setSubmitError(null);
        wasFirstOrgRef.current = organizations.length === 0;
        startTransition(() => {
            void (async () => {
                try {
                    const res = await fetch('/api/organizations', {
                        method: 'POST',
                        credentials: 'include',
                        cache: 'no-store',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: trimmed }),
                    });
                    if (!res.ok) {
                        const body = await res
                            .json()
                            .catch(() => ({ error: 'Failed to create Organization' }));
                        setSubmitError(
                            (body as { message?: string; error?: string }).message ??
                                (body as { error?: string }).error ??
                                t('errors.generic'),
                        );
                        return;
                    }
                    const org = (await res.json()) as OrganizationResponse;
                    // Refresh the org list so the switcher updates and
                    // subsequent first-Org checks aren't fooled.
                    await mutate();
                    if (wasFirstOrgRef.current) {
                        // Keep the parent modal mounted but hidden behind
                        // the upgrade dialog so the user can't backtrack
                        // into a half-finished form.
                        setCreatedOrg(org);
                        setShowUpgradeDialog(true);
                    } else {
                        onOpenChange(false);
                        router.push(`/${org.slug}/dashboard`);
                    }
                } catch (err) {
                    setSubmitError(err instanceof Error ? err.message : t('errors.generic'));
                }
            })();
        });
    }, [name, organizations.length, mutate, onOpenChange, router, t]);

    const handleUpgradeDialogClose = useCallback(
        (didUpgrade: boolean) => {
            setShowUpgradeDialog(false);
            const target = createdOrg;
            // Reset modal state then close the outer dialog. Navigation
            // happens after close so a route change doesn't fight the
            // transition.
            setCreatedOrg(null);
            onOpenChange(false);
            if (target) {
                router.push(`/${target.slug}/dashboard`);
                // Pull the freshly-upgraded org list (tenantId is now set
                // on the user, so subsequent fetches reflect that).
                if (didUpgrade) void mutate();
            }
        },
        [createdOrg, mutate, onOpenChange, router],
    );

    // Hide the modal panel while the upgrade dialog is visible so the
    // user only sees one surface at a time. The Dialog `open` prop stays
    // true so the create-modal state isn't reset mid-flow.
    const showCreatePanel = !showUpgradeDialog;

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                {showCreatePanel && (
                    <DialogContent className="max-w-md">
                        <DialogClose onClose={() => onOpenChange(false)} />
                        <DialogHeader>
                            <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                                {t('title')}
                            </DialogTitle>
                            <DialogDescription>{t('description')}</DialogDescription>
                        </DialogHeader>

                        <div className="space-y-4">
                            <Input
                                label={t('nameLabel')}
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder={t('namePlaceholder')}
                                maxLength={MAX_NAME_LENGTH}
                                autoFocus
                                disabled={pending}
                                error={submitError ?? undefined}
                            />

                            <SlugPreview
                                preview={slugPreview}
                                status={slugStatus}
                                t={t}
                                hasName={name.trim().length > 0}
                            />
                        </div>

                        <DialogFooter>
                            <Button
                                variant="ghost"
                                onClick={() => onOpenChange(false)}
                                disabled={pending}
                            >
                                {t('cancel')}
                            </Button>
                            <Button
                                onClick={handleSubmit}
                                loading={pending}
                                disabled={pending || name.trim().length === 0}
                            >
                                {t('submit')}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                )}
            </Dialog>

            {createdOrg && (
                <UpgradeOrCreateDialog
                    open={showUpgradeDialog}
                    organization={createdOrg}
                    onClose={handleUpgradeDialogClose}
                />
            )}
        </>
    );
}

function SlugPreview({
    preview,
    status,
    t,
    hasName,
}: {
    preview: string;
    status: SlugStatus;
    t: ReturnType<typeof useTranslations>;
    hasName: boolean;
}) {
    if (!hasName) {
        return null;
    }
    return (
        <div className="text-xs text-text-muted dark:text-text-muted-dark">
            <div>
                <span className="font-medium text-text-secondary dark:text-text-secondary-dark">
                    {t('slugPreview')}
                </span>{' '}
                <span
                    className="font-mono text-text dark:text-text-dark"
                    data-testid="slug-preview-value"
                >
                    {preview || '—'}
                </span>
            </div>
            <div className="mt-1" data-testid="slug-status">
                {status.kind === 'checking' && <span>{t('slugChecking')}</span>}
                {status.kind === 'available' && (
                    <span className="text-success">{t('slugAvailable')}</span>
                )}
                {status.kind === 'taken' && (
                    <span className="text-warning">
                        {status.suggestion
                            ? t('slugTaken', { suggestion: status.suggestion })
                            : t('slugTakenNoSuggestion')}
                    </span>
                )}
                {status.kind === 'error' && (
                    <span className="text-text-muted dark:text-text-muted-dark">
                        {t('slugCheckError')}
                    </span>
                )}
            </div>
        </div>
    );
}
