import {
    Body,
    CanActivate,
    Controller,
    HttpCode,
    HttpStatus,
    Injectable,
    NotFoundException,
    Post,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthAccountRepository, buildPluginProviderId } from '@ever-works/agent/database';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import {
    E2eGitHubConnectionSeedDto,
    E2E_CONNECTION_SEED_DEFAULT_SCOPE,
} from './dto/e2e-github-connection-seed.dto';

/**
 * APW-13 T63 — the non-production GitHub connection-seeding route of the PR
 * lanes (plan §8.8 surface **(b)**, `plan.md:661`).
 *
 * Spec: `docs/specs/features/app-works/APW-13-golden-paths/spec.md` (FR-56);
 * task T63 (`tasks.md:723-737`), whose `Done when` is "T14, T15, T16, T30 and
 * T31 run un-fixme'd against the fake and pass"; CONTRACTS §7's
 * `EVER_WORKS_E2E_FAKES` / `APW_E2E_GITHUB_FAKE_URL` rows and resolution R-40
 * (`CONTRACTS.md:87`) are the standing pattern.
 *
 *   | Route                                      | Auth    | Gate                                                                                                     | Success | Refused |
 *   | ------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------- | ------- | ------- |
 *   | `POST /api/e2e/github-connection/seed`     | session | `NODE_ENV !== 'production'` **and** `EVER_WORKS_E2E_FAKES === '1'` **and** `APW_E2E_GITHUB_FAKE_URL` set | 201     | 404 / 401 |
 *
 * ## The problem this route closes (FR-56, S10)
 *
 * Every create, fork and link scenario needs the run account to hold a Git
 * credential, and until this route there was **no supported surface** for one:
 * `packages/plugins/github/src/github.plugin.ts` declares
 * `configurationMode: 'admin-only'`, its `settingsSchema` has no `accessToken`
 * field, and `plugin-operations.service.ts` refuses user- and work-scope
 * settings on an admin-only plugin. `git.facade.ts` reads a token from an OAuth
 * account row or from a plugin setting, and only the account row is reachable.
 * T63's two candidate surfaces were (a) widen the plugin contract — refused, it
 * widens a security boundary and is the owner's call — and (b) this one.
 *
 * **The decision, recorded here and in CONTRACTS §7 / ACCEPTANCE §0.5:**
 * surface **(b)**. The PR lanes seed a fake-GitHub account row through this
 * route; the live lanes use the **operator-run OAuth connect** for the machine
 * account, recorded in T20's estate file (`docs/runbooks/app-works-acceptance-lanes.md`).
 * Surface (a) is not landed, and this route deliberately does not depend on it:
 * the `admin-only` refusals in `plugin-operations.service.ts` still refuse
 * everything they refused before.
 *
 * ## The two-variable gate, read production-first
 *
 * {@link isE2eGitHubConnectionSeedEnabled} reads `NODE_ENV` **first** and
 * returns before either variable is consulted, so a stray
 * `EVER_WORKS_E2E_FAKES: '1'` in a production manifest is inert rather than
 * merely discouraged — the same shape as `E2E_APP_LAUNCHER_SEED`
 * (`apps/api/src/app-launcher/e2e-seed.controller.ts:156-165`, R-40's first
 * instance) and `config.subscriptions.bypassSeatLimitsInE2E()`.
 *
 * The second half of the gate is the pair the **plugin** requires: a row seeded
 * while `EVER_WORKS_E2E_FAKES=1` but with no `APW_E2E_GITHUB_FAKE_URL` would be
 * a live credential handed to a plugin that is still pointed at
 * `api.github.com`. Requiring both variables is what makes this route seed a
 * connection to *the fake* and never to the real service, and it is why the
 * gate is read as two variables rather than one switch
 * (`packages/plugins/github/src/e2e-fakes.ts:51-64`, whose arming rule — exactly
 * the string `'1'`, origin non-empty after trimming trailing slashes — this
 * function repeats on purpose, because `apps/api` does not depend on the plugin
 * package and must not acquire that dependency for a fixture route).
 *
 * **`404`, never `403`, and before the handler.** {@link E2eConnectionSeedEnabledGuard}
 * runs before the method body, so a refused installation performs no read, no
 * write and no validation — the route is indistinguishable from one that was
 * never mounted, and a malformed body cannot turn a `404` into a `400`. `403`
 * would confirm that a non-production seeding route exists on this host, which
 * is exactly the reconnaissance answer a fixture route must not give.
 *
 * ## Two gates, and why both are needed
 *
 * `git-provider.module.ts` registers this controller **only when the gate is
 * open at boot**, so a production process has no such route in its router at
 * all; the guard re-reads the gate **on every request**, so flipping the
 * variables in a running non-production process takes effect without a restart,
 * and a process that booted outside production cannot serve the route once it
 * is pointed at production traffic. Neither alone is the whole guarantee: the
 * registration is what makes the route absent in production, the guard is what
 * makes the refusal a property of the request rather than of the boot.
 *
 * ## Session-authenticated, never public
 *
 * There is deliberately no `@Public()`: unlike the read route beside it
 * (`GET /api/git-providers/:providerId/connection`) this one **writes a
 * credential row**, and everything it writes belongs to the signed-in person.
 * A request without a session is refused twice over — by the platform's global
 * `AuthSessionGuard` (`apps/api/src/auth/guards/auth-session.guard.ts`) and,
 * defensively, by the handler below, so a lean harness that mounts this
 * controller without that global guard still cannot mint a connection for
 * nobody.
 *
 * ## What it writes, and what it deliberately does not
 *
 * One `account` row, through the platform's own
 * `AuthAccountRepository.upsertProviderAccount` — the same call
 * `OAuthService.handleOAuthCallback` makes
 * (`apps/api/src/plugins-capabilities/oauth/oauth.service.ts:142-158`) — so the
 * row this fixture writes is the row the product writes, with the product's own
 * uniqueness rules rather than a fixture-shaped schema. No network call, no
 * plugin write, no settings store, no event: the route's whole job is to leave
 * the row `GitProviderService.checkConnection` reads
 * (`git-provider.service.ts:45-72`), which is what turns the lane's
 * `authMethod: 'oauth'` into a fact instead of a hope.
 *
 * It does **not** write `plugin_settings` of any kind, and it does not touch the
 * GitHub plugin's `admin-only` configuration: surface (a) is exactly the change
 * this task declined to make.
 */

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** The arming variable — the CONTRACTS §7 row of the same name (APW-13 T5). */
export const E2E_CONNECTION_SEED_FAKES_ENV = 'EVER_WORKS_E2E_FAKES';

