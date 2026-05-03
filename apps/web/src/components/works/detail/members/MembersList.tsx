'use client';

import { useTranslations } from 'next-intl';
import { Work, WorkMember, WorkOwner } from '@/lib/api';
import { MemberRow } from './MemberRow';
import { canManageMembers } from '@/lib/permissions';

interface MembersListProps {
    work: Work;
    members: WorkMember[];
    owner: WorkOwner;
    onMemberRemoved: (memberId: string) => void;
    onMemberUpdated: (member: WorkMember) => void;
}

export function MembersList({
    work,
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
                            workId={work.id}
                            member={member}
                            canManage={canManageMembers(work.userRole)}
                            onRemoved={() => onMemberRemoved(member.id)}
                            onUpdated={onMemberUpdated}
                        />
                    ))
                )}
            </div>
        </div>
    );
}
