import { getAuthFromCookie } from '@/lib/auth';
import { authAPI } from '@/lib/api/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { RepoProvider } from '@/lib/api/enums';
import { OAuthConnections } from '@/components/settings/OAuthConnections';

export default async function OAuthSettingsPage() {
    const user = await getAuthFromCookie();

    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

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