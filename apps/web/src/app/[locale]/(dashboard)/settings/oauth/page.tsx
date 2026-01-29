import { authAPI } from '@/lib/api/auth';
import { RepoProvider } from '@/lib/api/enums';
import { OAuthConnections } from '@/components/settings/OAuthConnections';

export default async function OAuthSettingsPage() {
    const [profile, githubConnection] = await Promise.all([
        authAPI.getFreshProfile(),
        authAPI.oauth_connections.checkConnection(RepoProvider.GITHUB),
    ]);

    // Fetch organizations only if GitHub is connected
    const organizations = githubConnection?.connected
        ? await authAPI.oauth_connections.getGitHubOrgs().catch(() => [])
        : [];

    return (
        <OAuthConnections
            user={profile}
            githubConnection={githubConnection}
            googleConnection={null}
            organizations={organizations}
        />
    );
}
