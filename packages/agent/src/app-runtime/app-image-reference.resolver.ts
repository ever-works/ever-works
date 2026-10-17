/**
 * APW-06 T72 / T35 (APW06-G04, plan §5.8:874-885) — **the published-image identity resolver**.
 *
 * A `build.strategy: image` Deployment runs an image the App spec names (`build.image`). §5.8 makes
 * the identity resolution mandatory before `prepare`: a tag is resolved to a digest **once**, the
 * Deployment runs that digest (and records `image_not_pinned`), and a reference that is already a
 * digest is checked to exist. Bound in the isolated App runtime worker to
 * `APP_IMAGE_REFERENCE_RESOLVER`, so `AppDeployOrchestrator.resolveImage` stops answering
 * `image_unresolvable` for every published image.
 *
 * ## The registry dialogue (OCI distribution spec)
 *
 * `HEAD /v2/<repository>/manifests/<tag|digest>` with the manifest media types a runtime accepts.
 * A `401` carrying `WWW-Authenticate: Bearer realm=…,service=…,scope=…` is answered with ONE
 * **anonymous** token request — never a credential: a published-image Deployment runs a public
 * image only (§5.8:883-885, the pull-credential port is never called on this path) — and the
 * `HEAD` is repeated with that token. The digest is the `Docker-Content-Digest` header.
 *
 * ## The three refusals (§5.8, the codes `APP_PRECONDITION_CODES` already carries)
 *
 * - `image_not_found` — the registry answered `404` for the manifest.
 * - `image_private_unsupported` — the registry refused the anonymous pull (`401`/`403` after the
 *   anonymous token, or no anonymous token at all).
 * - `image_unresolvable` — anything else: an unparseable reference, a network failure, a timeout,
 *   or an answer with no digest.
 *
 * Never throws: every failure is a named refusal, which is the orchestrator's contract.
 */

import { Injectable, Logger } from '@nestjs/common';

import type {
    AppImageReferenceResolver,
    AppImageResolutionResult,
} from './app-deploy.orchestrator';

/** How long one registry request may take before the answer is `image_unresolvable`. */
export const APP_IMAGE_RESOLVE_TIMEOUT_MS = 15_000;

/** The manifest media types a container runtime accepts, newest first (OCI, then Docker v2). */
export const APP_IMAGE_MANIFEST_ACCEPT = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** Docker Hub's API host — `docker.io` itself serves no `/v2/` endpoint. */
const DOCKER_HUB_REGISTRY = 'registry-1.docker.io';

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

/** One reference, split the way the distribution API needs it. */
export interface ParsedImageReference {
    /** The registry host the reference names (`docker.io` when it names none). */
    registry: string;
    /** The repository path (`library/nginx` for a bare Docker Hub name). */
    repository: string;
    tag: string | null;
    digest: string | null;
    /** The reference with its tag and digest removed — what a pinned reference is built from. */
    name: string;
}

/**
 * Parse `[registry[:port]/]path[:tag][@digest]`. `null` ⇔ not a reference this resolver can
 * dial. A first segment is a registry when it has a `.` or a `:` or is `localhost`, the rule the
 * Docker CLI applies.
 */
export function parseImageReference(reference: string): ParsedImageReference | null {
    const raw = typeof reference === 'string' ? reference.trim() : '';
    if (!raw || raw.length > 512 || /\s/.test(raw) || raw.includes('://')) return null;

    let rest = raw;
    let digest: string | null = null;
    const at = rest.indexOf('@');
    if (at >= 0) {
        digest = rest.slice(at + 1);
        rest = rest.slice(0, at);
        if (!DIGEST_RE.test(digest)) return null;
    }

    let tag: string | null = null;
    const lastSlash = rest.lastIndexOf('/');
    const lastColon = rest.lastIndexOf(':');
    if (lastColon > lastSlash) {
        tag = rest.slice(lastColon + 1);
        rest = rest.slice(0, lastColon);
        if (!/^[\w][\w.-]{0,127}$/.test(tag)) return null;
    }

    const name = rest;
    const segments = rest.split('/');
    let registry = 'docker.io';
    if (
        segments.length > 1 &&
        (segments[0].includes('.') || segments[0].includes(':') || segments[0] === 'localhost')
    ) {
        registry = segments.shift() as string;
    }

    let repository = segments.join('/');
    if (!repository || repository.length > 255 || !segments.every(isRepositoryComponent))
        return null;
    if (registry === 'docker.io' && !repository.includes('/')) {
        repository = `library/${repository}`;
    }

    return { registry, repository, tag, digest, name };
}

/** One path component of a repository: lowercase alphanumerics, separators only inside. */
function isRepositoryComponent(component: string): boolean {
    return (
        /^[a-z0-9][a-z0-9._-]*$/.test(component) &&
        /[a-z0-9]$/.test(component) &&
        !/[._-]{3}/.test(component)
    );
}

/** Longest `WWW-Authenticate` value the anonymous-token dance reads. */
const APP_IMAGE_CHALLENGE_MAX_LENGTH = 2048;

