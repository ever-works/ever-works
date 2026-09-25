import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { APP_BUILD_PULL_TOKEN_EXPIRY_WARN_DAYS, type AppBuildKind } from '@ever-works/contracts';
import { AppBuildRepository } from '../database/repositories/app-build.repository';
import { WorkBuild } from '../entities/work-build.entity';
import { APP_BUILD_PLUGIN_RESOLVER, type AppBuildPluginResolver } from './app-builds.service';

/**
 * APW-05 T17 — `AppBuildPullTokenService`, the registry pull token of plan §4.12
 * (`plan.md:1098-1136`), `APW05-G07`, FR-50/FR-51, ACC-05-21.
 *
 * ## Why this is a service and not `validateSettings` (`APW05-G07`)
 *
 * `IPlugin.validateSettings?(settings)`
 * (`packages/plugin/src/contracts/plugin.interface.ts:75`) receives only the
 * settings map — no `workId`, no image repository, no Build sha — and it returns a
 * `ValidationResult`, so it can neither ask "can this token read **this** image"
 * nor write `pullTokenExpiresAt`; and both callers flatten its errors into
 * `Error('Invalid settings: <messages>')`, so a stable code could never reach the
 * web. The check is therefore this service, and the codes below ARE the response
 * body the web renders as `dashboard.workDetail.builds.pullToken.*`
 * (`plan.md:1114-1115`).
 *
 * ## The five steps of §4.12, in order
 *
 *   1. resolve the plugin and `imageRepository` through `BuildFacadeService`;
 *   2. take the newest Build with `imageDigest` set — none ⇒ **409
 *      `pullTokenNoImageYet`** and no Build touched;
 *   3. `plugin.checkImageAccess({ imageRepository, tag: 'sha-<commitSha>',
 *      pullToken })`;
 *   4. map the result onto a refusal code — see {@link refusalFor};
 *   5. on success store `pullToken` **and** `pullTokenExpiresAt` through
 *      `writePlatformManagedWorkSettings`, which encrypts `x-secret` keys, skips
 *      `validateSettings` and emits the pull-token-saved event that dispatches
 *      `app-build-prepare` (reason `pullTokenSaved`, §7.2).
 *
 * ## The token never comes back
 *
 * `save` returns the visibility, the digest and the expiry — **never the token**,
 * and never a log line containing it. The refusal codes carry no token-shaped
 * data either, which is what lets the same codes be both the response body and a
 * translated message (`plan.md:1204-1205`).
 *
 * ## The writer is a port, because T17 does not own `PluginSettingsService`
 *
 * Plan §4.12:1116-1119 names an additive
 * `PluginSettingsService.writePlatformManagedWorkSettings(pluginId, workId,
 * values)`. That method does not exist on `develop` and T17's file list does not
 * include `packages/agent/src/plugins/services/plugin-settings.service.ts`, so the
 * call is made through {@link APP_BUILD_PLATFORM_SETTINGS_WRITER} — the method
 * name above is the member, and the intended binding is
 * `{ provide: APP_BUILD_PLATFORM_SETTINGS_WRITER, useExisting: PluginSettingsService }`
 * once that method lands. Routed as a finding in the task report.
 */

/**
 * _Provisional — APW-05's own additive method on `PluginSettingsService`
 * (plan §4.12:1116-1119)._
 *
 * The three properties the plan gives it are the reason it is a separate entry
 * point rather than `updateWorkSettings`: it encrypts `x-secret` keys, it **skips
 * `validateSettings`** (a token that cannot read this image yet must still be
 * storable, or the owner could never fix a typo), and it emits the pull-token
 * event that dispatches a prepare.
 */
export interface AppBuildPlatformManagedSettingsWriter {
    writePlatformManagedWorkSettings(
        pluginId: string,
        workId: string,
        values: Record<string, unknown>,
    ): Promise<unknown>;
}

/** DI token for {@link AppBuildPlatformManagedSettingsWriter}. */
export const APP_BUILD_PLATFORM_SETTINGS_WRITER = Symbol('APP_BUILD_PLATFORM_SETTINGS_WRITER');

