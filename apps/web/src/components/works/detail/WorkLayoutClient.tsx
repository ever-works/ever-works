'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { GitProviderConnectionInfo, Work, WorkConfig } from '@/lib/api/types-only';
import type { Agent } from '@/lib/api/agents';
import { getWorkCapabilities, type AppRepositoryMode } from '@ever-works/contracts';
import { WorkHeader } from './WorkHeader';
import { WorkTabs } from './WorkTabs';
import { GenerateStatusType } from '@/lib/api/enums';
import { WorkDetailProvider } from './WorkDetailContext';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { getWorkForStatusRefresh, syncWorkData } from '@/app/actions/dashboard/works';
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
    /** Agents on this Work (pinned by scope + assigned via targets). */
    agents?: Agent[];
    /** Total Agents on this Work upstream — may exceed agents.length. */
    agentsTotal?: number;
    /** Which of `agents` are ASSIGNED (detachable) rather than pinned. */
    assignedAgentIds?: string[];
    /**
     * APW-02 T30 (Resolution R-8) — `fork`, `private-copy` or `link` for an App
     * Work, `null` when the relation was not read (every other kind). Read once
     * by the layout from `GET /api/works/:id/upstream` and passed straight to
     * `WorkTabs`, which offers the Upstream tab only for a repository that has
     * an upstream at all.
     */
    appRelation?: AppRepositoryMode | null;
}

export function WorkLayoutClient({
    work,
    oauthConnection,
    config,
    agents = [],
    agentsTotal,
    assignedAgentIds = [],
    appRelation = null,
    children,
}: WorkLayoutClientProps) {
    const router = useRouter();
    const t = useTranslations('dashboard.workDetail');
    const [syncedWork, setSyncedWork] = useState(work);
    const isGenerating = syncedWork.generateStatus?.status === GenerateStatusType.GENERATING;
    const lastGenerateStatus = useRef(work.generateStatus?.status);
    const hasSyncedOnMount = useRef(false);
    const { markGenerating, clearGenerating } = useBackgroundActivity();
    // `POST /api/works/:id/sync-data` clones the Work's data repository. A kind
    // that provisions none (`repos.data: false` — today the App Work) has
    // nothing to sync, and calling anyway cost a failed clone and an API error
    // log on every page mount. The API answers a no-op for such a kind too;
    // this keeps the request from being made at all.
    const syncsFromDataRepository = getWorkCapabilities(syncedWork.kind).repos.data;

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
        const errorMessage = syncedWork.generateStatus?.error?.toLowerCase();
        const looksLikeCancellationError = Boolean(
            currentStatus === GenerateStatusType.ERROR && errorMessage?.includes('cancel'),
        );

        if (lastStatus !== currentStatus && currentStatus === GenerateStatusType.ERROR) {
            if (looksLikeCancellationError) {
                toast.info(t('generationCancelled'), {
                    id: 'generation-cancelled',
                });
                lastGenerateStatus.current = GenerateStatusType.CANCELLED;
                router.refresh();
                return;
            }

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
            if (currentStatus === GenerateStatusType.GENERATED && syncsFromDataRepository) {
                syncWorkData(syncedWork.id).catch(() => {
                    // Silent fail; best effort
                });
            }

            router.refresh();
        }

        lastGenerateStatus.current = currentStatus;
    }, [router, syncedWork.generateStatus?.status, syncedWork.id, syncsFromDataRepository, t]);

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
        if (!syncsFromDataRepository) {
            return;
        }
        syncWorkData(syncedWork.id).catch(() => {
            // Silent fail; best effort
        });
    }, [syncedWork.id, syncsFromDataRepository]);

    return (
        <WorkDetailProvider
            work={syncedWork}
            oauthConnection={oauthConnection}
            config={config}
            onWorkChange={setSyncedWork}
        >
            <div className="w-full">
                <WorkHeader
                    work={syncedWork}
                    agents={agents}
                    agentsTotal={agentsTotal}
                    assignedAgentIds={assignedAgentIds}
                />
                <WorkTabs work={syncedWork} appRelation={appRelation} />

                <div className="mt-6">{children}</div>
            </div>
        </WorkDetailProvider>
    );
}
