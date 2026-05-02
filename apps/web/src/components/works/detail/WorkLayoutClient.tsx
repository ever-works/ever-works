'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { GitProviderConnectionInfo, Work, WorkConfig } from '@/lib/api/types-only';
import { WorkHeader } from './WorkHeader';
import { WorkTabs } from './WorkTabs';
import { GenerateStatusType } from '@/lib/api/enums';
import { WorkDetailProvider } from './WorkDetailContext';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    getWorkForStatusRefresh,
    syncWorkData,
} from '@/app/actions/dashboard/works';
import { useBackgroundActivity } from '@/lib/hooks/use-background-activity';
import {
    clearDashboardCurrentWork,
    setDashboardCurrentWork,
} from '@/lib/hooks/use-dashboard-current-work';

interface WorkLayoutClientProps {
    work: Work;
    children: React.ReactNode;
    oauthConnection: GitProviderConnectionInfo | null;
    config: WorkConfig | null;
}

export function WorkLayoutClient({
    work,
    oauthConnection,
    config,
    children,
}: WorkLayoutClientProps) {
    const router = useRouter();
    const t = useTranslations('dashboard.workDetail');
    const [syncedWork, setSyncedWork] = useState(work);
    const isGenerating = syncedWork.generateStatus?.status === GenerateStatusType.GENERATING;
    const lastGenerateStatus = useRef(work.generateStatus?.status);
    const hasSyncedOnMount = useRef(false);
    const { markGenerating, clearGenerating } = useBackgroundActivity();

    useEffect(() => {
        setSyncedWork(work);
    }, [work]);

    useEffect(() => {
        setDashboardCurrentWork(syncedWork);
    }, [syncedWork]);

    useEffect(() => {
        return () => {
            clearDashboardCurrentWork(work.id);
        };
    }, [work.id]);

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
        const currentStatus = syncedWork.generateStatus?.status;

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
                syncWorkData(syncedWork.id).catch(() => {
                    // Silent fail; best effort
                });
            }

            router.refresh();
        }

        lastGenerateStatus.current = currentStatus;
    }, [router, syncedWork.generateStatus?.status, syncedWork.id, t]);

    useEffect(() => {
        if (!isGenerating) {
            return;
        }

        let isMounted = true;
        let isRefreshing = false;

        const refreshWorkStatus = async () => {
            if (isRefreshing) {
                return;
            }

            isRefreshing = true;
            try {
                const refreshedWork = await getWorkForStatusRefresh(syncedWork.id);
                if (isMounted && refreshedWork) {
                    setSyncedWork(refreshedWork);
                }
            } finally {
                isRefreshing = false;
            }
        };

        void refreshWorkStatus();
        const interval = window.setInterval(refreshWorkStatus, 5_000);

        return () => {
            isMounted = false;
            window.clearInterval(interval);
        };
    }, [isGenerating, syncedWork.id]);

    useEffect(() => {
        if (hasSyncedOnMount.current) {
            return;
        }

        hasSyncedOnMount.current = true;
        syncWorkData(syncedWork.id).catch(() => {
            // Silent fail; best effort
        });
    }, [syncedWork.id]);

    return (
        <WorkDetailProvider
            work={syncedWork}
            oauthConnection={oauthConnection}
            config={config}
            onWorkChange={setSyncedWork}
        >
            <div className="w-full">
                <WorkHeader work={syncedWork} />
                <WorkTabs work={syncedWork} />

                <div className="mt-6">{children}</div>
            </div>
        </WorkDetailProvider>
    );
}