/** The fake's origin. Required as well: it is what keeps the seeded row pointed at the fake. */
export const E2E_CONNECTION_SEED_FAKE_URL_ENV = 'APW_E2E_GITHUB_FAKE_URL';

/** The provider this route seeds for. Spelled once. */
export const E2E_CONNECTION_SEED_PROVIDER_ID = 'github';

/** The provider key the row is stored under (`account.providerId`). */
export function e2eConnectionSeedProviderKey(): string {
    return buildPluginProviderId(E2E_CONNECTION_SEED_PROVIDER_ID);
}

/**
 * Whether this process may serve the connection-seeding route (plan §8.8 (b)).
 *
 * **Production first.** `NODE_ENV === 'production'` returns `false` before
 * either variable is read at all, which is the one property the task pins: the
 * refusal is a `404` in production **even when both variables are set**, and a
 * `404` for a missing variable anywhere else.
 *
 * The arming rule is the plugin's own (`e2e-fakes.ts:55-63`): exactly the string
 * `'1'` — not `'true'`, not `'yes'` — and an origin that is non-empty once
 * trailing slashes are stripped. `'true'` is deliberately **not** accepted here
 * even though `platform-catalog.service.ts:395-398` accepts it for the catalog
 * override: a route that writes a credential row must not be the most
 * permissive reader of a switch, and the lane that arms the fake sets `'1'`
 * (`.github/workflows/e2e.yml`, `EVER_WORKS_E2E_FAKES: '1'`).
 *
 * Exported so a caller that must agree with the guard — the boot-time
 * registration in `git-provider.module.ts`, a spec — asks this function instead
 * of re-reading the variables.
 */
export function isE2eGitHubConnectionSeedEnabled(): boolean {
    if (process.env.NODE_ENV === 'production') {
        return false;
    }
    if (process.env[E2E_CONNECTION_SEED_FAKES_ENV] !== '1') {
        return false;
    }
    const configured = process.env[E2E_CONNECTION_SEED_FAKE_URL_ENV];
    if (typeof configured !== 'string') {
        return false;
    }
    return configured.trim().replace(/\/+$/, '').length > 0;
}

/**
 * The gate, as a guard — so it answers before the handler runs.
 *
 * A closed gate is the platform's opaque `404` (`'Cannot find route'`, the same
 * message `E2eSeedEnabledGuard` and the Fleet guard throw), never a `403`. The
 * check throws rather than returning `false` so the body is the platform's own
 * not-found shape and no filter has to translate it.
 */
