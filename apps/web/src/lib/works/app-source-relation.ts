/**
 * APW-01 T24 — the App Work's relation to its repository, reduced to what the
 * header line needs (spec §6.4: `Fork: {fullName}` · `Upstream: {fullName}` ·
 * `Private copy: {fullName}` · `Linked: {fullName}`).
 *
 * A plain module (no `'use client'`, no `server-only`): the Work detail layout
 * — a server component — CALLS {@link summarizeAppSourceRelation}, and a server
 * component that imports a function through a client module receives a client
 * reference instead of the function.
 */

import type { AppRepositoryMode, AppUpstreamStateResponse } from '@ever-works/contracts';

export interface AppSourceRelationSummary {
    relation: AppRepositoryMode;
    /** The Work Repository, `owner/repo`. */
    repository: string;
    repositoryUrl?: string;
    /** The upstream, `owner/repo` — absent for a linked App Work (FR-44). */
    upstream?: string;
    upstreamUrl?: string;
}

/** Reduce the Upstream answer to the header's relation line. */
export function summarizeAppSourceRelation(
    state: AppUpstreamStateResponse,
): AppSourceRelationSummary {
    const repository = `${state.dataRepository.owner}/${state.dataRepository.repo}`;
    return {
        relation: state.relation,
        repository,
        ...(state.dataRepository.url ? { repositoryUrl: state.dataRepository.url } : {}),
        ...(state.relation !== 'link' && state.upstream
            ? {
                  upstream: `${state.upstream.owner}/${state.upstream.repo}`,
                  ...(state.upstream.url ? { upstreamUrl: state.upstream.url } : {}),
              }
            : {}),
    };
}
