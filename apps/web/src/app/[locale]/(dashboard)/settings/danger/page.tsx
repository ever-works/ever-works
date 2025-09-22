import { authAPI } from '@/lib/api/auth';
import { DangerZone } from '@/components/settings/DangerZone';

export default async function DangerZoneSettingsPage() {
    const profile = await authAPI.getFreshProfile();

    return <DangerZone user={profile} />;
}
