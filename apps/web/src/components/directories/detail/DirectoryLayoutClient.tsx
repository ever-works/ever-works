'use client';

import { useEffect } from 'react';
import { useRouter } from '@/i18n/navigation';
import { ConnectionInfo, Directory } from '@/lib/api/types-only';
import { DirectoryHeader } from './DirectoryHeader';
import { DirectoryTabs } from './DirectoryTabs';
import { GenerateStatusType, RepoProvider } from '@/lib/api/enums';
import { DirectoryDetailProvider } from './DirectoryDetailContext';

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
            }, 5000); // Refresh every 5 seconds

            return () => clearInterval(interval);
        }
    }, [isGenerating, router]);

    return (
        <DirectoryDetailProvider directory={directory} oauthConnection={oauthConnection}>
            <div className="w-full">
                <DirectoryHeader directory={directory} />

                <DirectoryTabs directory={directory} />
                <div className="mt-6">{children}</div>
            </div>
        </DirectoryDetailProvider>
    );
}
