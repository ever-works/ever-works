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

function getProviderBaseUrl(providerId: string): string | null {
    switch (providerId.toLowerCase()) {
        case 'github':
            return 'https://github.com';
        case 'gitlab':
            return 'https://gitlab.com';
        case 'bitbucket':
            return 'https://bitbucket.org';
        default:
            return null;
    }
}

function repoLink(directory: Directory, oauthConnection: GitProviderConnectionInfo | null) {
    if (!oauthConnection?.connected) {
        return null;
    }

    const providerUrl = getProviderBaseUrl(directory.repoProvider);
    if (!providerUrl) {
        return null;
    }

    const username = directory.owner || oauthConnection.username;
    if (!username) {
        return null;
    }

    return {
        main: `${providerUrl}/${username}/${directory.slug}`,
        dataRepo: `${providerUrl}/${username}/${directory.slug}-data`,
        websiteRepo: `${providerUrl}/${username}/${directory.slug}-website`,
    };
}
