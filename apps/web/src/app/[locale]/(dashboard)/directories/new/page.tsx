import { getAuthUser } from '@/lib/auth';
import { authAPI } from '@/lib/api/auth';
import NewDirectoryClient from './new-directory-client';

export default async function NewDirectoryPage() {
    const user = await getAuthUser();

    // Check GitHub connection on the server
    let githubConnected = false;
    try {
        const connection = await authAPI.oauth_connections.checkConnection('github');
        githubConnected = connection.connected || false;
    } catch (error) {
        console.error('Failed to check GitHub connection:', error);
    }

    return <NewDirectoryClient user={user!} githubConnected={githubConnected} />;
}