/** The refusal codes of §4.12 step 4 plus the two the route table adds (`plan.md:1200`). */
export const APP_BUILD_PULL_TOKEN_CODES = [
    'pullTokenNoImageYet',
    'pullTokenPublicImage',
    'pullTokenTooBroad',
    'pullTokenFineGrained',
    'pullTokenCannotRead',
    'pullTokenUnavailable',
] as const;

/** One pull-token refusal code. */
export type AppBuildPullTokenCode = (typeof APP_BUILD_PULL_TOKEN_CODES)[number];

/** The response body shape of plan §5:1200 — never the token. */
export interface AppBuildPullAccess {
    readonly visibility: 'public' | 'private' | 'unknown';
    readonly tokenSet: boolean;
    readonly tokenExpiresAt: string | null;
}

/** What `save` answers. */
export type AppBuildPullTokenSaveResult =
    | {
          readonly ok: true;
          readonly pullAccess: AppBuildPullAccess;
          readonly buildId: string;
          readonly imageDigest: string;
          /** Days until the token expires, or `null` when it never does. */
          readonly expiresInDays: number | null;
      }
    | {
          readonly ok: false;
          readonly status: 409 | 422 | 503;
          readonly code: AppBuildPullTokenCode;
      };

/** What the resolved plugin half of §4.12 needs — the `checkImageAccess` member and nothing else. */
export interface AppBuildImageAccessChecker {
    readonly pluginId: string;
    readonly buildKind?: AppBuildKind;
    checkImageAccess?(input: {
        readonly imageRepository: string;
        readonly tag: string;
        readonly pullToken?: string;
    }): Promise<{
        readonly visibility: 'public' | 'private' | 'unknown';
        readonly readable: boolean;
        readonly tokenScopesOk?: boolean;
        readonly tokenExpiresAt?: string | null;
        readonly digest?: string;
    }>;
}

/**
 * Map one `ImageAccessResult` onto a refusal code, or `null` for "accepted".
 *
 * The three codes §4.12 fixes, and the one discriminator the contract carries:
 *
 * | Result                                                | Code                  |
 * | ----------------------------------------------------- | --------------------- |
 * | `visibility === 'public'`                              | `pullTokenPublicImage` |
 * | `tokenScopesOk === false` — scopes read, and wrong     | `pullTokenTooBroad`    |
 * | scopes **absent** (`undefined`) and not readable       | `pullTokenFineGrained` |
 * | not readable, any other reason                         | `pullTokenCannotRead`  |
 *
 * `tokenScopesOk === false` is the "broader or narrower than `read:packages`"
 * case (`build.interface.ts:350`) and `undefined` is the absent
 * `x-oauth-scopes` header, which §4.12:1120-1122 measures as a **fine-grained**
 * token: those 403 on GHCR pulls, so they are refused with the classic-token copy
 * rather than with the generic one.
 */
export function pullTokenRefusalFor(result: {
    readonly visibility: 'public' | 'private' | 'unknown';
    readonly readable: boolean;
    readonly tokenScopesOk?: boolean;
}): AppBuildPullTokenCode | null {
    if (result.visibility === 'public') return 'pullTokenPublicImage';
    if (result.tokenScopesOk === false) return 'pullTokenTooBroad';
    if (result.readable) return null;
    if (result.tokenScopesOk === undefined) return 'pullTokenFineGrained';
    return 'pullTokenCannotRead';
}

/** The HTTP status each code answers with (`plan.md:1200`). */
export function pullTokenStatusCodeFor(code: AppBuildPullTokenCode): 409 | 422 | 503 {
    switch (code) {
        case 'pullTokenNoImageYet':
            return 409;
        case 'pullTokenUnavailable':
            return 503;
        default:
            return 422;
    }
}

@Injectable()
export class AppBuildPullTokenService {
    private readonly logger = new Logger(AppBuildPullTokenService.name);

    constructor(
        private readonly builds: AppBuildRepository,
        @Optional()
        @Inject(APP_BUILD_PLUGIN_RESOLVER)
        private readonly plugins?: AppBuildPluginResolver,
        @Optional()
        @Inject(APP_BUILD_PLATFORM_SETTINGS_WRITER)
        private readonly settings?: AppBuildPlatformManagedSettingsWriter,
    ) {}

