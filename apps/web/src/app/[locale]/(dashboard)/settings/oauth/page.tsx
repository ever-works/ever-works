import { authAPI } from '@/lib/api/auth';
import { RepoProvider } from '@/lib/api/enums';
import { OAuthConnections } from '@/components/settings/OAuthConnections';

export default async function OAuthSettingsPage() {
    const [profile, connections] = await Promise.all([
        authAPI.getFreshProfile(),
        authAPI.oauth_connections.checkConnection(RepoProvider.GITHUB),
    ]);

    return (
        <OAuthConnections
            user={profile}
            githubConnected={!!connections.connected}
            googleConnected={false}
            githubScopes={connections?.scopes || []}
            googleScopes={[]}
        />
    );
}
