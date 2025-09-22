import { getAuthFromCookie } from '@/lib/auth';
import { authAPI, ConnectionInfo } from '@/lib/api/auth';
import NewDirectoryClient from './new-directory-client';

export default async function NewDirectoryPage() {
    const user = await getAuthFromCookie();

    // Check GitHub connection on the server
    let connection: ConnectionInfo | null = null;
    try {
        connection = await authAPI.oauth_connections.checkConnection('github');
    } catch (error) {
        console.error('Failed to check GitHub connection:', error);
    }

    return <NewDirectoryClient user={user!} githubConnection={connection} />;
}
