'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { acceptClaim } from '@/app/actions/claim';
import type { ClaimPreview, ClaimAcceptResult } from '@/lib/api/claim';

interface ClaimFormProps {
    token: string;
    locale: string;
    preview: ClaimPreview;
}

export function ClaimForm({ token, locale, preview }: ClaimFormProps) {
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<ClaimAcceptResult | null>(null);

    const isOwnerClaim = preview.role === 'owner-claim';

    if (result) {
        return (
            <div className="rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 p-4 space-y-3 text-sm">
                <p className="font-medium">Invitation accepted</p>
                {result.transferStatus === 'pending_recipient_acceptance' ? (
                    <>
                        <p>
                            The repository transfer is pending. Accept it on your git
                            provider to finish handover.
                        </p>
                        {result.providerAcceptanceUrl ? (
                            <a
                                href={result.providerAcceptanceUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-block underline"
                            >
                                Open transfer page →
                            </a>
                        ) : null}
                    </>
                ) : result.transferStatus === 'completed' ? (
                    <p>Repository transfer completed.</p>
                ) : result.transferStatus === 'failed' ? (
                    <p>
                        The repository transfer attempt failed. The invitation is
                        recorded — contact the inviter to retry.
                    </p>
                ) : (
                    <p>
                        You now have access to{' '}
                        <a
                            href={`/${locale}/works/${result.workId}`}
                            className="underline"
                        >
                            {preview.workName}
                        </a>
                        .
                    </p>
                )}
                {result.transferStatus !== 'pending_recipient_acceptance' &&
                result.workId ? (
                    <a
                        href={`/${locale}/works/${result.workId}`}
                        className="inline-block underline"
                    >
                        Go to {preview.workName} →
                    </a>
                ) : null}
            </div>
        );
    }

    const onAccept = () => {
        setError(null);
        startTransition(async () => {
            const outcome = await acceptClaim(token);
            if (outcome.ok) {
                setResult(outcome.result);
            } else {
                setError(humanizeAcceptError(outcome.error));
            }
        });
    };

    return (
        <div className="space-y-3">
            {error ? (
                <div className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-3 text-sm">
                    {error}
                </div>
            ) : null}
            <Button onClick={onAccept} disabled={pending} className="w-full">
                {pending
                    ? 'Accepting…'
                    : isOwnerClaim
                      ? 'Accept and start transfer'
                      : 'Accept invitation'}
            </Button>
            {isOwnerClaim ? (
                <p className="text-xs text-text-secondary">
                    Accepting will initiate the repository transfer. You may need
                    to confirm on your git provider afterward.
                </p>
            ) : null}
        </div>
    );
}

function humanizeAcceptError(code: string): string {
    if (code.includes('mismatch')) {
        return 'The signed-in account does not match the recipient on this invitation.';
    }
    if (code.includes('expired')) return 'This invitation has expired.';
    if (code.includes('revoked')) return 'This invitation has been revoked.';
    if (code.includes('already')) return 'This invitation has already been accepted.';
    if (code.includes('state_changed')) {
        return 'Someone else just accepted or revoked this invitation.';
    }
    if (code === 'claim_failed' || code === 'preview_failed') {
        return 'We could not complete the claim. Please try again.';
    }
    return code;
}
