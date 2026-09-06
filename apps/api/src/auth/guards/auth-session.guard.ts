import { Injectable, ExecutionContext, UnauthorizedException, Inject } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ApiKeyService } from '../services/api-key.service';
import { UserRepository } from '@ever-works/agent/database';
import { FleetRunCredentialService } from '@ever-works/agent/fleet';
import { FLEET_RUN_TOKEN_PREFIX } from '@ever-works/contracts';
import type { AuthenticatedUser, FleetRunCredentialBinding } from '../types/auth.types';
import { AUTH_PROVIDER } from '../providers/auth-provider.constants';
import { AuthProvider } from '../providers/auth-provider.abstract';
import { toHeaders } from '../providers/request-headers';

const API_KEY_PREFIX = 'ew_live_';

/**
 * Self-build slice Z (EW-796) — the fleet-run MCP credential prefix.
 *
 * Handled in the SAME branch as `ew_live_`, and for the same reason:
 * a caller presenting a machine credential is asking for the machine
 * code path and must get a deterministic 401 rather than a silent
 * fall-through to cookies. Which validator runs is decided by the
 * prefix alone — a run token is never checked against personal keys and
 * a personal key is never checked against run bindings.
 */
const FLEET_RUN_KEY_PREFIX: string = FLEET_RUN_TOKEN_PREFIX;

/**
 * Per-request auth guard for the API. Wires two independent credential
 * paths to a single `request.user` and stays decoupled from the auth
 * library via {@link AuthProvider}.
 *
 * Precedence (important — order matters and is intentional):
 *   1. `@Public()` short-circuits to allow.
 *   2. **API key** (`x-api-key: ew_live_…` OR `Authorization: Bearer
 *      ew_live_…`) — if a value with the `ew_live_` prefix is present
 *      in either slot, this guard treats the request as an API-key
 *      request and **never falls through** to the provider path, even
 *      if the key is rejected. A bad API key returns 401 with
 *      "Invalid or expired API key" instead of trying cookies. This
 *      is deliberate: a client sending an API key is asking for the
 *      machine-credential code path and should get a deterministic
 *      error, not silent fallback to a different identity.
 *   3. **Provider session** — delegated to
 *      {@link AuthProvider.authenticate}. The provider returns `null`
 *      (NOT a throw) when no/invalid session is found so the guard
 *      reaches the final 401 rather than masking a misconfiguration.
 *
 * **Synthesised JWT-shaped claims for API keys.** API-key auth has no
 * real JWT, so this guard fabricates an `AuthenticatedUser` with
 * `iat = now()`, `iss = 'ever-works'`, `aud = 'ever-works'` so
 * downstream code (logging, observability, anything that reads
 * `request.user`) sees a consistent shape regardless of which path
 * authenticated. Treat `iat` on an API-key request as "guard
 * activation time", NOT as "user signed in at" — it advances on
 * every request.
 *
 * **Lazy DI of `ApiKeyService` + `UserRepository`** via `moduleRef`.
 * Both are resolved on the first API-key request rather than via
 * constructor injection. This avoids a circular-import bind at
 * module init (the auth module imports services that themselves
 * pull guards transitively). Switching to constructor injection
 * here is likely to reintroduce a circular dep — confirm with
 * `nest start` before changing.
 *
 * **API-key prefix is the discriminator.** Only `ew_live_…` and
 * `ew_run_…` are treated as machine credentials; any other
 * `Bearer …` token falls through to the provider (most providers
 * will then parse it as a JWT session). New key formats MUST keep a
 * prefix or extend the matcher in {@link extractApiKey}.
 *
 * **`ew_run_…` — fleet-run MCP credentials (self-build slice Z,
 * EW-796).** Minted per fleet job for the model running on a node,
 * validated by `FleetRunCredentialService` rather than
 * `ApiKeyService`, and narrower than a personal key on every axis:
 * it expires with the lease it was minted under, it dies when its
 * job settles or moves to another node, it is pinned to ONE
 * Organization (enforced by `SessionScopeGuard`), and it reaches
 * only the MCP tool surface (`isFleetRunTokenRouteAllowed`). The
 * resolved `request.user` is still the OWNER, so every ownership
 * check downstream is the one it always was; the extra binding
 * lands on `request.fleetRunCredential`.
 */
@Injectable()
export class AuthSessionGuard {
    private apiKeyService: ApiKeyService;
    private userRepository: UserRepository;
    private fleetRunCredentials: FleetRunCredentialService | undefined;

