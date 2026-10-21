/**
 * App Works follow-up (d), 2026-10-21 — **the registry `USER` pre-check**.
 *
 * ## Why
 *
 * Every App pod runs with `runAsNonRoot: true` (always on the managed target, and on Your cluster
 * unless the target allows root). The kubelet then refuses two kinds of image, and until now the
 * platform learned that only from the kubelet, after `prepare` ran and a Job or a rollout waited:
 *
 * - an image that runs as **root** (no `USER`, or `USER 0`) → "container has runAsNonRoot and image
 *   will run as root" → `managed_root_forbidden`;
 * - an image whose `USER` is a **name** (`USER node`, Umami's `nextjs`) → "image has non-numeric
 *   user … cannot verify user is non-root" → `image_user_unverifiable`.
 *
 * Both were hit live on 2026-10-18 (the Cal fork and the fixture). #2789 made the kubelet's answer
 * arrive on the first poll; this check makes it arrive before the cluster is touched at all, with
 * the same two reason codes, by reading the image config's `User` from the registry.
 *
 * ## The registry dialogue (OCI distribution spec)
 *
 * `GET /v2/<repository>/manifests/<ref>` (an index is narrowed to `linux/amd64`, else its first
 * runnable entry) → the manifest's `config.digest` → `GET /v2/<repository>/blobs/<digest>` → the
 * config JSON's `config.User`. A `401` with a `Bearer` challenge is answered with one token request;
 * the App's **own** pull credential (the read-only one the render input carries) is sent with it
 * ONLY when its `server` is the registry being asked, so a credential never reaches another host.
 * Without a matching credential the token request is anonymous (a public image).
 *
 * ## What it never does
 *
 * It never refuses on a read it could not complete: an unreachable registry, an auth failure, a
 * manifest it cannot parse — each is `unavailable`, which the orchestrator records as the warning
 * `image_user_unchecked` and the kubelet stays the authority, exactly as before. It never logs or
 * returns the credential or the token.
 */

import { Injectable, Logger } from '@nestjs/common';

import {
    APP_IMAGE_MANIFEST_ACCEPT,
    parseBearerChallenge,
    parseImageReference,
    type ParsedImageReference,
} from './app-image-reference.resolver';

/** DI token for {@link AppImageUserInspector} — bound in the App runtime worker. */
export const APP_IMAGE_USER_INSPECTOR = Symbol('APP_IMAGE_USER_INSPECTOR');

/** The warning a Deployment carries when the image's `USER` could not be read. */
export const APP_DEPLOY_WARNING_IMAGE_USER_UNCHECKED = 'image_user_unchecked';

/** How long one registry request may take. */
export const APP_IMAGE_USER_TIMEOUT_MS = 15_000;

/** The largest manifest / config body this check parses (a config is a few KiB). */
const APP_IMAGE_USER_BODY_MAX_BYTES = 4 * 1024 * 1024;

/** The media types an image config blob is served as (OCI, then Docker). */
const APP_IMAGE_CONFIG_ACCEPT = [
    'application/vnd.oci.image.config.v1+json',
    'application/vnd.docker.container.image.v1+json',
    'application/json',
].join(', ');

/** Docker Hub's API host — `docker.io` itself serves no `/v2/` endpoint. */
const DOCKER_HUB_REGISTRY = 'registry-1.docker.io';

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

/** The App's read-only pull credential, exactly as the render input carries it. */
export interface AppImagePullAuth {
    server: string;
    username: string;
    password: string;
}

export type AppImageUserReadResult =
    | { status: 'read'; user: string }
    | { status: 'unavailable'; reason: string };

/** The one call the orchestrator makes. Never throws. */
export interface AppImageUserInspector {
    readUser(input: {
        reference: string;
        pull?: AppImagePullAuth | null;
    }): Promise<AppImageUserReadResult>;
}

/** A refusal with the rollout classifier's own codes, or `null` when the kubelet would accept it. */
export interface AppImageUserVerdict {
    code: 'managed_root_forbidden' | 'image_user_unverifiable';
    message: string;
}

/**
 * The kubelet's own rule, applied to an image config `User` (`<user>[:<group>]`).
 *
 * - Not `runAsNonRoot` → nothing to refuse.
 * - A declared numeric `runAsUser` wins over the image: non-zero passes, `0` is root.
 * - Otherwise the image's user: empty or `0` is root; a positive number passes; anything else is a
 *   name the kubelet cannot verify (including the name `root` — the kubelet only knows numbers).
 */
