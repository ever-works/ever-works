import { authAPI } from '@/lib/api/auth';
import { SecuritySettings } from '@/components/settings/SecuritySettings';

export default async function SecuritySettingsPage() {
    // Get fresh profile
    const profile = await authAPI.getFreshProfile();

    return <SecuritySettings user={profile} />;
}