@Injectable()
export class E2eConnectionSeedEnabledGuard implements CanActivate {
    canActivate(): boolean {
        if (!isE2eGitHubConnectionSeedEnabled()) {
            throw new NotFoundException('Cannot find route');
        }
        return true;
    }
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

/** How the platform reports a connection this route wrote (`authMethod`). */
export const E2E_CONNECTION_SEED_AUTH_METHOD = 'oauth';

/**
 * What a successful seed answers.
 *
 * `connected` and `authMethod` are echoed in the shape
 * `GET /api/git-providers/github/connection` reports them
 * (`GitProviderConnectionInfo`), so a caller can assert the surface from the
 * write's own answer **and** then re-read the platform's. Nothing here is a
 * secret: the token is never echoed, not even its length.
 */
export interface E2eGitHubConnectionSeedResponse {
    /** The signed-in person the row belongs to. */
    userId: string;
    /** `account.providerId` — `plugin:github`. */
    providerId: string;
    /** `account.accountId` — per person by construction. */
    accountId: string;
    /** `account.username` — the login the lane recorded, when it named one. */
    username: string | null;
    /** `account.scope` — what the git facade's required-scope check reads. */
    scope: string;
    /** Always `true`: the route answers only after the row is written. */
    connected: true;
    /** Always `oauth`: the row is an OAuth account row, never a setting. */
    authMethod: typeof E2E_CONNECTION_SEED_AUTH_METHOD;
    /** The plan §8.8 surface this row is, spelled once, for the estate file. */
    surface: string;
}

/**
 * `POST /api/e2e/github-connection/seed` — write one GitHub connection row for
 * the signed-in person into the running (non-production) API's own data store.
 */
@ApiTags('Git Providers')
@ApiBearerAuth('JWT-auth')
@Controller('api/e2e/github-connection/seed')
@UseGuards(E2eConnectionSeedEnabledGuard)
export class E2eGitHubConnectionSeedController {
    constructor(private readonly accounts: AuthAccountRepository) {}

    /**
     * Seed one `plugin:github` account row for the caller.
     *
     * The person is the **session**; the provider, the token type and the
     * expiry are this route's own decisions (see the DTO's doc). The row is
     * written through the repository the OAuth callback uses, so a second call
     * for the same person updates the row it wrote rather than failing on the
     * table's unique indexes — which is what makes the helper idempotent across
     * a lane that re-runs.
     */
    @Post()
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary: 'Seed a GitHub connection row (non-production only)',
        description:
            'Writes one `account` row (`plugin:github`) for the signed-in person: the token, login and scope the lane names, with a per-person account id and no expiry. Answers 404 unless `NODE_ENV !== "production"`, `EVER_WORKS_E2E_FAKES === "1"` and `APW_E2E_GITHUB_FAKE_URL` is set. No network call.',
    })
    @ApiResponse({ status: 201, description: 'The connection row, as the platform reports it.' })
    @ApiResponse({ status: 400, description: 'A body outside the closed fixture shape.' })
    @ApiResponse({ status: 401, description: 'No session.' })
    @ApiResponse({
        status: 404,
        description: 'The seeding route is closed (production, or the fake GitHub is not armed).',
    })
    async seed(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: E2eGitHubConnectionSeedDto,
    ): Promise<E2eGitHubConnectionSeedResponse> {
        // Defence in depth, not the primary refusal: the platform's global
        // `AuthSessionGuard` already answered 401 before this method ran. A
        // harness that mounts this controller without that guard must not be
        // able to write a credential row owned by nobody.
        const userId = typeof auth?.userId === 'string' ? auth.userId.trim() : '';
        if (userId.length === 0) {
            throw new UnauthorizedException();
        }

        const providerId = e2eConnectionSeedProviderKey();
        const scope = trimmedOrNull(body.scope) ?? E2E_CONNECTION_SEED_DEFAULT_SCOPE;
        const username = trimmedOrNull(body.username);

        const account = await this.accounts.upsertProviderAccount({
            userId,
            providerId,
            // **Per person, and stated here rather than inferred.**
            // `AuthAccountRepository.resolveAccountId` would otherwise fall back
            // to `accountData.email || accountData.username`, and the lane DOES
            // name a username (the fake's login) — so every throwaway account of
            // a run would resolve to the same `accountId` and the table's
            // `(providerId, accountId)` unique index would refuse the second
            // account with `PROVIDER_ACCOUNT_ALREADY_LINKED`
            // (`auth-account.repository.ts:6,234-267`). This is the repository's
            // own last-resort form (`:66`), written explicitly so the property
            // does not depend on which field a caller happens to fill in.
            accountId: `${userId}:${providerId}`,
            accessToken: body.accessToken,
            tokenType: 'Bearer',
            scope,
            username,
            // A lane runs for minutes; an expiry would turn a passing run into a
            // `connected: false` read part-way through, which is exactly the
            // class of flake this route exists to remove.
            accessTokenExpiresAt: null,
            refreshToken: null,
            refreshTokenExpiresAt: null,
            idToken: null,
            email: null,
            metadata: {
                seededBy: 'POST /api/e2e/github-connection/seed',
                surface: 'plan §8.8 surface (b) — the non-production connection-seeding path',
            },
        });

        return {
            userId,
            providerId,
            accountId: account.accountId,
            username: account.username ?? null,
            scope: account.scope ?? scope,
            connected: true,
            authMethod: E2E_CONNECTION_SEED_AUTH_METHOD,
            surface: 'plan §8.8 surface (b) — seeded fake-GitHub OAuth account row',
        };
    }
}

/** `''`/whitespace → `null`, so an omitted fixture field stays omitted. */
function trimmedOrNull(value: string | null | undefined): string | null {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}
