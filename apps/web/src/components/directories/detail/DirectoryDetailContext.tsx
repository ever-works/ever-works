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

    // Prefer git provider username over platform owner
    const username = directory.owner || oauthConnection.username;
    if (!username) {
        return null;
    }

    // Strip trailing slash from homepage URL
    const baseUrl = providerUrl.replace(/\/$/, '');

    return {
        main: `${baseUrl}/${username}/${directory.slug}`,
        dataRepo: `${baseUrl}/${username}/${directory.slug}-data`,
        websiteRepo: `${baseUrl}/${username}/${directory.slug}-website`,
    };
}
