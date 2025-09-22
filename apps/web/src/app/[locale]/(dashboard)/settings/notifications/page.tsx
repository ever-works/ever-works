import { authAPI } from '@/lib/api/auth';
import { NotificationSettings } from '@/components/settings/NotificationSettings';

export default async function NotificationSettingsPage() {
    const profile = await authAPI.getFreshProfile();

    return <NotificationSettings user={profile} />;
}
