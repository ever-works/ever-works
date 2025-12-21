import { directoryAPI, membersAPI } from '@/lib/api';
import { MembersPage } from '@/components/directories/detail/members/MembersPage';
import { canManageMembers } from '@/lib/permissions';
import { notFound } from 'next/navigation';

type Params = { params: Promise<{ id: string }> };

export default async function DirectoryMembersPage({ params }: Params) {
    const { id } = await params;

    const [directoryRes, membersRes] = await Promise.all([
        directoryAPI.get(id),
        membersAPI.list(id),
    ]);

    const directory = directoryRes.directory;

    if (!canManageMembers(directory.userRole)) {
        notFound();
    }

    return (
        <MembersPage directory={directory} members={membersRes.members} owner={membersRes.owner} />
    );
}
