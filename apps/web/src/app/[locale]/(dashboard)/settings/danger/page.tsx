import { getAuthFromCookie } from '@/lib/auth';
import { authAPI } from '@/lib/api/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { DangerZone } from '@/components/settings/DangerZone';

export default async function DangerZoneSettingsPage() {
    const user = await getAuthFromCookie();

    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const profile = await authAPI.getFreshProfile();

    return <DangerZone user={profile} />;
}