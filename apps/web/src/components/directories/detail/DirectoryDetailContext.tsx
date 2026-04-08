'use client';

import { GitProviderConnectionInfo, Directory, DirectoryConfig } from '@/lib/api/types-only';
import { DirectoryPermissions, getPermissions } from '@/lib/permissions';
import { createContext, PropsWithChildren, useContext, useMemo } from 'react';

type DirectoryDetailContextType = {
    directory: Directory;
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
}: PropsWithChildren<{
    directory: Directory;
    oauthConnection: GitProviderConnectionInfo | null;
    config: DirectoryConfig | null;
}>) => {
    const value = useMemo(() => {
        return {
            directory,
            oauthConnection,
            config,
            repoLinks: repoLink(directory, oauthConnection),
            permissions: getPermissions(directory.userRole),
        };
    }, [directory, oauthConnection, config]);

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

    return {
        main: `${baseUrl}/${owner}/${directory.slug}`,
        dataRepo: `${baseUrl}/${owner}/${directory.slug}-data`,
        websiteRepo: `${baseUrl}/${owner}/${directory.slug}-website`,
    };
}
