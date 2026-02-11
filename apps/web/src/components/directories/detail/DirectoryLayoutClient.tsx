'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from '@/i18n/navigation';
import { GitProviderConnectionInfo, Directory, DirectoryConfig } from '@/lib/api/types-only';
import { DirectoryHeader } from './DirectoryHeader';
import { DirectoryTabs } from './DirectoryTabs';
import { GenerateStatusType } from '@/lib/api/enums';
import { DirectoryDetailProvider } from './DirectoryDetailContext';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { pageIntervalRefresh } from '@/lib/utils';
import { syncDirectoryData } from '@/app/actions/dashboard/directories';

interface DirectoryLayoutClientProps {
    directory: Directory;
    children: React.ReactNode;
    oauthConnection: GitProviderConnectionInfo | null;
    config: DirectoryConfig | null;
}

export function DirectoryLayoutClient({
    directory,
    oauthConnection,
    config,
    children,
}: DirectoryLayoutClientProps) {
    const router = useRouter();
    const t = useTranslations('dashboard.directoryDetail');
    const isGenerating = directory.generateStatus?.status === GenerateStatusType.GENERATING;
    const lastGenerateStatus = useRef(directory.generateStatus?.status);
    const generateStatus = directory.generateStatus?.status;

    useEffect(() => {
        const lastStatus = lastGenerateStatus.current;
        const currentStatus = directory.generateStatus?.status;

        if (lastStatus !== currentStatus && currentStatus === GenerateStatusType.ERROR) {
            toast.error(t('failedToGenerateItems'), {
                id: 'failed-to-generate-items',
            });
        }

        if (lastStatus !== currentStatus && currentStatus === GenerateStatusType.GENERATED) {
            toast.success(t('generationCompleted'), {
                id: 'generation-complete',
            });
        }

        if (lastStatus !== currentStatus && currentStatus === GenerateStatusType.CANCELLED) {
            toast.info(t('generationCancelled'), {
                id: 'generation-cancelled',
            });
        }

        lastGenerateStatus.current = directory.generateStatus?.status;
    }, [generateStatus]);

    useEffect(() => {
        if (isGenerating) {
            const cleanup = pageIntervalRefresh(router);
            return cleanup;
        }
    }, [isGenerating, router]);

    useEffect(() => {
        syncDirectoryData(directory.id).catch(() => {
            // Silent fail; best effort
        });

        // we want also sync when generateStatus changes
    }, [directory.id, generateStatus, router]);

    return (
        <DirectoryDetailProvider
            directory={directory}
            oauthConnection={oauthConnection}
            config={config}
        >
            <div className="w-full">
                <DirectoryHeader directory={directory} />
                <DirectoryTabs directory={directory} />

                <div className="mt-6">{children}</div>
            </div>
        </DirectoryDetailProvider>
    );
}
