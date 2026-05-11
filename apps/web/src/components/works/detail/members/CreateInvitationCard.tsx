'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { createInvitation } from '@/app/actions/invitations';
import type {
    CreateInvitationResponse,
    InvitationRole,
} from '@/lib/api/invitations';

interface CreateInvitationCardProps {
    workId: string;
    /** True when the current user is the work owner (required for owner-claim). */
    isOwner: boolean;
}

const ROLE_OPTIONS: { value: InvitationRole; label: string; description: string }[] = [
    { value: 'manager', label: 'Manager', description: 'Manage members + content.' },
    { value: 'editor', label: 'Editor', description: 'Edit items + taxonomy.' },
    { value: 'viewer', label: 'Viewer', description: 'Read-only access.' },
    {
        value: 'owner-claim',
        label: 'Owner (claim)',
        description: 'Transfer work ownership on accept.',
    },
];

export function CreateInvitationCard({ workId, isOwner }: CreateInvitationCardProps) {
    const [role, setRole] = useState<InvitationRole>('manager');
    const [email, setEmail] = useState('');
    const [providerUsername, setProviderUsername] = useState('');
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const [latest, setLatest] = useState<CreateInvitationResponse | null>(null);
    const [copied, setCopied] = useState(false);

    const isOwnerClaim = role === 'owner-claim';
    const visibleRoleOptions = isOwner
        ? ROLE_OPTIONS
        : ROLE_OPTIONS.filter((o) => o.value !== 'owner-claim');

    const onSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);

        if (!isOwnerClaim && !email.trim()) {
            setError('Email is required for member-role invitations.');
            return;
        }
        if (isOwnerClaim && !providerUsername.trim()) {
            setError('Provider username is required for owner-claim invitations.');
            return;
        }

        startTransition(async () => {
            const outcome = await createInvitation(workId, {
                role,
                email: email.trim() || undefined,
                expectedProviderUsername: providerUsername.trim() || undefined,
            });
            if (outcome.ok) {
                setLatest(outcome.data);
                setEmail('');
                setProviderUsername('');
                setCopied(false);
            } else {
                setError(outcome.error);
            }
        });
    };

    const onCopy = async () => {
        if (!latest?.claimUrl) return;
        try {
            await navigator.clipboard.writeText(latest.claimUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            setCopied(false);
        }
    };

    return (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
            <div>
                <h3 className="text-base font-semibold">Create invitation</h3>
                <p className="text-xs text-text-secondary mt-0.5">
                    Issues a single-use link that expires after 30 days.
                </p>
            </div>

            <form onSubmit={onSubmit} className="space-y-3">
                <div>
                    <label
                        htmlFor="invite-role"
                        className="block text-xs font-medium mb-1"
                    >
                        Role
                    </label>
                    <select
                        id="invite-role"
                        value={role}
                        onChange={(e) => setRole(e.target.value as InvitationRole)}
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                        disabled={pending}
                    >
                        {visibleRoleOptions.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                                {opt.label} — {opt.description}
                            </option>
                        ))}
                    </select>
                </div>

                {isOwnerClaim ? (
                    <div>
                        <label
                            htmlFor="invite-provider-username"
                            className="block text-xs font-medium mb-1"
                        >
                            Provider username (GitHub login)
                        </label>
                        <input
                            id="invite-provider-username"
                            type="text"
                            value={providerUsername}
                            onChange={(e) => setProviderUsername(e.target.value)}
                            placeholder="avelino"
                            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                            disabled={pending}
                            autoComplete="off"
                            required
                        />
                        <p className="text-xs text-text-secondary mt-1">
                            The claimant must sign in with the account linked to this
                            login.
                        </p>
                    </div>
                ) : null}

                <div>
                    <label
                        htmlFor="invite-email"
                        className="block text-xs font-medium mb-1"
                    >
                        Recipient email{isOwnerClaim ? ' (optional)' : ''}
                    </label>
                    <input
                        id="invite-email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder={
                            isOwnerClaim ? 'leave blank to deliver manually' : 'name@example.com'
                        }
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                        disabled={pending}
                        autoComplete="off"
                        required={!isOwnerClaim}
                    />
                </div>

                {error ? (
                    <div className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-2 text-xs">
                        {error}
                    </div>
                ) : null}

                <Button type="submit" disabled={pending} className="w-full">
                    {pending ? 'Creating…' : 'Create invitation'}
                </Button>
            </form>

            {latest?.claimUrl ? (
                <div className="rounded-md border border-border bg-background p-3 space-y-2">
                    <p className="text-xs font-medium">Claim URL (shown once)</p>
                    <code className="block break-all rounded bg-muted/30 p-2 text-xs">
                        {latest.claimUrl}
                    </code>
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={onCopy}
                    >
                        {copied ? 'Copied!' : 'Copy URL'}
                    </Button>
                </div>
            ) : null}
        </div>
    );
}
