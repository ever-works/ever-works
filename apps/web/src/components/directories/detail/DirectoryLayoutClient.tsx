'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from '@/i18n/navigation';
import { ConnectionInfo, Directory, DirectoryConfig } from '@/lib/api/types-only';
import { DirectoryHeader } from './DirectoryHeader';
import { DirectoryTabs } from './DirectoryTabs';
import { GenerateStatusType } from '@/lib/api/enums';
import { DirectoryDetailProvider } from './DirectoryDetailContext';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { pageIntervalRefresh } from '@/lib/utils';

interface DirectoryLayoutClientProps {
    directory: Directory;
    children: React.ReactNode;
    oauthConnection: ConnectionInfo | null;
    scheduleAvailable: boolean;
    config: DirectoryConfig | null;
}

export function DirectoryLayoutClient({
    directory,
    oauthConnection,
    config,
    children,
    scheduleAvailable,
}: DirectoryLayoutClientProps) {
    const router = useRouter();
    const t = useTranslations('dashboard.directoryDetail');
    const isGenerating = directory.generateStatus?.status === GenerateStatusType.GENERATING;
    const lastGenerateStatus = useRef(directory.generateStatus);

    useEffect(() => {
        const lastStatus = lastGenerateStatus.current?.status;
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

        lastGenerateStatus.current = directory.generateStatus;
    }, [directory.generateStatus]);

    useEffect(() => {
        if (isGenerating) {
            const cleanup = pageIntervalRefresh(router);
            return cleanup;
        }
    }, [isGenerating, router]);

    return (
        <DirectoryDetailProvider
            directory={directory}
            oauthConnection={oauthConnection}
            config={config}
        >
            <div className="w-full">
                <DirectoryHeader directory={directory} />
                <DirectoryTabs directory={directory} scheduleAvailable={scheduleAvailable} />

                <div className="mt-6">{children}</div>
            </div>
        </DirectoryDetailProvider>
    );
}