/** `Bearer realm="…",service="…",scope="…"` → its three parameters. */
export function parseBearerChallenge(
    header: string | null | undefined,
): { realm: string; service?: string; scope?: string } | null {
    const value = typeof header === 'string' ? header.trim() : '';
    if (!/^bearer\s/i.test(value)) return null;

    // String operations, not a global regex: the header is registry-controlled input, and a
    // `(\w+)="…"` scan over it backtracks polynomially on long word runs (CodeQL js/polynomial-redos).
    if (value.length > APP_IMAGE_CHALLENGE_MAX_LENGTH) return null;
    const params: Record<string, string> = {};
    for (const part of value.slice(value.indexOf(' ') + 1).split(',')) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const key = part.slice(0, eq).trim().toLowerCase();
        let raw = part.slice(eq + 1).trim();
        if (raw.startsWith('"')) raw = raw.slice(1);
        if (raw.endsWith('"')) raw = raw.slice(0, -1);
        if (key && !(key in params)) params[key] = raw;
    }
    if (!params.realm || !params.realm.toLowerCase().startsWith('https://')) return null;

    return { realm: params.realm, service: params.service, scope: params.scope };
}

type FetchLike = (
    input: string,
    init?: Record<string, unknown>,
) => Promise<{
    status: number;
    ok: boolean;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
}>;

@Injectable()
export class RegistryAppImageReferenceResolver implements AppImageReferenceResolver {
    private readonly logger = new Logger(RegistryAppImageReferenceResolver.name);

    constructor(private readonly fetchImpl?: FetchLike) {}

    async resolve(input: {
        workId: string;
        reference: string;
        specCommitSha: string;
    }): Promise<AppImageResolutionResult> {
        const parsed = parseImageReference(input?.reference ?? '');
        if (!parsed) {
            return refused(
                'image_unresolvable',
                `The App spec's build.image "${String(input?.reference ?? '')}" is not an image reference.`,
            );
        }

        const host = parsed.registry === 'docker.io' ? DOCKER_HUB_REGISTRY : parsed.registry;
        const target = parsed.digest ?? parsed.tag ?? 'latest';
        const url = `https://${host}/v2/${parsed.repository}/manifests/${target}`;

        try {
            let answer = await this.head(url, null);

            if (answer.status === 401) {
                const challenge = parseBearerChallenge(answer.headers.get('www-authenticate'));
                const token = challenge ? await this.anonymousToken(challenge, parsed) : null;
                if (!token) {
                    return refused(
                        'image_private_unsupported',
                        `${parsed.name} needs registry credentials; a published-image App runs public images only.`,
                    );
                }
                answer = await this.head(url, token);
            }

            if (answer.status === 404) {
                return refused(
                    'image_not_found',
                    `${parsed.name}:${target} does not exist in ${parsed.registry}.`,
                );
            }
            if (answer.status === 401 || answer.status === 403) {
                return refused(
                    'image_private_unsupported',
                    `${parsed.name} is not publicly pullable; a published-image App runs public images only.`,
                );
            }
            if (!answer.ok) {
                return refused(
                    'image_unresolvable',
                    `${parsed.registry} answered ${answer.status} for ${parsed.name}:${target}.`,
                );
            }

            const digest = (answer.headers.get('docker-content-digest') ?? '').trim();
            const resolvedDigest = DIGEST_RE.test(digest) ? digest : parsed.digest;
            if (!resolvedDigest) {
                return refused(
                    'image_unresolvable',
                    `${parsed.registry} returned no content digest for ${parsed.name}:${target}.`,
                );
            }

            return {
                status: 'resolved',
                reference: `${parsed.name}@${resolvedDigest}`,
                digest: resolvedDigest,
                resolvedFromTag: !parsed.digest,
            };
        } catch (error) {
            this.logger.warn(
                `Resolving ${parsed.name}:${target} for work ${input?.workId} failed: ${messageOf(error)}`,
            );
            return refused(
                'image_unresolvable',
                `The registry could not be reached: ${messageOf(error)}`,
            );
        }
    }

    private async head(url: string, token: string | null): Promise<Awaited<ReturnType<FetchLike>>> {
        return this.call(url, {
            method: 'HEAD',
            headers: {
                Accept: APP_IMAGE_MANIFEST_ACCEPT,
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
        });
    }

    private async anonymousToken(
        challenge: { realm: string; service?: string; scope?: string },
        parsed: ParsedImageReference,
    ): Promise<string | null> {
        const query = new URLSearchParams();
        if (challenge.service) query.set('service', challenge.service);
        query.set('scope', challenge.scope || `repository:${parsed.repository}:pull`);

        const answer = await this.call(`${challenge.realm}?${query.toString()}`, { method: 'GET' });
        if (!answer.ok) return null;

        const body = (await answer.json().catch(() => null)) as {
            token?: unknown;
            access_token?: unknown;
        } | null;
        const token = typeof body?.token === 'string' ? body.token : body?.access_token;
        return typeof token === 'string' && token ? token : null;
    }

    private async call(
        url: string,
        init: Record<string, unknown>,
    ): Promise<Awaited<ReturnType<FetchLike>>> {
        const fetchImpl: FetchLike =
            this.fetchImpl ?? ((globalThis as unknown as { fetch: FetchLike }).fetch as FetchLike);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), APP_IMAGE_RESOLVE_TIMEOUT_MS);
        timer.unref?.();
        try {
            return await fetchImpl(url, { ...init, redirect: 'follow', signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }
}

function refused(code: string, message: string): AppImageResolutionResult {
    return { status: 'refused', code, message };
}

function messageOf(error: unknown): string {
    if (error instanceof Error) return error.message.slice(0, 300);
    return typeof error === 'string' ? error.slice(0, 300) : 'unknown error';
}
