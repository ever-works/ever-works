import { authAPI, ConnectionInfo, Directory, directoryAPI } from '@/lib/api';
import { notFound } from 'next/navigation';
import { DirectoryLayoutClient } from '@/components/directories/detail/DirectoryLayoutClient';

type LayoutParams = {
    params: Promise<{ id: string }>;
    children: React.ReactNode;
};

export default async function DirectoryLayout({ params, children }: LayoutParams) {
    const { id } = await params;

    let directory: Directory;
    let oauthConnection: ConnectionInfo | null = null;
    let config = null;

    try {
        const res = await directoryAPI.get(id);
        directory = res.directory;

        if (directory) {
            oauthConnection = await authAPI.oauth_connections
                .checkConnection(directory.repoProvider)
                .catch(() => null);

            // Fetch directory config from config.yml
            const configRes = await directoryAPI.getConfig(id).catch(() => ({ config: null }));
            config = configRes.config;
        }
    } catch (error) {
        console.error('Failed to fetch directory:', error);
        notFound();
    }

    return (
        <DirectoryLayoutClient directory={directory} oauthConnection={oauthConnection} config={config}>
            {children}
        </DirectoryLayoutClient>
    );
}
