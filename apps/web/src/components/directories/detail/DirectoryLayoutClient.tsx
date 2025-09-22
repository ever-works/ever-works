'use client';

import { useEffect } from 'react';
import { useRouter } from '@/i18n/navigation';
import { ConnectionInfo, Directory } from '@/lib/api/types-only';
import { DirectoryHeader } from './DirectoryHeader';
import { DirectoryTabs } from './DirectoryTabs';
import { GenerateStatusType } from '@/lib/api/enums';

interface DirectoryLayoutClientProps {
    directory: Directory;
    children: React.ReactNode;
    oauthConnection: ConnectionInfo | null;
}

export function DirectoryLayoutClient({
    directory,
    oauthConnection,
    children,
}: DirectoryLayoutClientProps) {
    const router = useRouter();
    const isGenerating = directory.generateStatus?.status === GenerateStatusType.GENERATING;

    useEffect(() => {
        if (isGenerating) {
            const interval = setInterval(() => {
                // Save current scroll position
                const scrollY = window.scrollY;
                const scrollX = window.scrollX;

                // Refresh the page
                router.refresh();

                // Restore scroll position after a small delay
                requestAnimationFrame(() => {
                    window.scrollTo(scrollX, scrollY);
                });
            }, 10000); // Refresh every 10 seconds

            return () => clearInterval(interval);
        }
    }, [isGenerating, router]);

    return (
        <div className="w-full">
            <DirectoryHeader
                directory={directory}
                repoLink={repoLink(directory, oauthConnection)}
            />

            <DirectoryTabs directoryId={directory.id} />
            <div className="mt-6">{children}</div>
        </div>
    );
}

function repoLink(directory: Directory, oauthConnection: ConnectionInfo | null) {
    if (!oauthConnection?.connected) {
        return null;
    }

    let providerUrl: string | null = null;

    switch (directory.repoProvider) {
        case 'github':
            providerUrl = 'https://github.com';
            break;

        default:
            return null;
    }

    const username = oauthConnection.username || oauthConnection.metadata?.login;
    if (!username) {
        return null;
    }

    return `${providerUrl}/${username}/${directory.slug}`;
}