    /**
     * Save and validate a GHCR pull token (`plan.md:1109-1124`).
     *
     * The route is `PUT /api/works/:id/builds/pull-token` and a viewer is a `403`
     * at the controller, before this is reached (`plan.md:1200`) — this method
     * answers only the four validation outcomes.
     */
    async save(
        workId: string,
        userId: string,
        token: string,
    ): Promise<AppBuildPullTokenSaveResult> {
        const binding = await this.resolve(userId, workId);
        // No settings writer means step 5 cannot store the token, so answering
        // `ok: true, tokenSet: true` would claim a save that never happened. Refuse
        // up front, before the token is sent to the registry for nothing.
        if (!binding || !binding.imageRepository || !binding.checkImageAccess || !this.settings) {
            return { ok: false, status: 503, code: 'pullTokenUnavailable' };
        }

        // §4.12 step 2: the newest Build with an image digest. A Work that has
        // never pushed has nothing for a token to read, and answering 409 here keeps
        // the owner from storing a token the platform cannot check.
        const build = await this.newestBuildWithDigest(workId);
        if (!build || !build.imageDigest) {
            return { ok: false, status: 409, code: 'pullTokenNoImageYet' };
        }

        let result: Awaited<
            ReturnType<NonNullable<AppBuildImageAccessChecker['checkImageAccess']>>
        >;
        try {
            result = await binding.checkImageAccess({
                imageRepository: binding.imageRepository,
                tag: `sha-${build.commitSha}`,
                pullToken: token,
            });
        } catch (error) {
            this.logger.warn(
                `App builds: checking the pull token of work ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }); the token was not stored.`,
            );
            return { ok: false, status: 503, code: 'pullTokenUnavailable' };
        }

        const refusal = pullTokenRefusalFor(result);
        if (refusal) {
            return { ok: false, status: pullTokenStatusCodeFor(refusal), code: refusal };
        }

        const expiresAt = result.tokenExpiresAt ?? null;

        try {
            await this.settings.writePlatformManagedWorkSettings(binding.pluginId, workId, {
                pullToken: token,
                pullTokenExpiresAt: expiresAt,
            });
        } catch (error) {
            this.logger.warn(
                `App builds: storing the pull token of work ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return { ok: false, status: 503, code: 'pullTokenUnavailable' };
        }

        return {
            ok: true,
            pullAccess: {
                visibility: result.visibility,
                tokenSet: true,
                tokenExpiresAt: expiresAt,
            },
            buildId: build.id,
            imageDigest: result.digest ?? build.imageDigest,
            expiresInDays: daysUntil(expiresAt),
        };
    }

    /** The days until an expiry, for the FR-51 warning; `null` when it never expires. */
    warningDaysUntilExpiry(expiresAt: string | null): number | null {
        const days = daysUntil(expiresAt);
        return days !== null && days <= APP_BUILD_PULL_TOKEN_EXPIRY_WARN_DAYS ? days : null;
    }

    private async resolve(
        userId: string,
        workId: string,
    ): Promise<(AppBuildImageAccessChecker & { readonly imageRepository: string | null }) | null> {
        if (!this.plugins) return null;
        try {
            const bound = await this.plugins.resolve(workId, userId);
            if (!bound) return null;
            return { ...bound };
        } catch (error) {
            this.logger.warn(
                `App builds: resolving the build plugin of work ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return null;
        }
    }

    /**
     * The newest Build of this Work that has an `imageDigest`.
     *
     * `AppBuildRepository` exposes no "newest with a digest" read and this task
     * does not own that file, so the newest page of the Builds list is walked —
     * it is ordered `createdAt DESC`, so the first hit IS the newest. Bounded at
     * one page: a Work whose 100 newest Builds all lack a digest has never pushed
     * an image, which is the same answer as "none at all".
     * Routed as a finding: `findNewestWithDigest(workId)` there replaces this.
     */
    private async newestBuildWithDigest(workId: string): Promise<WorkBuild | null> {
        const page = await this.builds.findPage(workId, {}, 1, 100);
        return page.rows.find((row) => Boolean(row.imageDigest)) ?? null;
    }
}

/** Whole days from now until an instant, or `null` for "never expires" / unparseable. */
function daysUntil(expiresAt: string | null): number | null {
    if (!expiresAt) return null;
    const parsed = new Date(expiresAt).getTime();
    if (Number.isNaN(parsed)) return null;
    return Math.floor((parsed - Date.now()) / 86_400_000);
}