    constructor(
        private reflector: Reflector,
        private moduleRef: ModuleRef,
        @Inject(AUTH_PROVIDER)
        private readonly authProvider: AuthProvider,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (isPublic) {
            return true;
        }

        const request = context.switchToHttp().getRequest();
        const apiKey = this.extractApiKey(request);

        if (apiKey) {
            if (!this.apiKeyService) {
                this.apiKeyService = this.moduleRef.get(ApiKeyService, { strict: false });
            }
            if (!this.userRepository) {
                this.userRepository = this.moduleRef.get(UserRepository, { strict: false });
            }

            const keyRecord = apiKey.startsWith(FLEET_RUN_KEY_PREFIX)
                ? await this.authenticateFleetRunCredential(apiKey, request)
                : await this.apiKeyService.validateKey(apiKey);
            if (!keyRecord) {
                // ONE message for both kinds and every failure mode. A run
                // token that is expired, revoked, minted for another node,
                // bound to a settled job, or simply aimed at a route it may
                // not reach must be indistinguishable — otherwise the model
                // holding it can map the surface it is refused from.
                throw new UnauthorizedException('Invalid or expired API key');
            }

            const user = await this.userRepository.findById(keyRecord.userId);
            if (!user || !user.isActive) {
                throw new UnauthorizedException('User account is inactive');
            }

            const authenticatedUser: AuthenticatedUser = {
                userId: user.id,
                email: user.email,
                username: user.username,
                provider: user.registrationProvider,
                emailVerified: user.emailVerified,
                isActive: user.isActive,
                avatar: user.avatar || null,
                iat: Math.floor(Date.now() / 1000),
                iss: 'ever-works',
                aud: 'ever-works',
            };

            request.user = authenticatedUser;
            return true;
        }

        const providerUser = await this.authProvider.authenticate(toHeaders(request.headers || {}));
        if (providerUser) {
            request.user = providerUser;
            return true;
        }

        throw new UnauthorizedException();
    }

    /**
     * Validate an `ew_run_…` fleet-run credential and, on success, stash
     * the run binding on the request for `SessionScopeGuard`.
     *
     * Returns the same `{ userId }` shape the personal-key path returns,
     * so the caller's synthesised `AuthenticatedUser` block is shared: a
     * run acts as the OWNER, with the owner's own ownership checks, and
     * differs only in the scope pin and the route allowlist — both
     * enforced inside `FleetRunCredentialService.authenticate`.
     *
     * Resolved lazily through `moduleRef` for exactly the reason
     * `ApiKeyService` is: constructor injection here reintroduces the
     * circular module bind this guard was written to avoid.
     */
    private async authenticateFleetRunCredential(
        rawToken: string,
        request: any,
    ): Promise<{ userId: string } | null> {
        if (!this.fleetRunCredentials) {
            try {
                this.fleetRunCredentials = this.moduleRef.get(FleetRunCredentialService, {
                    strict: false,
                });
            } catch {
                // An install without the fleet module bound has no run
                // credentials at all, so the token cannot be valid. Fail
                // closed and answer the same 401 as any other bad key.
                return null;
            }
        }
        const binding = await this.fleetRunCredentials.authenticate(rawToken, {
            method: typeof request.method === 'string' ? request.method : '',
            // Express exposes the path without the query string on `path`;
            // `url` is the fallback and is normalised by the allowlist.
            path:
                typeof request.path === 'string'
                    ? request.path
                    : typeof request.url === 'string'
                      ? request.url
                      : '',
        });
        if (!binding) return null;

        const stash: FleetRunCredentialBinding = {
            jobId: binding.jobId,
            nodeId: binding.nodeId,
            runId: binding.runId,
            organizationId: binding.organizationId,
        };
        request.fleetRunCredential = stash;
        return { userId: binding.userId };
    }

    private extractApiKey(request: any): string | null {
        const headerKey = request.headers?.['x-api-key'];
        if (headerKey && typeof headerKey === 'string' && isMachineCredential(headerKey)) {
            return headerKey;
        }

        const authHeader = request.headers?.authorization;
        if (authHeader && typeof authHeader === 'string') {
            const [scheme, token] = authHeader.split(' ');
            if (scheme === 'Bearer' && token && isMachineCredential(token)) {
                return token;
            }
        }

        return null;
    }
}

/**
 * The two machine-credential prefixes this guard owns. Anything else —
 * including a random opaque bearer — still falls through to the auth
 * provider exactly as it always has.
 */
function isMachineCredential(value: string): boolean {
    return value.startsWith(API_KEY_PREFIX) || value.startsWith(FLEET_RUN_KEY_PREFIX);
}
