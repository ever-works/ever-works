import { Directory, directoryAPI, gitProvidersAPI, GitProviderConnectionInfo } from '@/lib/api';
import { notFound } from 'next/navigation';
import { DirectoryLayoutClient } from '@/components/directories/detail/DirectoryLayoutClient';

type LayoutParams = {
    params: Promise<{ id: string }>;
    children: React.ReactNode;
};

export default async function DirectoryLayout({ params, children }: LayoutParams) {
    const { id } = await params;

    let directory: Directory;
    let oauthConnection: GitProviderConnectionInfo | null = null;
    let config = null;

    try {
        const [res, configRes] = await Promise.all([
            directoryAPI.get(id),
            directoryAPI.getConfig(id).catch(() => ({ config: null })),
        ]);

        directory = res.directory;
        config = configRes.config;

        if (directory) {
            oauthConnection = await gitProvidersAPI
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
            config={config}
        >
            {children}
        </DirectoryLayoutClient>
    );
}
