import { Injectable, Logger, Optional } from '@nestjs/common';
import { organizationRequiresHttpsForCredentials } from '@ever-works/contracts';
import { OrganizationRepository } from '../database/repositories/organization.repository';
import { UserRepository } from '../database/repositories/user.repository';

/** Who a connection belongs to, as far as the organization setting is concerned. */
export interface McpCredentialTransportScope {
    userId: string;
    /** The connection's organization. `null` / absent = a tenant-wide connection. */
    organizationId?: string | null;
    /** The connection's tenant. Absent = the owner's tenant. */
    tenantId?: string | null;
}

/**
 * Thrown when the organization setting cannot be read. The caller refuses to
 * send credentials over plain http rather than guess the setting is off: a
 * safety control an organization turned on must never be skipped because a
 * lookup failed.
 */
export class McpCredentialTransportPolicyUnavailableError extends Error {
    constructor() {
        super('Organization connection settings could not be read.');
        this.name = 'McpCredentialTransportPolicyUnavailableError';
    }
}

/**
 * AW-15 — reads the organization setting "Require https for connection
 * credentials" (`organizations.connection_policy`) for one MCP connection.
 *
 * Consulted ONLY for a connection that would send literal credentials over
 * plain http — every other case is decided without a lookup — so it adds no
 * read to the common https path.
 *
 *   - A connection that belongs to an organization follows that
 *     organization's setting.
 *   - A tenant-wide connection (no organization) is inherited by agents in
 *     every organization of its tenant, so it follows the strictest one: the
 *     setting applies when ANY organization in the tenant has it on.
 *   - No organization repository bound in this runtime ⇒ no organization can
 *     have the setting, so it is off.
 *   - A lookup that fails throws `McpCredentialTransportPolicyUnavailableError`
 *     and the caller refuses; it never assumes "off".
 */
@Injectable()
export class McpCredentialTransportPolicyService {
    private readonly logger = new Logger(McpCredentialTransportPolicyService.name);

    constructor(
        @Optional() private readonly organizations?: OrganizationRepository,
        @Optional() private readonly users?: UserRepository,
    ) {}

    async requiresHttpsForCredentials(scope: McpCredentialTransportScope): Promise<boolean> {
        if (!this.organizations) return false;
        try {
            if (scope.organizationId) {
                const organization = await this.organizations.findById(scope.organizationId);
                return organizationRequiresHttpsForCredentials(organization?.connectionPolicy);
            }

            let tenantId = scope.tenantId ?? null;
            if (!tenantId && this.users) {
                tenantId = (await this.users.findById(scope.userId))?.tenantId ?? null;
            }
            if (!tenantId) return false;
            const organizations = await this.organizations.findByTenantId(tenantId);
            return organizations.some((organization) =>
                organizationRequiresHttpsForCredentials(organization.connectionPolicy),
            );
        } catch (err) {
            // Only the error class: a driver message is not trusted to be free
            // of connection details.
            this.logger.warn(
                `Could not read the organization connection setting (${
                    err instanceof Error ? err.name : 'unknown error'
                }); refusing credentials over plain http.`,
            );
            throw new McpCredentialTransportPolicyUnavailableError();
        }
    }
}
