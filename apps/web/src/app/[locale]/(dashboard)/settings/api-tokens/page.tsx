import { authAPI } from '@/lib/api/auth';
import { ApiTokenSettings } from '@/components/settings/ApiTokenSettings';

export default async function ApiTokensSettingsPage() {
    const profile = await authAPI.getFreshProfile();

    return <ApiTokenSettings user={profile} />;
}
