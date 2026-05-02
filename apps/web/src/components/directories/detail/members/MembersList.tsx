'use client';

import { useTranslations } from 'next-intl';
import { Directory, DirectoryMember, DirectoryOwner } from '@/lib/api';
import { MemberRow } from './MemberRow';
import { canManageMembers } from '@/lib/permissions';

interface MembersListProps {
    directory: Directory;
    members: DirectoryMember[];
    owner: DirectoryOwner;
    onMemberRemoved: (memberId: string) => void;
    onMemberUpdated: (member: DirectoryMember) => void;
}

export function MembersList({
    directory,
    members,
    owner,
    onMemberRemoved,
    onMemberUpdated,
}: MembersListProps) {
    const t = useTranslations('dashboard.workDetail.members');

    return (
        <div className="bg-surface dark:bg-surface-dark border border-border dark:border-border-dark rounded-lg overflow-hidden">
            <div className="divide-y divide-border dark:divide-border-dark">
                <div className="px-4 py-3 flex items-center gap-4 bg-surface-secondary dark:bg-surface-secondary-dark">
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-medium">
                        {owner.username.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                            <span className="font-medium text-text dark:text-text-dark truncate">
                                {owner.username}
                            </span>
                            <span className="px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary">
                                {t('roles.creator')}
                            </span>
                        </div>
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark truncate">
                            {owner.email}
                        </p>
                    </div>
                </div>

                {members.length === 0 ? (
                    <div className="px-4 py-8 text-center text-text-secondary dark:text-text-secondary-dark">
                        {t('noMembers')}
                    </div>
                ) : (
                    members.map((member) => (
                        <MemberRow
                            key={member.id}
                            directoryId={directory.id}
                            member={member}
                            canManage={canManageMembers(directory.userRole)}
                            onRemoved={() => onMemberRemoved(member.id)}
                            onUpdated={onMemberUpdated}
                        />
                    ))
                )}
            </div>
        </div>
    );
}
