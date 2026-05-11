'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { revokeInvitation } from '@/app/actions/invitations';
import type { WorkInvitation } from '@/lib/api/invitations';

interface PendingInvitationsSectionProps {
    workId: string;
    invitations: WorkInvitation[];
    canManage: boolean;
}

export function PendingInvitationsSection({
    workId,
    invitations: initial,
    canManage,
}: PendingInvitationsSectionProps) {
    const [invitations, setInvitations] = useState<WorkInvitation[]>(initial);
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [, startTransition] = useTransition();

    if (invitations.length === 0) return null;

    const handleRevoke = (invitationId: string) => {
        setError(null);
        setPending(invitationId);
        startTransition(async () => {
            const outcome = await revokeInvitation(workId, invitationId);
            setPending(null);
            if (outcome.ok) {
                setInvitations((prev) => prev.filter((i) => i.id !== invitationId));
            } else {
                setError(outcome.error);
            }
        });
    };

    return (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
            <div>
                <h3 className="text-base font-semibold">Pending invitations</h3>
                <p className="text-xs text-text-secondary mt-0.5">
                    Single-use links awaiting acceptance.
                </p>
            </div>

            {error ? (
                <div className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-2 text-xs">
                    {error}
                </div>
            ) : null}

            <ul className="divide-y divide-border">
                {invitations.map((invitation) => {
                    const isOwnerClaim = invitation.role === 'owner-claim';
                    const username =
                        (invitation.metadata?.expectedProviderUsername as
                            | string
                            | undefined) ?? null;
                    return (
                        <li
                            key={invitation.id}
                            className="py-3 flex items-center justify-between gap-3 text-sm"
                        >
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span
                                        className={
                                            'inline-block px-2 py-0.5 rounded-full text-xs font-medium ' +
                                            (isOwnerClaim
                                                ? 'bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200'
                                                : 'bg-indigo-100 dark:bg-indigo-900 text-indigo-800 dark:text-indigo-200')
                                        }
                                    >
                                        {invitation.role}
                                    </span>
                                    {invitation.email ? (
                                        <span className="truncate">{invitation.email}</span>
                                    ) : username ? (
                                        <span className="truncate">@{username}</span>
                                    ) : (
                                        <span className="text-text-secondary">
                                            (link-only)
                                        </span>
                                    )}
                                </div>
                                <p className="text-xs text-text-secondary mt-0.5">
                                    Expires{' '}
                                    {new Date(
                                        invitation.tokenExpiresAt,
                                    ).toLocaleString()}
                                </p>
                            </div>
                            {canManage ? (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => handleRevoke(invitation.id)}
                                    disabled={pending === invitation.id}
                                >
                                    {pending === invitation.id ? 'Revoking…' : 'Revoke'}
                                </Button>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
