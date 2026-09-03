import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentPluginAllowlistService } from './allowlist.service';

/**
 * Git acquirer for Agent Plugins packages.
 *
 * ## Why this does not go through `GitFacadeService`
 *
 * The obvious reuse — the agent already clones repositories — does not fit,
 * and the mismatch is structural rather than cosmetic:
 *
 * - `cloneOrPull` is **owner/repo shaped**, not URL shaped. The Agent Plugins
 *   spec identifies a source by URL, and an arbitrary git host does not
 *   decompose into a GitHub-style owner/repo pair.
 * - It calls `resolvePluginAndToken`, so it requires an ENABLED git-provider
 *   plugin and a user credential. Package acquisition is an operator-level,
 *   usually anonymous, fetch of a public repository. Routing it through the
 *   provider chain would make installs fail on any deployment with no git
 *   plugin enabled — the same class of defect as the facade early-return
 *   fixed in Phase 1, where a feature silently disappeared rather than merely
 *   being unavailable.
 *
 * So this is a standalone, credential-free, URL-first acquirer. It is
 * deliberately narrower than the facade: it clones public repositories at a
 * pinned ref and does nothing else.
 */

/** Depth 1: we want a snapshot of one ref, never the history. */
const CLONE_DEPTH = 1;

export interface GitAcquireInput {
    /** HTTPS clone URL. */
    url: string;
    /** Branch or tag to pin. Defaults to the remote's default branch. */
    ref?: string;
    /** Directory the working tree is written into. */
    destDir: string;
}

export interface GitAcquireResult {
    url: string;
    ref: string | null;
    /** The commit actually checked out — the only durable identity of a fetch. */
    resolvedSha: string;
    path: string;
}

/** The subset of isomorphic-git this acquirer uses, so tests can inject a stub. */
export interface GitLike {
    clone(options: Record<string, unknown>): Promise<unknown>;
    resolveRef(options: Record<string, unknown>): Promise<string>;
    listServerRefs(options: Record<string, unknown>): Promise<Array<{ ref: string; oid: string }>>;
}

/**
 * Strip `user:password@` from a URL before it is shown, stored or logged.
 *
 * Applied with a regex rather than via `URL`, deliberately: a value that fails
 * to parse can still contain a credential, and that is exactly the value most
 * likely to be echoed verbatim into an error message. Redaction has to work on
 * the string, not on the parse.
 *
 * This exists because the credential check itself was the leak — the first
 * version of the refusal interpolated the whole URL into a message that is
 * returned by the API, written to the package row and printed to the log. A
 * check that reports the secret it is protecting is worse than no check.
 */
export function redactUrl(value: string): string {
    return value.replace(/(\/\/)[^/@\s]*:[^/@\s]*@/gu, '$1<redacted>@');
}

/**
 * Result of {@link validateGitUrl}.
 *
 * Deliberately a single interface with nullable members rather than the
 * discriminated union `{ ok: true; url } | { ok: false; reason }` that would be
 * idiomatic elsewhere in this program. `packages/agent` compiles with
 * `strictNullChecks: false`, and under that setting TypeScript does NOT narrow
 * a boolean-literal discriminant — `if (!check.ok)` leaves `check` unnarrowed,
 * so `check.reason` fails to compile. The conformance library is strict and
 * uses unions freely; code bridging it into this package must not assume that
 * narrowing survives the crossing.
 */
export interface GitUrlCheck {
    ok: boolean;
    /** Parsed URL when `ok`, otherwise null. */
    url: URL | null;
    /** Operator-facing refusal, otherwise null. */
    reason: string | null;
}

/**
 * URL policy, applied BEFORE the allowlist and before any network call.
 *
 * Each rule refuses a specific concrete attack, so none should be relaxed
 * without replacing the control:
 *
 * - **https only.** `http:` is a plaintext fetch of content that an agent will
 *   later read as instructions; a network position turns that into arbitrary
 *   instruction injection. `file:`, `ssh:` and git's `ext::` transport are
 *   refused because `ext::` executes a shell command by design, and `file:`
 *   would let a URL read the host filesystem.
 * - **No embedded credentials.** A `user:pass@host` URL would be recorded on
 *   the package row, printed in findings, and logged — leaking the credential
 *   into three durable places at once. Refusing is the only way to keep it out
 *   of all of them, and the spec has no need for authenticated clones.
 */
