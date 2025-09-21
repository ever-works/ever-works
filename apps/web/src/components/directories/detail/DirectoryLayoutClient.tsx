'use client';

import { useEffect } from 'react';
import { useRouter } from '@/i18n/navigation';
import { Directory } from '@/lib/api/types-only';
import { DirectoryHeader } from './DirectoryHeader';
import { DirectoryTabs } from './DirectoryTabs';
import { GenerateStatusType } from '@/lib/api/enums';

interface DirectoryLayoutClientProps {
    directory: Directory;
    children: React.ReactNode;
}

export function DirectoryLayoutClient({ directory, children }: DirectoryLayoutClientProps) {
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
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
            <DirectoryHeader directory={directory} />
            <DirectoryTabs directoryId={directory.id} />
            <div className="mt-6">{children}</div>
        </div>
    );
}
