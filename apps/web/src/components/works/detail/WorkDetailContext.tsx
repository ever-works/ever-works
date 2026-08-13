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
        // EW-037: `undefined` where the repository's real name is unknowable —
        // managed storage provisions collision-suffixed names, so a derived
        // `${slug}-data` URL points at a repo that does not exist. Consumers
        // must render something other than a link in that case.
        dataRepo: string | null | undefined;
        websiteRepo: string | null | undefined;
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

/**
 * Exported for unit testing (EW-037). Building a repository URL is exactly the
 * kind of logic that looks obviously right and silently produces links to
 * repositories that do not exist.
 */
export function repoLink(work: Work, oauthConnection: GitProviderConnectionInfo | null) {
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

    // EW-037 — do not invent a URL for a repository that was never created.
    //
    // Managed "Ever Works Git" storage names repos with a collision-resistant
    // prefix (`anon-<hash>-<slug>`, see `EverWorksGitProvider.buildRepoName`),
    // so a derived `${slug}-data` name is NEVER right for such a Work. The
    // detail page linked all three of these for `EW027 Verify Directory`:
    //   ever-works-cloud/anon-1d565e12-ew027-verify-directory   (exists)
    //   ever-works-cloud/ew027-verify-directory-data            (404)
    //   ever-works-cloud/ew027-verify-directory-website         (404)
    //
    // The discriminator is STRUCTURAL rather than `storageProvider`, which the
    // API does not expose on the Work read model: when `relatedRepositories`
    // is present at all, the platform recorded exactly what it provisioned, so
    // a MISSING role means that repository does not exist — not that we forgot
    // to record it. When the whole object is absent (self-hosted / legacy
    // Works that predate it), the `${slug}-data` convention is how the user's
    // own repos really are named, so keep deriving and keep those links alive.
    //
    // Returning `undefined` lets the row render as plain text instead of a
    // link — see `RepositoryRow`.
    const rolesAreRecorded = Boolean(relatedRepositories);
    const derived = (recorded: string | undefined, fallback: string) => {
        if (recorded) return encodeURIComponent(recorded);
        return rolesAreRecorded ? undefined : encodeURIComponent(fallback);
    };

    // Security: encodeURIComponent applied to all user-controlled path segments to prevent
    // path-traversal via malicious slug or repository names (e.g. "../../evil").
    // NB the segments below are encoded exactly ONCE — `work.slug` is passed raw
    // into `derived()` rather than pre-encoded, because encoding it first and
    // then encoding `"${encSlug}-data"` again double-escapes any slug that
    // needed encoding at all (`a b` -> `a%2520b-data`).
    const link = (
        repository: { owner?: string; repo?: string } | undefined,
        fallbackRepo: string,
    ) => {
        const repoSegment = derived(repository?.repo, fallbackRepo);
        if (!repoSegment) return undefined;
        return `${baseUrl}/${encodeURIComponent(repository?.owner || owner)}/${repoSegment}`;
    };

    return {
        // The `work` role is always recorded for managed storage, and for
        // self-hosted storage the bare slug is the repo name, so this one
        // needs no suppression.
        main: `${baseUrl}/${encodeURIComponent(mainRepository?.owner || owner)}/${encodeURIComponent(mainRepository?.repo || work.slug)}`,
        dataRepo: link(dataRepository, `${work.slug}-data`),
        websiteRepo: link(websiteRepository, `${work.slug}-website`),
    };
}