export function validateGitUrl(value: string): GitUrlCheck {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return { ok: false, url: null, reason: `"${redactUrl(value)}" is not a valid URL.` };
    }

    if (url.protocol !== 'https:') {
        return {
            ok: false,
            url: null,
            reason:
                `Refusing git URL "${redactUrl(value)}": only https:// is supported. Plaintext and ` +
                `local transports are rejected because package contents are read as ` +
                `agent instructions.`,
        };
    }

    if (url.username || url.password) {
        return {
            ok: false,
            url: null,
            reason:
                `Refusing git URL "${redactUrl(value)}": it embeds credentials. The URL is stored ` +
                `and logged, so a credential in it would be persisted in cleartext. Use ` +
                `a public repository.`,
        };
    }

    if (!url.hostname) {
        return { ok: false, url: null, reason: `Refusing git URL "${redactUrl(value)}": no host.` };
    }

    return { ok: true, url, reason: null };
}

/**
 * Match a ref against an allowlist pattern.
 *
 * Supports an exact ref or a trailing `*`. Deliberately NOT a regular
 * expression: an operator-supplied regex is both a footgun (an unescaped `.`
 * silently widens the grant) and a denial-of-service vector through
 * catastrophic backtracking.
 */
export function refMatchesPattern(ref: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) {
        return ref.startsWith(pattern.slice(0, -1));
    }
    return ref === pattern;
}

/** Where a git-sourced package is materialised, keyed by its resolved SHA. */
export function gitPackageDir(root: string, url: string, sha: string): string {
    return join(root, 'git', encodeURIComponent(url), sha);
}

@Injectable()
export class AgentPluginGitSource {
    private readonly logger = new Logger(AgentPluginGitSource.name);
    private git: GitLike | null = null;
    private httpClient: unknown = null;

    constructor(private readonly allowlist: AgentPluginAllowlistService) {}

    /**
     * Test-only injection seam, mirroring `PluginInstallerService.setPacote`.
     * Production code lazy-imports the real module instead.
     */
    setGitImplementation(impl: GitLike, http: unknown): void {
        this.git = impl;
        this.httpClient = http;
    }

    /**
     * Clone `input.url` at `input.ref` into `input.destDir`.
     *
     * Ordering is a security property, not a style choice: URL policy, then
     * allowlist, then — only if both pass — the network.
     */
    async acquire(input: GitAcquireInput): Promise<GitAcquireResult> {
        const parsed = validateGitUrl(input.url);
        if (!parsed.ok) {
            throw new HttpException(
                {
                    statusCode: HttpStatus.CONFLICT,
                    message: parsed.reason,
                    url: redactUrl(input.url),
                },
                HttpStatus.CONFLICT,
            );
        }

        const allow = await this.allowlist.check(input.url, 'git');
        if (!allow.allowed) {
            throw new HttpException(
                {
                    statusCode: HttpStatus.CONFLICT,
                    message: allow.reason,
                    url: redactUrl(input.url),
                },
                HttpStatus.CONFLICT,
            );
        }

        // A ref pattern on the allowlist entry constrains WHICH ref may be
        // fetched. Without it, allowlisting a repository would authorise every
        // branch in it, including one an outside contributor can push to.
        const pattern = allow.entry?.versionRange?.trim();
        if (pattern && input.ref && !refMatchesPattern(input.ref, pattern)) {
            throw new HttpException(
                {
                    statusCode: HttpStatus.CONFLICT,
                    message:
                        `Ref "${input.ref}" is not permitted for "${redactUrl(input.url)}" — the ` +
                        `allowlist entry restricts it to "${pattern}".`,
                    url: redactUrl(input.url),
                },
                HttpStatus.CONFLICT,
            );
        }

        const { git, http } = await this.load(input.url);
        const fs = await nodeFs();

        // Wipe first: an aborted earlier clone leaves a partial tree that
        // would otherwise be validated and possibly loaded as if complete.
        await rm(input.destDir, { recursive: true, force: true });
        await mkdir(input.destDir, { recursive: true });

        try {
            await git.clone({
                fs,
                http,
                dir: input.destDir,
                url: input.url,
                depth: CLONE_DEPTH,
                singleBranch: true,
                noTags: true,
                // No `onAuth`. An anonymous clone that gets challenged fails
                // rather than silently reaching for ambient credentials.
                ...(input.ref ? { ref: input.ref } : {}),
            });

            const resolvedSha = await git.resolveRef({ fs, dir: input.destDir, ref: 'HEAD' });

            this.logger.log(
                `Cloned ${redactUrl(input.url)}${input.ref ? `#${input.ref}` : ''} at ${resolvedSha.slice(0, 12)}`,
            );

            return { url: input.url, ref: input.ref ?? null, resolvedSha, path: input.destDir };
        } catch (err) {
            // Leave nothing half-written behind: a partial tree that passes a
            // later scan is worse than no tree at all.
            await rm(input.destDir, { recursive: true, force: true }).catch(() => undefined);

            if (err instanceof HttpException) throw err;
            const reason = err instanceof Error ? err.message : String(err);

            // The same mapping the code-plugin installer uses, so an operator
            // reading API errors sees one vocabulary across both installers.
            const code = /timeout|ETIMEDOUT/i.test(reason)
                ? HttpStatus.GATEWAY_TIMEOUT
                : HttpStatus.BAD_GATEWAY;
            throw new HttpException(
                { statusCode: code, message: redactUrl(reason), url: redactUrl(input.url) },
                code,
            );
        }
    }

