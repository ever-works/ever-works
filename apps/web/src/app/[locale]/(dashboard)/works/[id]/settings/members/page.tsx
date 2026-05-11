import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { workAPI, membersAPI, invitationsAPI } from '@/lib/api';
import type { WorkInvitation } from '@/lib/api/invitations';
import { MembersPage } from '@/components/works/detail/members/MembersPage';
import { canManageMembers, isOwner } from '@/lib/permissions';
import { notFound } from 'next/navigation';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('members') };
}

type Params = { params: Promise<{ id: string }> };

export default async function WorkSettingsMembersPage({ params }: Params) {
    const { id } = await params;

    let work;
    let membersRes;
    let invitations: WorkInvitation[] = [];

    try {
        const [workResult, membersResult] = await Promise.all([
            workAPI.get(id),
            membersAPI.list(id),
        ]);

        work = workResult.work;
        membersRes = membersResult;
    } catch {
        notFound();
    }

    if (!canManageMembers(work.userRole)) {
        notFound();
    }

    try {
        const invRes = await invitationsAPI.list(id);
        invitations = invRes.invitations ?? [];
    } catch {
        invitations = [];
    }

    return (
        <MembersPage
            work={work}
            members={membersRes.members}
            owner={membersRes.owner}
            invitations={invitations}
            currentUserIsOwner={isOwner(work.userRole)}
        />
    );
}
