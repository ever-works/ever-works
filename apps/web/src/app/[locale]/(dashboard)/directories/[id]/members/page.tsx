import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { directoryAPI, membersAPI } from '@/lib/api';
import { MembersPage } from '@/components/directories/detail/members/MembersPage';
import { canManageMembers } from '@/lib/permissions';
import { notFound } from 'next/navigation';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('members') };
}

type Params = { params: Promise<{ id: string }> };

export default async function DirectoryMembersPage({ params }: Params) {
    const { id } = await params;

    let directory;
    let membersRes;

    try {
        const [directoryResult, membersResult] = await Promise.all([
            directoryAPI.get(id),
            membersAPI.list(id),
        ]);

        directory = directoryResult.directory;
        membersRes = membersResult;
    } catch {
        notFound();
    }

    if (!canManageMembers(directory.userRole)) {
        notFound();
    }

    return (
        <MembersPage directory={directory} members={membersRes.members} owner={membersRes.owner} />
    );
}
