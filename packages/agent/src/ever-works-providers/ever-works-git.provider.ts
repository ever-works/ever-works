import { Injectable } from '@nestjs/common';
import { config } from '../config';
import {
    EverWorksGitDisabledError,
    EverWorksGitMisconfiguredError,
    EverWorksGitRequestError,
    type EverWorksGitRepoRef,
    type EverWorksProviderWorkRef,
} from './types';

const GITHUB_API_BASE = 'https://api.github.com';
const REPO_NAME_MAX_LENGTH = 100;

/** Function shape used to call GitHub. Overridable in tests. */
export type EverWorksGitHttpFetch = typeof fetch;

interface CreateRepositoryOptions {
    readonly work: EverWorksProviderWorkRef;
    /** Override the org from env (for tests). */
    readonly orgOverride?: string;
    /** Inject a fetch implementation (for tests). */
    readonly fetchImpl?: EverWorksGitHttpFetch;
    /** Override visibility from env (for tests). */
    readonly visibilityOverride?: 'private' | 'public';
}

interface GitHubRepoApiResponse {
    readonly id: number;
    readonly name: string;
    readonly full_name: string;
    readonly html_url: string;
    readonly clone_url: string;
    readonly private: boolean;
    readonly owner: { readonly login: string };
}

interface GitHubErrorApiResponse {
    readonly message?: string;
    readonly errors?: ReadonlyArray<{ readonly code?: string; readonly message?: string }>;
}

/**
 * Creates repositories under the Ever Works customers GitHub org using a
 * server-held PAT. Backs the "Ever Works Git" storage choice from the
 * onboarding wizard.
 *
 * This provider is intentionally narrow — it only handles repository
 * provisioning. The downstream push / commit flow keeps using the existing
 * git facade once the repo exists; the platform PAT is exposed to that flow
 * via a separate accessor so we keep one PAT surface.
 */
@Injectable()
export class EverWorksGitProvider {
    /** True when both the feature flag and the required PAT/org are present. */
    isEnabled(): boolean {
        return (
            config.everWorks.git.isEnabled() &&
            config.everWorks.git.getPat().length > 0 &&
            config.everWorks.git.getOrg().length > 0
        );
    }

    /** Return the configured customer org (e.g. `'ever-works-cloud'`). */
    getOrg(): string {
        return config.everWorks.git.getOrg();
    }

    /**
     * Compute the target repo name for a Work. Pattern: `{user-slug}-{work-slug}`.
     * A 7-char suffix derived from the Work UUID is appended when the caller
     * indicates a collision so retries are deterministic.
     */
    buildRepoName(work: EverWorksProviderWorkRef, withCollisionSuffix = false): string {
        const userPart = (work.userSlug ?? '').trim() || work.userId.slice(0, 8);
        const base = `${slugify(userPart)}-${slugify(work.slug)}`.replace(/-{2,}/g, '-');
        const trimmed = trimRepoName(base);

        if (!withCollisionSuffix) {
            return trimmed;
        }

        const suffix = `-${work.id.replace(/-/g, '').slice(0, 7)}`;
        return trimRepoName(trimmed, suffix.length) + suffix;
    }

    /**
     * Create a new repository in the customers org for the given Work.
     *
     * Behaviour:
     *  - Rejects with `EverWorksGitDisabledError` when the env flag is off
     *    or the PAT is missing.
     *  - First try: `{user-slug}-{work-slug}`.
     *  - On `422 name already exists`, retries once with a `-{shortId}` suffix.
     *  - Any other non-2xx response throws `EverWorksGitRequestError` so the
     *    caller can map it to a typed API error.
     */
    async createRepository(options: CreateRepositoryOptions): Promise<EverWorksGitRepoRef> {
        if (!this.isEnabled() && !options.orgOverride) {
            throw new EverWorksGitDisabledError();
        }

        const org = options.orgOverride ?? this.getOrg();
        if (!org) {
            throw new EverWorksGitMisconfiguredError('customer GitHub org is empty');
        }

        const pat = config.everWorks.git.getPat();
        if (!pat && !options.fetchImpl) {
            // fetchImpl can be a fully-mocked transport in tests; otherwise we
            // need a real PAT to talk to GitHub.
            throw new EverWorksGitMisconfiguredError('customer GitHub PAT is empty');
        }

        const visibility =
            options.visibilityOverride ?? config.everWorks.git.getVisibility();
        const fetchImpl = options.fetchImpl ?? fetch;

        const firstName = this.buildRepoName(options.work);
        const first = await this.tryCreate({
            org,
            pat,
            visibility,
            fetchImpl,
            name: firstName,
            description: options.work.description,
        });
        if (first.kind === 'ok') return first.repo;
        if (first.kind !== 'name_taken') throw first.error;

        const fallbackName = this.buildRepoName(options.work, true);
        const second = await this.tryCreate({
            org,
            pat,
            visibility,
            fetchImpl,
            name: fallbackName,
            description: options.work.description,
        });
        if (second.kind === 'ok') return second.repo;
        if (second.kind === 'name_taken') {
            throw new EverWorksGitRequestError(
                422,
                `Both ${firstName} and ${fallbackName} are taken in org ${org}.`,
            );
        }
        throw second.error;
    }

    private async tryCreate(args: {
        org: string;
        pat: string;
        visibility: 'private' | 'public';
        fetchImpl: EverWorksGitHttpFetch;
        name: string;
        description?: string;
    }): Promise<
        | { kind: 'ok'; repo: EverWorksGitRepoRef }
        | { kind: 'name_taken' }
        | { kind: 'error'; error: EverWorksGitRequestError }
    > {
        const url = `${GITHUB_API_BASE}/orgs/${encodeURIComponent(args.org)}/repos`;
        const response = await args.fetchImpl(url, {
            method: 'POST',
            headers: {
                accept: 'application/vnd.github+json',
                authorization: `Bearer ${args.pat}`,
                'content-type': 'application/json',
                'x-github-api-version': '2022-11-28',
            },
            body: JSON.stringify({
                name: args.name,
                description: args.description ?? '',
                private: args.visibility === 'private',
                auto_init: true,
                has_issues: true,
                has_projects: false,
                has_wiki: false,
            }),
        });

        if (response.status === 201) {
            const body = (await response.json()) as GitHubRepoApiResponse;
            return {
                kind: 'ok',
                repo: {
                    owner: body.owner.login,
                    repo: body.name,
                    fullName: body.full_name,
                    htmlUrl: body.html_url,
                    cloneUrl: body.clone_url,
                    privateRepo: body.private,
                },
            };
        }

        const rawText = await safeReadText(response);
        if (response.status === 422 && rawText.includes('name already exists')) {
            return { kind: 'name_taken' };
        }

        let parsedMessage = `GitHub responded ${response.status}`;
        try {
            const parsed = JSON.parse(rawText) as GitHubErrorApiResponse;
            if (parsed?.message) parsedMessage = `${parsedMessage}: ${parsed.message}`;
        } catch {
            // body wasn't JSON — fall through with the raw status message.
        }

        return {
            kind: 'error',
            error: new EverWorksGitRequestError(response.status, parsedMessage, rawText),
        };
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function slugify(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function trimRepoName(name: string, reservedSuffixLength = 0): string {
    const limit = REPO_NAME_MAX_LENGTH - reservedSuffixLength;
    if (name.length <= limit) return name;
    return name.slice(0, limit).replace(/-+$/, '');
}

async function safeReadText(response: Response): Promise<string> {
    try {
        return await response.text();
    } catch {
        return '';
    }
}
