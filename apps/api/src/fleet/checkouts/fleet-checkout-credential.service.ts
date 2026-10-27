import { Injectable, Logger } from '@nestjs/common';
import { config } from '@ever-works/agent/config';
import { FleetCheckoutService, type FleetCheckoutCredentialScope } from '@ever-works/agent/fleet';
import { requestGitHubAppInstallationAccessTokenDetails } from '@ever-works/agent/utils';
import {
    FLEET_PUSH_CREDENTIAL_MINT_FAILED_REASON,
    FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON,
    FLEET_PUSH_CREDENTIAL_USERNAME,
    fleetPushRemoteRepositoryId,
    type FleetCheckoutCredentialAccess,
    type FleetCheckoutCredentialResponse,
} from '@ever-works/contracts';
import { FleetPushCredentialService } from '../fleet-push-credential.service';

/** A refusal the node can report: a STABLE machine token, never an installation id or a GitHub body. */
export class FleetCheckoutCredentialRefusal extends Error {
    constructor(readonly reason: string) {
        super(reason);
        this.name = 'FleetCheckoutCredentialRefusal';
    }
}

function appCredentials(): { appId: string; privateKey: string } | null {
    const appId = config.githubApp.getAppId();
    const privateKey = config.githubApp.getPrivateKey();
    if (!appId || !privateKey) return null;
    return { appId, privateKey };
}

/**
 * Checkouts on computers (FL-14 P2, spec FR-17) — does a GitHub App
 * installation of this person cover a repository? Bound as
 * `FLEET_CHECKOUT_CREDENTIAL_SCOPE` so `FleetCheckoutService.create` knows
 * whether a clone gets the scoped credential or goes anonymous. Platform
 * state only (the push-credential scope resolver: the installation snapshot,
 * ownership-filtered, host-checked) — no GitHub call. Depends on nothing of
 * the checkout service, so there is no provider cycle.
 */
@Injectable()
export class FleetCheckoutCredentialScopeAdapter implements FleetCheckoutCredentialScope {
    constructor(private readonly push: FleetPushCredentialService) {}

    async covers(userId: string, remoteUrl: string): Promise<boolean> {
        const repositoryId = fleetPushRemoteRepositoryId(remoteUrl);
        if (!repositoryId) return false;
        const scope = await this.push.describeScope(userId, [{ repositoryId, repoUrl: remoteUrl }]);
        return scope.ok;
    }
}

/**
 * Checkouts on computers (FL-14 P2, spec FR-17, FR-22, U8) — the platform half
 * of `POST /api/fleet/checkouts/:id/credential`: a GitHub App installation
 * token for ONE repository, minted for one operation on a checkout Ever Works
 * created.
 *
 * The rules, as the Task pool's push credential keeps them:
 *
 *  - **who may ask** — the node the checkout is on, authenticated by its node
 *    credential (the guard), and only while an operation that needs it runs
 *    (`FleetCheckoutService.authorizeCredential`: `write` only during a push;
 *    never for a discovered checkout, FR-23);
 *  - **what it covers** — the repository the ROW's remote names, resolved
 *    against the owner's installation snapshot (never a name the node sent),
 *    `contents: read` or `contents: write` and nothing else (never
 *    `workflows`);
 *  - **nothing is stored or logged** — the token exists in this process for
 *    one response; the node revokes it when the operation ends.
 */
@Injectable()
export class FleetCheckoutCredentialService {
    private readonly logger = new Logger(FleetCheckoutCredentialService.name);

    constructor(
        private readonly checkouts: FleetCheckoutService,
        private readonly push: FleetPushCredentialService,
    ) {}

    async mint(
        nodeId: string,
        checkoutId: string,
        access: FleetCheckoutCredentialAccess,
    ): Promise<FleetCheckoutCredentialResponse> {
        let grant: { userId: string; remoteUrl: string };
        try {
            grant = await this.checkouts.authorizeCredential(nodeId, checkoutId, access);
        } catch (error) {
            const reason = error instanceof Error ? error.message : 'refused';
            this.logger.warn(
                `Checkout ${checkoutId}: scoped credential refused for node ${nodeId} — ${reason}`,
            );
            throw new FleetCheckoutCredentialRefusal(reason);
        }
        const repositoryId = fleetPushRemoteRepositoryId(grant.remoteUrl);
        if (!repositoryId) throw new FleetCheckoutCredentialRefusal('not-a-github-repository');
        const scope = await this.push.describeScope(grant.userId, [
            { repositoryId, repoUrl: grant.remoteUrl },
        ]);
        if (!scope.ok) {
            this.logger.warn(
                `Checkout ${checkoutId}: no installation covers its repository — ${scope.reason}`,
            );
            throw new FleetCheckoutCredentialRefusal(scope.reason);
        }
        const credentials = appCredentials();
        if (!credentials)
            throw new FleetCheckoutCredentialRefusal(FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON);
        let minted: { token: string; expiresAt: string | null };
        try {
            minted = await requestGitHubAppInstallationAccessTokenDetails(
                scope.installationId,
                credentials,
                {
                    repositoryIds: scope.repositoryIds,
                    // The ONE permission the operation needs. Never `workflows`.
                    permissions: { contents: access === 'write' ? 'write' : 'read' },
                },
            );
        } catch (error) {
            this.logger.error(
                `Checkout ${checkoutId}: scoped credential mint failed (${
                    error instanceof Error ? error.name : 'unknown error'
                })`,
            );
            throw new FleetCheckoutCredentialRefusal(FLEET_PUSH_CREDENTIAL_MINT_FAILED_REASON);
        }
        // The audit line: checkout, node, repository, access. Never the token.
        this.logger.log(
            `Checkout ${checkoutId}: scoped ${access} credential minted for node ${nodeId} covering ${scope.repositories.join(', ')}`,
        );
        return {
            token: minted.token,
            username: FLEET_PUSH_CREDENTIAL_USERNAME,
            expiresAt: minted.expiresAt ?? new Date(Date.now() + 55 * 60_000).toISOString(),
            repository: scope.repositories[0] ?? repositoryId,
            access,
        };
    }
}
