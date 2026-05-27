import { redirect } from 'next/navigation';

type Params = { params: Promise<{ id: string }> };

export default async function LegacyMembersRedirect({ params }: Params) {
    const { id } = await params;
    redirect(`/works/${id}/settings/members`);
}
