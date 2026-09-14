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
 *   - The setting defaults to OFF, so a value that cannot be read (a failed
 *     query, a missing organization row, a stored value that does not parse)
 *     resolves to that default: a literal-header http connection keeps
 *     working exactly as it did before the setting existed. A failed read is
 *     logged with the organization (or tenant) id — never a header value or
 *     a URL. `{{cred.key}}` references are refused over plain http before
 *     this service is ever asked, so this default never reaches them.
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

        if (scope.organizationId) {
            try {
                const organization = await this.organizations.findById(scope.organizationId);
                // A missing row or an unparseable stored value is "not on".
                return organizationRequiresHttpsForCredentials(organization?.connectionPolicy);
            } catch (err) {
                this.logReadFailure(`organization ${scope.organizationId}`, err);
                return false;
            }
        }

        let tenantId = scope.tenantId ?? null;
        try {
            if (!tenantId && this.users) {
                tenantId = (await this.users.findById(scope.userId))?.tenantId ?? null;
            }
            if (!tenantId) return false;
            const organizations = await this.organizations.findByTenantId(tenantId);
            return organizations.some((organization) =>
                organizationRequiresHttpsForCredentials(organization.connectionPolicy),
            );
        } catch (err) {
            this.logReadFailure(
                tenantId ? `organizations of tenant ${tenantId}` : `tenant of user ${scope.userId}`,
                err,
            );
            return false;
        }
    }

    private logReadFailure(subject: string, err: unknown): void {
        // Ids and the error class only: a driver message is not trusted to be
        // free of connection details.
        this.logger.warn(
            `Could not read "Require https for connection credentials" for ${subject} (${
                err instanceof Error ? err.name : 'unknown error'
            }); using the default (off).`,
        );
    }
}