export function judgeImageUser(
    user: string,
    options: { runAsNonRoot: boolean; runAsUser?: number | null; component: string; image: string },
): AppImageUserVerdict | null {
    if (!options.runAsNonRoot) {
        return null;
    }
    const declared = options.runAsUser;
    if (typeof declared === 'number' && Number.isSafeInteger(declared) && declared >= 0) {
        return declared > 0 ? null : rootVerdict(options.component, options.image, 'runAsUser 0');
    }

    const raw = typeof user === 'string' ? user.trim() : '';
    const name = raw.split(':')[0].trim();
    if (!name || name === '0') {
        return rootVerdict(options.component, options.image, raw ? `USER ${raw}` : 'no USER');
    }
    if (/^\d{1,10}$/.test(name)) {
        return Number(name) > 0
            ? null
            : rootVerdict(options.component, options.image, `USER ${raw}`);
    }
    return {
        code: 'image_user_unverifiable',
        message:
            `Component '${options.component}' would run image ${options.image} as the user name ` +
            `'${name.slice(0, 64)}', which Kubernetes cannot verify as non-root (runAsNonRoot). Use a ` +
            `numeric USER in the Dockerfile (e.g. USER 1000:1000) or declare components[].runAsUser.`,
    };
}

function rootVerdict(component: string, image: string, why: string): AppImageUserVerdict {
    return {
        code: 'managed_root_forbidden',
        message:
            `Component '${component}' would run image ${image} as root (${why}), and this target ` +
            `requires a non-root user (runAsNonRoot). Set a numeric non-root USER in the Dockerfile ` +
            `(e.g. USER 1000:1000) or declare components[].runAsUser.`,
    };
}

type FetchAnswer = {
    status: number;
    ok: boolean;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
};
type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<FetchAnswer>;

@Injectable()
export class RegistryAppImageUserInspector implements AppImageUserInspector {
    private readonly logger = new Logger(RegistryAppImageUserInspector.name);

    constructor(private readonly fetchImpl?: FetchLike) {}

    async readUser(input: {
        reference: string;
        pull?: AppImagePullAuth | null;
    }): Promise<AppImageUserReadResult> {
        const parsed = parseImageReference(input?.reference ?? '');
        if (!parsed) {
            return unavailable('the image reference could not be parsed');
        }
        const host = parsed.registry === 'docker.io' ? DOCKER_HUB_REGISTRY : parsed.registry;
        const auth = matchingCredential(input?.pull ?? null, parsed.registry, host);
        const session: { token: string | null } = { token: null };

        try {
            const target = parsed.digest ?? parsed.tag ?? 'latest';
            let manifest = await this.getJson(
                `https://${host}/v2/${parsed.repository}/manifests/${target}`,
                APP_IMAGE_MANIFEST_ACCEPT,
                parsed,
                auth,
                session,
            );
            if (!manifest.ok) {
                return unavailable(`the manifest read answered ${manifest.status}`);
            }

            const child = platformManifestDigest(manifest.body);
            if (child) {
                manifest = await this.getJson(
                    `https://${host}/v2/${parsed.repository}/manifests/${child}`,
                    APP_IMAGE_MANIFEST_ACCEPT,
                    parsed,
                    auth,
                    session,
                );
                if (!manifest.ok) {
                    return unavailable(`the platform manifest read answered ${manifest.status}`);
                }
            }

            const configDigest = text(
                (manifest.body as { config?: { digest?: unknown } } | null)?.config?.digest,
            );
            if (!DIGEST_RE.test(configDigest)) {
                return unavailable('the manifest names no image config');
            }

            const config = await this.getJson(
                `https://${host}/v2/${parsed.repository}/blobs/${configDigest}`,
                APP_IMAGE_CONFIG_ACCEPT,
                parsed,
                auth,
                session,
            );
            if (!config.ok) {
                return unavailable(`the image config read answered ${config.status}`);
            }

            const user = (config.body as { config?: { User?: unknown } } | null)?.config?.User;
            return { status: 'read', user: typeof user === 'string' ? user : '' };
        } catch (error) {
            this.logger.warn(`Reading the USER of ${parsed.name} failed: ${messageOf(error)}`);
            return unavailable(`the registry could not be read: ${messageOf(error)}`);
        }
    }

    /** One authenticated GET, answering a `401` Bearer challenge once per session. */
    private async getJson(
        url: string,
        accept: string,
        parsed: ParsedImageReference,
        auth: string | null,
        session: { token: string | null },
    ): Promise<{ ok: boolean; status: number; body: unknown }> {
        const host = new URL(url).hostname;
        let answer = await this.call(url, accept, session.token ? `Bearer ${session.token}` : null);

        if (answer.status === 401 && !session.token) {
            const header = answer.headers.get('www-authenticate') ?? '';
            if (/^basic\s/i.test(header.trim()) && auth) {
                answer = await this.call(url, accept, `Basic ${auth}`);
            } else {
                const challenge = parseBearerChallenge(header);
                // The credential rides to the token endpoint only when that endpoint is the
                // registry's own (or Docker Hub's known auth host) — never to a host the registry
                // merely names.
                const realmAuth =
                    challenge && trustedRealm(challenge.realm, parsed.registry, host) ? auth : null;
                session.token = challenge ? await this.token(challenge, parsed, realmAuth) : null;
                if (session.token) {
                    answer = await this.call(url, accept, `Bearer ${session.token}`);
                }
            }
        }

        if (!answer.ok) {
            return { ok: false, status: answer.status, body: null };
        }
        const raw = await answer.text();
        if (raw.length > APP_IMAGE_USER_BODY_MAX_BYTES) {
            return { ok: false, status: 413, body: null };
        }
        try {
            return { ok: true, status: answer.status, body: JSON.parse(raw) };
        } catch {
            return { ok: false, status: 422, body: null };
        }
    }

