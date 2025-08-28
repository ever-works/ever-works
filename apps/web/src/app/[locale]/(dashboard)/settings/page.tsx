import { getAuthUser } from '@/lib/auth';
import { authAPI } from '@/lib/api/auth';
import { SettingsClient } from './settings-client';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { RepoProvider } from '@/lib/api/enums';

export default async function SettingsPage() {
    const user = await getAuthUser();

    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    // const repos = await authAPI.oauth_connections.getGitHubOrgs();
    // console.log('repos', repos);

    // Get fresh profile and OAuth connections
    const [profile, connections] = await Promise.all([
        authAPI.getFreshProfile(),
        authAPI.oauth_connections.checkConnection(RepoProvider.GITHUB),
    ]);

    return (
        <SettingsClient
            user={profile}
            githubConnected={!!connections.connected}
            githubScopes={connections?.scopes || []}
        />
    );
}
