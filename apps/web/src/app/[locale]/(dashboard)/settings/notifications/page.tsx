import { getAuthFromCookie } from '@/lib/auth';
import { authAPI } from '@/lib/api/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { NotificationSettings } from '@/components/settings/NotificationSettings';

export default async function NotificationSettingsPage() {
    const user = await getAuthFromCookie();

    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const profile = await authAPI.getFreshProfile();

    return <NotificationSettings user={profile} />;
}