    /** The token request; the matching pull credential rides as Basic, else it is anonymous. */
    private async token(
        challenge: { realm: string; service?: string; scope?: string },
        parsed: ParsedImageReference,
        auth: string | null,
    ): Promise<string | null> {
        const query = new URLSearchParams();
        if (challenge.service) query.set('service', challenge.service);
        query.set('scope', challenge.scope || `repository:${parsed.repository}:pull`);

        const answer = await this.call(
            `${challenge.realm}?${query.toString()}`,
            'application/json',
            auth ? `Basic ${auth}` : null,
        );
        if (!answer.ok) return null;

        let body: { token?: unknown; access_token?: unknown } | null = null;
        try {
            body = JSON.parse(await answer.text()) as typeof body;
        } catch {
            return null;
        }
        const token = typeof body?.token === 'string' ? body.token : body?.access_token;
        return typeof token === 'string' && token ? token : null;
    }

    private async call(
        url: string,
        accept: string,
        authorizationHeader: string | null,
    ): Promise<FetchAnswer> {
        const fetchImpl: FetchLike =
            this.fetchImpl ?? ((globalThis as unknown as { fetch: FetchLike }).fetch as FetchLike);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), APP_IMAGE_USER_TIMEOUT_MS);
        timer.unref?.();
        try {
            return await fetchImpl(url, {
                method: 'GET',
                headers: {
                    Accept: accept,
                    ...(authorizationHeader ? { Authorization: authorizationHeader } : {}),
                },
                // A blob is usually served by a redirect to storage; `fetch` drops the
                // Authorization header on a cross-origin redirect, so the credential stays put.
                redirect: 'follow',
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }
    }
}

/**
 * The `base64(user:password)` of the pull credential, ONLY when it was issued for the registry being
 * asked (`ghcr.io` ⇔ `ghcr.io`; `docker.io`, `index.docker.io` and `registry-1.docker.io` are one).
 */
export function matchingCredential(
    pull: AppImagePullAuth | null,
    registry: string,
    host: string,
): string | null {
    if (!pull || !text(pull.username) || !text(pull.password)) {
        return null;
    }
    const server = normaliseRegistry(pull.server);
    if (!server || (server !== normaliseRegistry(registry) && server !== normaliseRegistry(host))) {
        return null;
    }
    return Buffer.from(`${pull.username}:${pull.password}`, 'utf8').toString('base64');
}

function normaliseRegistry(value: unknown): string {
    let raw = text(value).toLowerCase();
    raw = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (raw === 'index.docker.io' || raw === DOCKER_HUB_REGISTRY) {
        return 'docker.io';
    }
    return raw;
}

/** A token realm the pull credential may be sent to: the registry host itself, or Docker Hub's. */
export function trustedRealm(realm: string, registry: string, host: string): boolean {
    let realmHost: string;
    try {
        realmHost = new URL(realm).hostname.toLowerCase();
    } catch {
        return false;
    }
    if (realmHost === host.toLowerCase() || realmHost === registry.toLowerCase()) {
        return true;
    }
    return normaliseRegistry(registry) === 'docker.io' && realmHost === 'auth.docker.io';
}

/**
 * For an image index / manifest list: the digest of the `linux/amd64` entry, else of the first entry
 * that is not an attestation (`platform.os: unknown`). `null` for a plain manifest.
 */
export function platformManifestDigest(body: unknown): string | null {
    const manifests = (body as { manifests?: unknown } | null)?.manifests;
    if (!Array.isArray(manifests) || manifests.length === 0) {
        return null;
    }
    type Entry = { digest?: unknown; platform?: { os?: unknown; architecture?: unknown } };
    const entries = manifests as Entry[];
    const runnable = entries.filter((entry) => text(entry?.platform?.os) !== 'unknown');
    const amd64 = runnable.find(
        (entry) =>
            text(entry?.platform?.os) === 'linux' &&
            text(entry?.platform?.architecture) === 'amd64',
    );
    const digest = text((amd64 ?? runnable[0] ?? entries[0])?.digest);
    return DIGEST_RE.test(digest) ? digest : null;
}

function unavailable(reason: string): AppImageUserReadResult {
    return { status: 'unavailable', reason };
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function messageOf(error: unknown): string {
    if (error instanceof Error) return error.message.slice(0, 300);
    return typeof error === 'string' ? error.slice(0, 300) : 'unknown error';
}
