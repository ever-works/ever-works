'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Work, WorkMember, WorkOwner } from '@/lib/api';
import { MembersList } from './MembersList';
import { InviteMemberDialog } from './InviteMemberDialog';
import { Button } from '@/components/ui/button';
import { canManageMembers } from '@/lib/permissions';

interface MembersPageProps {
    work: Work;
    members: WorkMember[];
    owner: WorkOwner;
}

export function MembersPage({ work, members: initialMembers, owner }: MembersPageProps) {
    const t = useTranslations('dashboard.workDetail.members');
    const [members, setMembers] = useState(initialMembers);
    const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
    const canInvite = canManageMembers(work.userRole);

    const handleMemberAdded = (member: WorkMember) => {
        setMembers((prev) => [...prev, member]);
    };

    const handleMemberRemoved = (memberId: string) => {
        setMembers((prev) => prev.filter((m) => m.id !== memberId));
    };

    const handleMemberUpdated = (updated: WorkMember) => {
        setMembers((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h2>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1">
                        {t('subtitle')}
                    </p>
                </div>
                {canInvite && (
                    <Button onClick={() => setInviteDialogOpen(true)} size="sm">
                        {t('inviteMember')}
                    </Button>
                )}
            </div>

            <MembersList
                work={work}
                members={members}
                owner={owner}
                onMemberRemoved={handleMemberRemoved}
                onMemberUpdated={handleMemberUpdated}
            />

            <InviteMemberDialog
                workId={work.id}
                open={inviteDialogOpen}
                onOpenChange={setInviteDialogOpen}
                onMemberAdded={handleMemberAdded}
            />
        </div>
    );
}
