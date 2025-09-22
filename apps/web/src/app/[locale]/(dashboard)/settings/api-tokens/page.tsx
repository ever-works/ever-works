import { getAuthFromCookie } from '@/lib/auth';
import { authAPI } from '@/lib/api/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { ApiTokenSettings } from '@/components/settings/ApiTokenSettings';

export default async function ApiTokensSettingsPage() {
    const user = await getAuthFromCookie();

    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const profile = await authAPI.getFreshProfile();

    return <ApiTokenSettings user={profile} />;
}
