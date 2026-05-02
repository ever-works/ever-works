'use client';

import { GitProviderConnectionInfo, Directory, DirectoryConfig } from '@/lib/api/types-only';
import { DirectoryPermissions, getPermissions } from '@/lib/permissions';
import { createContext, PropsWithChildren, useContext, useMemo } from 'react';

type DirectoryDetailContextType = {
    directory: Directory;
    updateDirectory: (updates: Partial<Directory>) => void;
    updateGenerateStatus: (generateStatus: Directory['generateStatus']) => void;
    oauthConnection: GitProviderConnectionInfo | null;
    config: DirectoryConfig | null;
    repoLinks: {
        main: string | null;
        dataRepo: string | null;
        websiteRepo: string | null;
    } | null;
    permissions: DirectoryPermissions;
};

export const DirectoryDetailContext = createContext<DirectoryDetailContextType>(
    {} as DirectoryDetailContextType,
);

export const DirectoryDetailProvider = ({
    directory,
    oauthConnection,
    config,
    children,
    onDirectoryChange,
}: PropsWithChildren<{
    directory: Directory;
    oauthConnection: GitProviderConnectionInfo | null;
    config: DirectoryConfig | null;
    onDirectoryChange?: (directory: Directory) => void;
}>) => {
    const value = useMemo(() => {
        const updateDirectory = (updates: Partial<Directory>) => {
            onDirectoryChange?.({
                ...directory,
                ...updates,
            });
        };

        return {
            directory,
            updateDirectory,
            updateGenerateStatus: (generateStatus: Directory['generateStatus']) => {
                updateDirectory({ generateStatus });
            },
            oauthConnection,
            config,
            repoLinks: repoLink(directory, oauthConnection),
            permissions: getPermissions(directory.userRole),
        };
    }, [directory, oauthConnection, config, onDirectoryChange]);

    return (
        <DirectoryDetailContext.Provider value={value}>{children}</DirectoryDetailContext.Provider>
    );
};

export const useDirectoryDetail = () => {
    const context = useContext(DirectoryDetailContext);
    if (!context) {
        throw new Error('useDirectoryDetail must be used within a DirectoryDetailProvider');
    }

    return context;
};

export const useDirectoryPermissions = () => {
    const { permissions } = useDirectoryDetail();
    return permissions;
};

function repoLink(directory: Directory, oauthConnection: GitProviderConnectionInfo | null) {
    if (!oauthConnection) {
        return null;
    }

    // Use homepage from the provider info (populated from plugin manifest)
    const providerUrl = oauthConnection.homepage;
    if (!providerUrl) {
        return null;
    }

    // Never fall back to the connected personal username for organization-owned directories.
    // That produces incorrect repo links like user/repo when the directory actually belongs to an org.
    const owner =
        directory.owner || (!directory.organization ? oauthConnection.username : undefined);
    if (!owner) {
        return null;
    }

    // Strip trailing slash from homepage URL
    const baseUrl = providerUrl.replace(/\/$/, '');
    const relatedRepositories = directory.sourceRepository?.relatedRepositories;
    const mainRepository = relatedRepositories?.directory;
    const dataRepository = relatedRepositories?.data;
    const websiteRepository = relatedRepositories?.website;

    return {
        main: `${baseUrl}/${mainRepository?.owner || owner}/${mainRepository?.repo || directory.slug}`,
        dataRepo: `${baseUrl}/${dataRepository?.owner || owner}/${dataRepository?.repo || `${directory.slug}-data`}`,
        websiteRepo: `${baseUrl}/${websiteRepository?.owner || owner}/${websiteRepository?.repo || `${directory.slug}-website`}`,
    };
}
