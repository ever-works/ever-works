'use client';

import { GitProviderConnectionInfo, Work, WorkConfig } from '@/lib/api/types-only';
import { WorkPermissions, getPermissions } from '@/lib/permissions';
import { createContext, PropsWithChildren, useContext, useMemo } from 'react';

type WorkDetailContextType = {
    work: Work;
    updateWork: (updates: Partial<Work>) => void;
    updateGenerateStatus: (generateStatus: Work['generateStatus']) => void;
    oauthConnection: GitProviderConnectionInfo | null;
    config: WorkConfig | null;
    repoLinks: {
        main: string | null;
        dataRepo: string | null;
        websiteRepo: string | null;
    } | null;
    permissions: WorkPermissions;
};

export const WorkDetailContext = createContext<WorkDetailContextType>({} as WorkDetailContextType);

export const WorkDetailProvider = ({
    work,
    oauthConnection,
    config,
    children,
    onWorkChange,
}: PropsWithChildren<{
    work: Work;
    oauthConnection: GitProviderConnectionInfo | null;
    config: WorkConfig | null;
    onWorkChange?: (work: Work) => void;
}>) => {
    const value = useMemo(() => {
        const updateWork = (updates: Partial<Work>) => {
            onWorkChange?.({
                ...work,
                ...updates,
            });
        };

        return {
            work,
            updateWork,
            updateGenerateStatus: (generateStatus: Work['generateStatus']) => {
                updateWork({ generateStatus });
            },
            oauthConnection,
            config,
            repoLinks: repoLink(work, oauthConnection),
            permissions: getPermissions(work.userRole),
        };
    }, [work, oauthConnection, config, onWorkChange]);

    return <WorkDetailContext.Provider value={value}>{children}</WorkDetailContext.Provider>;
};

export const useWorkDetail = () => {
    const context = useContext(WorkDetailContext);
    if (!context) {
        throw new Error('useWorkDetail must be used within a WorkDetailProvider');
    }

    return context;
};

export const useWorkPermissions = () => {
    const { permissions } = useWorkDetail();
    return permissions;
};

function repoLink(work: Work, oauthConnection: GitProviderConnectionInfo | null) {
    if (!oauthConnection) {
        return null;
    }

    // Use homepage from the provider info (populated from plugin manifest)
    const providerUrl = oauthConnection.homepage;
    if (!providerUrl) {
        return null;
    }

    // Never fall back to the connected personal username for organization-owned works.
    // That produces incorrect repo links like user/repo when the work actually belongs to an org.
    const owner = work.owner || (!work.organization ? oauthConnection.username : undefined);
    if (!owner) {
        return null;
    }

    // Strip trailing slash from homepage URL
    const baseUrl = providerUrl.replace(/\/$/, '');
    const relatedRepositories = work.sourceRepository?.relatedRepositories;
    const mainRepository = relatedRepositories?.work;
    const dataRepository = relatedRepositories?.data;
    const websiteRepository = relatedRepositories?.website;

    return {
        main: `${baseUrl}/${mainRepository?.owner || owner}/${mainRepository?.repo || work.slug}`,
        dataRepo: `${baseUrl}/${dataRepository?.owner || owner}/${dataRepository?.repo || `${work.slug}-data`}`,
        websiteRepo: `${baseUrl}/${websiteRepository?.owner || owner}/${websiteRepository?.repo || `${work.slug}-website`}`,
    };
}
