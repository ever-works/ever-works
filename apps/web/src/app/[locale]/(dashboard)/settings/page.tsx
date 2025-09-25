import { authAPI } from '@/lib/api/auth';
import { ProfileSettings } from '@/components/settings/ProfileSettings';

export default async function SettingsPage() {
    // Get fresh profile
    const profile = await authAPI.getFreshProfile();

    return <ProfileSettings user={profile} />;
}
