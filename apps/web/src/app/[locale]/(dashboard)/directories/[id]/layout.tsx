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
    let scheduleAvailable = false;
    let config = null;

    try {
        const res = await directoryAPI.get(id);
        directory = res.directory;

        let { config } = await directoryAPI.getConfig(id).catch(() => ({ config: null }));
        scheduleAvailable = Boolean(config?.metadata?.initial_prompt);

        if (directory) {
            oauthConnection = await authAPI.oauth_connections
                .checkConnection(directory.repoProvider)
                .catch(() => null);
        }
    } catch (error) {
        console.error('Failed to fetch directory:', error);
        notFound();
    }

    return (
        <DirectoryLayoutClient
            directory={directory}
            oauthConnection={oauthConnection}
            scheduleAvailable={scheduleAvailable}
            config={config}
        >
            {children}
        </DirectoryLayoutClient>
    );
}
