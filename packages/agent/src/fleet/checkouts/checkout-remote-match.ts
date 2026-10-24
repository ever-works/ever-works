import { parseFleetRemote, type FleetParsedRemote } from '@ever-works/contracts';

/**
 * Checkouts on computers (FL-14, R-16, spec FR-6) — which repository Work a
 * checkout belongs to, by its remote.
 *
 * Host-aware: `github.com/acme/api` never links to a Work whose repository is
 * `gitlab.example.com/acme/api`, however alike the names (the push-credential
 * lesson: a scope check that ignored the HOST was a real bug once). A remote
 * that still carries a credential never parses, so it never links.
 *
 * Pure, so the truth table is a spec rather than a database fixture.
 */

/** What matching reads off a Work — nothing else. */
export interface FleetCheckoutWorkCandidate {
    id: string;
    name: string;
    sourceRepository?: {
        url?: string | null;
        owner?: string | null;
        repo?: string | null;
        auth?: { mode?: string; repoFullName?: string | null } | null;
    } | null;
}

/** Every repository a Work names, as host + `owner/repo`. */
export function workRepositories(work: FleetCheckoutWorkCandidate): FleetParsedRemote[] {
    const source = work.sourceRepository;
    if (!source) return [];
    const out: FleetParsedRemote[] = [];
    const push = (parsed: FleetParsedRemote | null): void => {
        if (!parsed) return;
        if (!out.some((entry) => entry.host === parsed.host && entry.fullName === parsed.fullName))
            out.push(parsed);
    };
    const fromUrl = typeof source.url === 'string' ? parseFleetRemote(source.url) : null;
    push(fromUrl);
    // `owner` + `repo` without a parseable URL: the host is the URL's when it
    // has one, else GitHub — the only host a Work's repository fields name today.
    if (!fromUrl && typeof source.owner === 'string' && typeof source.repo === 'string') {
        push(parseFleetRemote(`https://github.com/${source.owner}/${source.repo}`));
    }
    // A GitHub App installation names its repository by full name, on github.com.
    const fullName = source.auth?.mode === 'github_app_installation' ? source.auth.repoFullName : null;
    if (typeof fullName === 'string' && fullName.includes('/')) {
        push(parseFleetRemote(`https://github.com/${fullName}`));
    }
    return out;
}

/**
 * The Work whose repository the remote names, or null. When two Works name the
 * same repository the first (the caller's order — oldest first) wins, so the
 * link is stable from one list to the next.
 */
export function matchCheckoutWork<T extends FleetCheckoutWorkCandidate>(
    remoteUrl: string | null | undefined,
    works: readonly T[],
): T | null {
    if (!remoteUrl) return null;
    const remote = parseFleetRemote(remoteUrl);
    if (!remote) return null;
    for (const work of works) {
        for (const repository of workRepositories(work)) {
            if (repository.host === remote.host && repository.fullName === remote.fullName) return work;
        }
    }
    return null;
}
