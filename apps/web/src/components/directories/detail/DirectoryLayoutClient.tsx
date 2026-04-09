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
import { useBackgroundActivity } from '@/lib/hooks/use-background-activity';

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
    const previousGenerateStatus = lastGenerateStatus.current;
    const hasSyncedOnMount = useRef(false);
    const generateStatus = directory.generateStatus?.status;
    const { markGenerating, clearGenerating } = useBackgroundActivity();

    // Sync generation state with the global sidebar indicator
    useEffect(() => {
        if (isGenerating) {
            markGenerating();
        } else {
            clearGenerating();
        }
    }, [isGenerating, markGenerating, clearGenerating]);

    useEffect(() => {
        const lastStatus = previousGenerateStatus;
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
    }, [directory.generateStatus?.status, previousGenerateStatus, t]);

    useEffect(() => {
        if (isGenerating) {
            const cleanup = pageIntervalRefresh(router, 10_000);
            return cleanup;
        }
    }, [isGenerating, router]);

    useEffect(() => {
        if (hasSyncedOnMount.current) {
            return;
        }

        hasSyncedOnMount.current = true;
        syncDirectoryData(directory.id).catch(() => {
            // Silent fail; best effort
        });
    }, [directory.id]);

    useEffect(() => {
        if (
            previousGenerateStatus === GenerateStatusType.GENERATING &&
            generateStatus === GenerateStatusType.GENERATED
        ) {
            syncDirectoryData(directory.id).catch(() => {
                // Silent fail; best effort
            });
        }
    }, [directory.id, generateStatus, previousGenerateStatus]);

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
