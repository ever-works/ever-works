'use client';

import { useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
    inviteToOrganizationAction,
    listOrgMembersAction,
    removeOrgMemberAction,
    revokeOrgInvitationAction,
    type InviteErrorCode,
} from '@/app/actions/dashboard/org-members';
import type { OrgInvitation, OrgMember } from '@/lib/api/org-members';

interface Props {
    organizationId: string;
}

/**
 * Invite people into an Organization, and manage who is already in it.
 *
 * Implements the members half of
 * `docs/specs/features/tenants-and-organizations/spec.md` §6.4, which
 * deferred it to v1.1.
 *
 * 🛑 Worth knowing while reading this: membership is TENANT-wide. Someone
 * invited to one Organization can see every Organization in that Tenant —
 * the owner accepted that explicitly for v1 rather than take on rewriting
 * `ensureMember`, `listForUser`, `ScopeOwnershipGuard` and the scope-stamping
 * read side. The copy below says so out loud rather than letting people
 * discover it.
 */
export function OrganizationMembersSection({ organizationId }: Props) {
    const t = useTranslations('organizations.settings.members');
    const [pending, startTransition] = useTransition();
    const [email, setEmail] = useState('');
    const [members, setMembers] = useState<OrgMember[]>([]);
    const [invitations, setInvitations] = useState<OrgInvitation[]>([]);
    const [loading, setLoading] = useState(true);

    const refresh = () => {
        startTransition(async () => {
            const data = await listOrgMembersAction(organizationId);
            setMembers(data.members);
            setInvitations(data.invitations);
            setLoading(false);
        });
    };

    useEffect(() => {
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [organizationId]);

    const handleInvite = () => {
        const trimmed = email.trim();
        if (!trimmed || pending) return;
        startTransition(async () => {
            const result = await inviteToOrganizationAction(organizationId, trimmed);
            if (result.status === 'sent') {
                toast.success(t('inviteSent', { email: trimmed }));
                setEmail('');
            } else if (result.code === 'user_added_directly') {
                // A 400 that is really a success — see the action's comment.
                toast.success(t('addedDirectly', { email: trimmed }));
                setEmail('');
            } else {
                toast.error(t(`errors.${result.code}` as never));
            }
            refresh();
        });
    };

    const pendingInvites = invitations.filter((i) => i.status === 'pending');

    return (
        <section className="space-y-4" data-testid="org-members-section">
            <div>
                <h3 className="text-lg font-medium">{t('title')}</h3>
                <p className="text-sm text-text-secondary">{t('subtitle')}</p>
            </div>

            <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                <div className="flex-1 min-w-0">
                    <label htmlFor="org-invite-email" className="block text-xs mb-1">
                        {t('emailLabel')}
                    </label>
                    <input
                        id="org-invite-email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder={t('emailPlaceholder')}
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                        data-testid="org-invite-email"
                    />
                </div>
                <Button
                    onClick={handleInvite}
                    disabled={!email.trim() || pending}
                    loading={pending}
                    data-testid="org-invite-submit"
                    className="shrink-0"
                >
                    {t('inviteCta')}
                </Button>
            </div>

            <p className="text-xs text-text-secondary">{t('tenantWideNote')}</p>

            <div>
                <h4 className="text-sm font-medium mb-2">{t('membersHeading')}</h4>
                {loading ? (
                    <p className="text-sm text-text-secondary">{t('loading')}</p>
                ) : members.length === 0 ? (
                    <p className="text-sm text-text-secondary">{t('noMembers')}</p>
                ) : (
                    <ul className="divide-y divide-border" data-testid="org-members-list">
                        {members.map((m) => (
                            <li key={m.id} className="flex items-center justify-between py-2">
                                {/* Identity comes from the API, which resolves it
                                    from `users`. Rendering `m.userId` showed a raw
                                    UUID — unusable for the one decision this list
                                    exists to support. The id remains the fallback
                                    only if the User row has genuinely vanished. */}
                                <span className="text-sm">{m.username ?? m.email ?? m.userId}</span>
                                {/* `isSelf` is computed SERVER-side. This used to
                                    compare against a `currentUserId` prop that the
                                    parent never passed, so it was always undefined
                                    and every member — including you — was offered a
                                    Remove button that clears their own tenant
                                    access. */}
                                {m.isSelf ? (
                                    <span className="text-xs text-text-secondary">{t('you')}</span>
                                ) : (
                                    <button
                                        type="button"
                                        disabled={pending}
                                        onClick={() =>
                                            startTransition(async () => {
                                                try {
                                                    await removeOrgMemberAction(
                                                        organizationId,
                                                        m.userId,
                                                    );
                                                    toast.success(t('memberRemoved'));
                                                } catch {
                                                    toast.error(t('errors.unknown'));
                                                }
                                                refresh();
                                            })
                                        }
                                        className="text-xs underline disabled:opacity-50"
                                    >
                                        {t('remove')}
                                    </button>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {pendingInvites.length > 0 ? (
                <div>
                    <h4 className="text-sm font-medium mb-2">{t('pendingHeading')}</h4>
                    <ul className="divide-y divide-border" data-testid="org-pending-list">
                        {pendingInvites.map((i) => (
                            <li key={i.id} className="flex items-center justify-between py-2">
                                <span className="text-sm">{i.email}</span>
                                <button
                                    type="button"
                                    disabled={pending}
                                    onClick={() =>
                                        startTransition(async () => {
                                            try {
                                                await revokeOrgInvitationAction(
                                                    organizationId,
                                                    i.id,
                                                );
                                                toast.success(t('invitationRevoked'));
                                            } catch {
                                                toast.error(t('errors.unknown'));
                                            }
                                            refresh();
                                        })
                                    }
                                    className="text-xs underline disabled:opacity-50"
                                >
                                    {t('revoke')}
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </section>
    );
}

/** Exported for the spec, which asserts every code has its own message. */
export const INVITE_ERROR_CODES: InviteErrorCode[] = [
    'invitation_already_pending',
    'user_already_a_member',
    'invalid_email',
    'organization_has_no_tenant',
    'unknown',
];
