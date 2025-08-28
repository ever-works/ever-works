import { getAuthUser } from '@/lib/auth';
import { authAPI } from '@/lib/api/auth';
import { SettingsClient } from './settings-client';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';

export default async function SettingsPage() {
    const user = await getAuthUser();

    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    // Get fresh profile and OAuth connections
    const [profile, connections] = await Promise.all([
        authAPI.getFreshProfile(),
        authAPI.oauth_connections.getAll(),
    ]);

    // Check specific OAuth connection status
    const githubConnection = connections.find((c) => c.provider === 'github');

    return (
        <SettingsClient
            user={profile}
            githubConnected={!!githubConnection}
            githubScopes={githubConnection?.scopes || []}
        />
    );
}