    /**
     * The commit a remote currently points `ref` at, WITHOUT cloning.
     *
     * Update checks run for every installed package, so cloning to answer
     * "is there anything new?" would download entire repositories on a
     * schedule to usually learn that nothing changed. `listServerRefs` is a
     * single ref-advertisement request and writes nothing to disk.
     *
     * Returns null rather than throwing: not knowing whether an update exists
     * must never fail the page that asked.
     */
    async remoteSha(url: string, ref?: string): Promise<string | null> {
        const parsed = validateGitUrl(url);
        if (!parsed.ok) return null;

        const allow = await this.allowlist.check(url, 'git');
        if (!allow.allowed) return null;

        const pattern = allow.entry?.versionRange?.trim();
        if (pattern && ref && !refMatchesPattern(ref, pattern)) return null;

        try {
            const { git, http } = await this.load(url);
            const refs = await git.listServerRefs({
                http,
                url,
                prefix: ref ? `refs/heads/${ref}` : 'HEAD',
            });
            return refs[0]?.oid ?? null;
        } catch (err) {
            this.logger.debug(
                `Remote ref lookup failed for ${redactUrl(url)}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return null;
        }
    }

    /**
     * Re-fetch an already-acquired package. A fresh shallow clone rather than
     * an incremental fetch: a depth-1 clone has no history worth preserving,
     * and re-cloning cannot leave a tree that is half old and half new.
     */
    async refresh(input: GitAcquireInput): Promise<GitAcquireResult> {
        return this.acquire(input);
    }

    private async load(url: string): Promise<{ git: GitLike; http: unknown }> {
        if (this.git && this.httpClient) {
            return { git: this.git, http: this.httpClient };
        }
        try {
            // Lazy, mirroring the pacote import in the code-plugin installer,
            // so packages/agent still builds and boots where the git source is
            // never used.
            const [mod, httpMod] = await Promise.all([
                import('isomorphic-git'),
                import('isomorphic-git/http/node'),
            ]);
            const git = ((mod as { default?: unknown }).default ?? mod) as GitLike;
            const http = (httpMod as { default?: unknown }).default ?? httpMod;
            this.git = git;
            this.httpClient = http;
            return { git, http };
        } catch {
            throw new HttpException(
                {
                    statusCode: HttpStatus.NOT_IMPLEMENTED,
                    message:
                        `Cannot fetch "${redactUrl(url)}": the git source requires the ` +
                        `'isomorphic-git' package, which is not installed.`,
                },
                HttpStatus.NOT_IMPLEMENTED,
            );
        }
    }
}

/** isomorphic-git takes an injected fs rather than importing one itself. */
async function nodeFs(): Promise<unknown> {
    const mod = await import('node:fs');
    return (mod as { default?: unknown }).default ?? mod;
}
