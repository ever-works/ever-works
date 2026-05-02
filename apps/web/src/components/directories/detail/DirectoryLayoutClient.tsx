'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { GitProviderConnectionInfo, Directory, DirectoryConfig } from '@/lib/api/types-only';
import { DirectoryHeader } from './DirectoryHeader';
import { DirectoryTabs } from './DirectoryTabs';
import { GenerateStatusType } from '@/lib/api/enums';
import { DirectoryDetailProvider } from './DirectoryDetailContext';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    getDirectoryForStatusRefresh,
    syncDirectoryData,
} from '@/app/actions/dashboard/directories';
import { useBackgroundActivity } from '@/lib/hooks/use-background-activity';
import {
    clearDashboardCurrentDirectory,
    setDashboardCurrentDirectory,
} from '@/lib/hooks/use-dashboard-current-directory';

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
    const t = useTranslations('dashboard.workDetail');
    const [syncedDirectory, setSyncedDirectory] = useState(directory);
    const isGenerating = syncedDirectory.generateStatus?.status === GenerateStatusType.GENERATING;
    const lastGenerateStatus = useRef(directory.generateStatus?.status);
    const hasSyncedOnMount = useRef(false);
    const { markGenerating, clearGenerating } = useBackgroundActivity();

    useEffect(() => {
        setSyncedDirectory(directory);
    }, [directory]);

    useEffect(() => {
        setDashboardCurrentDirectory(syncedDirectory);
    }, [syncedDirectory]);

    useEffect(() => {
        return () => {
            clearDashboardCurrentDirectory(directory.id);
        };
    }, [directory.id]);

    // Sync generation state with the global sidebar indicator
    useEffect(() => {
        if (isGenerating) {
            markGenerating();
        } else {
            clearGenerating();
        }
    }, [isGenerating, markGenerating, clearGenerating]);

    useEffect(() => {
        const lastStatus = lastGenerateStatus.current;
        const currentStatus = syncedDirectory.generateStatus?.status;

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

        if (lastStatus === GenerateStatusType.GENERATING && currentStatus !== lastStatus) {
            if (currentStatus === GenerateStatusType.GENERATED) {
                syncDirectoryData(syncedDirectory.id).catch(() => {
                    // Silent fail; best effort
                });
            }

            router.refresh();
        }

        lastGenerateStatus.current = currentStatus;
    }, [router, syncedDirectory.generateStatus?.status, syncedDirectory.id, t]);

    useEffect(() => {
        if (!isGenerating) {
            return;
        }

        let isMounted = true;
        let isRefreshing = false;

        const refreshDirectoryStatus = async () => {
            if (isRefreshing) {
                return;
            }

            isRefreshing = true;
            try {
                const refreshedDirectory = await getDirectoryForStatusRefresh(syncedDirectory.id);
                if (isMounted && refreshedDirectory) {
                    setSyncedDirectory(refreshedDirectory);
                }
            } finally {
                isRefreshing = false;
            }
        };

        void refreshDirectoryStatus();
        const interval = window.setInterval(refreshDirectoryStatus, 5_000);

        return () => {
            isMounted = false;
            window.clearInterval(interval);
        };
    }, [isGenerating, syncedDirectory.id]);

    useEffect(() => {
        if (hasSyncedOnMount.current) {
            return;
        }

        hasSyncedOnMount.current = true;
        syncDirectoryData(syncedDirectory.id).catch(() => {
            // Silent fail; best effort
        });
    }, [syncedDirectory.id]);

    return (
        <DirectoryDetailProvider
            directory={syncedDirectory}
            oauthConnection={oauthConnection}
            config={config}
            onDirectoryChange={setSyncedDirectory}
        >
            <div className="w-full">
                <DirectoryHeader directory={syncedDirectory} />
                <DirectoryTabs directory={syncedDirectory} />

                <div className="mt-6">{children}</div>
            </div>
        </DirectoryDetailProvider>
    );
}
