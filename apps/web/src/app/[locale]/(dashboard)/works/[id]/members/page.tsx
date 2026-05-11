import { redirect } from 'next/navigation';

type Params = { params: Promise<{ id: string; locale: string }> };

export default async function LegacyMembersRedirect({ params }: Params) {
    const { id, locale } = await params;
    redirect(`/${locale}/works/${id}/settings/members`);
}
