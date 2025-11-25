'use client';

import { RepoProvider } from '@/lib/api/enums';
import { ConnectionInfo, Directory, DirectoryConfig } from '@/lib/api/types-only';
import { createContext, PropsWithChildren, useContext, useMemo } from 'react';

type DirectoryDetailContextType = {
    directory: Directory;
    oauthConnection: ConnectionInfo | null;
    config: DirectoryConfig | null;
    repoLinks: {
        main: string | null;
        dataRepo: string | null;
        websiteRepo: string | null;
    } | null;
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
    oauthConnection: ConnectionInfo | null;
    config: DirectoryConfig | null;
}>) => {
    const value = useMemo(() => {
        return {
            directory,
            oauthConnection,
            config,
            repoLinks: repoLink(directory, oauthConnection),
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

function repoLink(directory: Directory, oauthConnection: ConnectionInfo | null) {
    if (!oauthConnection?.connected) {
        return null;
    }

    let providerUrl: string | null = null;

    switch (directory.repoProvider) {
        case RepoProvider.GITHUB:
            providerUrl = 'https://github.com';
            break;

        default:
            return null;
    }

    const username = directory.owner || oauthConnection.username || oauthConnection.metadata?.login;
    if (!username) {
        return null;
    }

    return {
        main: `${providerUrl}/${username}/${directory.slug}`,
        dataRepo: `${providerUrl}/${username}/${directory.slug}-data`,
        websiteRepo: `${providerUrl}/${username}/${directory.slug}-website`,
    };
}
