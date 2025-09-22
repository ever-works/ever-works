import { getAuthFromCookie } from '@/lib/auth';
import { authAPI } from '@/lib/api/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { SecuritySettings } from '@/components/settings/SecuritySettings';

export default async function SecuritySettingsPage() {
    const user = await getAuthFromCookie();

    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const profile = await authAPI.getFreshProfile();

    return <SecuritySettings user={profile} />;
}