import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * APW-13 T63 — the body `POST /api/e2e/github-connection/seed` accepts.
 *
 * Spec: `docs/specs/features/app-works/APW-13-golden-paths/spec.md` (FR-56);
 * plan §8.8 surface **(b)** (`plan.md:661`, "a non-production connection-seeding
 * path") and §8.2's `connectCustomerGitHub` (`plan.md:504`), which is the
 * helper that calls this route.
 *
 * ## Why the caller may name the token and nothing else
 *
 * The row this route writes is the row `OAuthService.handleOAuthCallback`
 * writes (`apps/api/src/plugins-capabilities/oauth/oauth.service.ts:142-158`),
 * and the four facts that row carries from the provider are exactly what the
 * lane cannot obtain without a browser: the access token, the login, the
 * granted scopes and the account handle. Everything else about the row — the
 * person it belongs to, the provider it is for, the token type, the expiry — is
 * **decided by this route and not by the caller**:
 *
 *   - the person is the **session** (`@CurrentUser()`), never a field, so the
 *     route cannot mint a connection for somebody else;
 *   - the provider is `github`, spelled here and nowhere else in the body
 *     (`buildPluginProviderId('github')`), so a caller cannot seed a row for a
 *     provider this epic has no lane for;
 *   - the token never expires (`accessTokenExpiresAt: null`), because a lane
 *     runs for minutes and an expiry would turn a passing run into a
 *     `connected: false` read part-way through;
 *   - `accountId` is deliberately **not** in this DTO. `AuthAccountRepository`
 *     derives a per-person one (`<userId>:<providerId>`) when the caller names
 *     none, which is what lets two throwaway accounts of the same run both
 *     connect the lane's one fake identity: the table's unique index is
 *     `(providerId, accountId)` (`auth-account.entity.ts:6`), so a shared
 *     `accountId` would refuse the second account with
 *     `PROVIDER_ACCOUNT_ALREADY_LINKED`.
 *
 * ## Why the token is required rather than read from this process
 *
 * The token belongs to the **lane**, not to the API process: in the PR lane it
 * is the fake GitHub's seeded identity (`apps/web/e2e/fakes/github-fake/fixtures/catalog-pr-lane.seed.json`),
 * and the fake is test infrastructure that the platform never loads (plan §13,
 * Constitution I). So the harness passes it and the product never carries it.
 * A production process cannot reach this route at all — the gate refuses before
 * the body is read, and the controller is not even mounted
 * (`e2e-github-connection-seed.controller.ts`) — and a non-production process
 * only reaches it when the lane has armed **both** fake variables, which is the
 * same pair the GitHub plugin requires before it will send a call anywhere but
 * the fake.
 *
 * ## Why every field is bounded
 *
 * `account.accessToken`, `.scope` and `.username` are columns with real widths
 * (`accessToken`/`scope` are `text`, `username` is `varchar(255)`), and the
 * platform's `ValidationPipe` runs with `whitelist` +
 * `forbidNonWhitelisted` (`apps/api/src/main.ts:199-205`), so a misspelled
 * field is a `400` rather than a quietly ignored one. The bounds below are the
 * narrowest that admit a real GitHub credential: a PAT is ~40 characters and an
 * OAuth token ~40–255, so 512 is generous while still refusing a body that
 * carries a file.
 */

/** A token is a credential, not a document. */
export const E2E_CONNECTION_SEED_TOKEN_MAX_LENGTH = 512;

/** `account.username` is a `varchar(255)` column; a GitHub login is ≤ 39. */
export const E2E_CONNECTION_SEED_USERNAME_MAX_LENGTH = 120;

/**
 * `account.scope` holds a space- or comma-separated scope list, exactly as the
 * provider returned it (`AuthAccountRepository.parseScopes` splits on
 * `/[,\s]+/`). The pattern admits those separators and the characters GitHub
 * uses in scope names, and nothing else — so the column cannot be filled with
 * free text through a fixture route.
 */
export const E2E_CONNECTION_SEED_SCOPE_PATTERN = /^[A-Za-z0-9:_-]+(?:[ ,]+[A-Za-z0-9:_-]+)*$/;

/** `account.scope` is a `text` column; a real GitHub scope list is far shorter. */
export const E2E_CONNECTION_SEED_SCOPE_MAX_LENGTH = 255;

/**
 * The scope the seeded row claims when the caller names none.
 *
 * `repo` is not a preference: `GitFacadeService.getRequiredOAuthScopes('github')`
 * returns exactly `['repo']` (`packages/agent/src/facades/git.facade.ts:417-424`)
 * and `findUsableGitProviderAccount` looks the account up with
 * `requiredScopes: ['repo']`, so a row without it would answer
 * `connected: true` on the read route and still fail every fork, clone and pull
 * request as "no credentials". A fixture that seeded a row the platform cannot
 * use would be worse than no fixture at all.
 */
export const E2E_CONNECTION_SEED_DEFAULT_SCOPE = 'repo';

/**
 * One connection fixture: the token the lane's fake GitHub recognises, and
 * optionally the login and scope list to record beside it.
 */
export class E2eGitHubConnectionSeedDto {
    /**
     * The Git credential the run account should act as.
     *
     * In the PR lane this is the fake's seeded identity
     * (`apw-e2e-user-token` in `catalog-pr-lane.seed.json`), which is what makes
     * the fake attribute the fork, clone and push calls to `apw-e2e-user` —
     * the fact T15 asserts through `GET /_control/calls`.
     */
    @IsString()
    @MinLength(1)
    @MaxLength(E2E_CONNECTION_SEED_TOKEN_MAX_LENGTH)
    accessToken: string;

    /** The login to record beside the token; display only, never an identity. */
    @IsOptional()
    @IsString()
    @MaxLength(E2E_CONNECTION_SEED_USERNAME_MAX_LENGTH)
    username?: string;

    /** The granted scope list; defaults to `repo` (see the class doc). */
    @IsOptional()
    @IsString()
    @MaxLength(E2E_CONNECTION_SEED_SCOPE_MAX_LENGTH)
    @Matches(E2E_CONNECTION_SEED_SCOPE_PATTERN)
    scope?: string;
}
