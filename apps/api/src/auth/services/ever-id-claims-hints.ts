import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Organization, OrganizationMember, User } from '@ever-works/agent/entities';

/**
 * The optional reader of an Organization's link to an Ever organization.
 *
 * Unbound in this release: nothing in the platform stores such a link yet, so
 * the company-sign-in check below ships dormant and needs no auth change when a
 * module that stores links binds this token later.
 */
export const EVER_ID_ORG_LINK_READER = Symbol('EVER_ID_ORG_LINK_READER');

export interface EverIdOrgLink {
    /** The Ever organization the Works Organization is linked to. */
    everOrgId: string;
    /** Whether that Ever organization requires its members to use its company identity. */
    companySignInRequired: boolean;
}

export interface EverIdOrgLinkReader {
    findForOrganization(organizationId: string): Promise<EverIdOrgLink | null>;
}

/** What applying the hints decided. */
export interface EverIdClaimHintsOutcome {
    /** The Organization preselected as the person's landing scope, if any. */
    preselectedOrganizationId: string | null;
    /** `true` only when a bound link requires the company identity and this sign-in is not it. */
    refused: boolean;
}

/** The hint claims read, all optional (namespace `urn:ever:`). */
const ORGS = 'urn:ever:orgs';
const ORGS_FILTERED = 'urn:ever:orgs_filtered';
const IDENTITY_KIND = 'urn:ever:identity_kind';
const ENTERPRISE_ORG_ID = 'urn:ever:enterprise_org_id';
const CLAIMS_VERSION = 'urn:ever:claims_ver';
const SUPPORTED_CLAIMS_VERSION = 1;
const MAX_ORGS = 50;
const MAX_LINKS = 20;

/**
 * APW-12 (Ever ID) — optional organization hints carried in the verified ID
 * token, under the `urn:ever:` claim namespace.
 *
 * The rules, all of them conservative:
 *
 * - **Hints, never authority.** An absent, malformed or unknown-version claim
 *   set is ignored and the sign-in proceeds exactly as without it. Nothing here
 *   creates an Organization, a membership or a role, and nothing here calls any
 *   other service — the claims are read from the token the plugin already
 *   verified.
 * - **Preselect only what the person already belongs to.** When
 *   `urn:ever:orgs[].links[].product_org_id` names a Works Organization the
 *   account already owns or is a member of, and the Ever organization is not
 *   listed in `urn:ever:orgs_filtered`, that Organization becomes the account's
 *   landing scope (`users.lastScopeOrganizationId`).
 * - **Company sign-in check (dormant).** When an optional
 *   {@link EVER_ID_ORG_LINK_READER} is bound and reports that the preselected
 *   Organization's Ever organization requires its company identity, the sign-in
 *   is refused unless `urn:ever:identity_kind` is `enterprise` with the matching
 *   `urn:ever:enterprise_org_id`. No reader is bound in this release.
 */
@Injectable()
export class EverIdClaimHintsService {
    private readonly logger = new Logger(EverIdClaimHintsService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        @Optional()
        @Inject(EVER_ID_ORG_LINK_READER)
        private readonly orgLinks?: EverIdOrgLinkReader,
    ) {}

    /** Decide (without writing) what the hints say for this account. */
    async evaluate(
        userId: string,
        hints: Readonly<Record<string, unknown>> | undefined,
    ): Promise<EverIdClaimHintsOutcome> {
        const none: EverIdClaimHintsOutcome = { preselectedOrganizationId: null, refused: false };
        if (!hints || !isSupportedVersion(hints[CLAIMS_VERSION])) return none;

        const filtered = new Set(idsOf(hints[ORGS_FILTERED]));
        const candidates = worksOrganizationIds(hints[ORGS], filtered);
        if (candidates.length === 0) return none;

        for (const organizationId of candidates) {
            if (!(await this.belongsTo(userId, organizationId))) continue;
            if (this.orgLinks) {
                const link = await this.orgLinks
                    .findForOrganization(organizationId)
                    .catch(() => null);
                if (link?.companySignInRequired) {
                    const companyIdentity =
                        hints[IDENTITY_KIND] === 'enterprise' &&
                        hints[ENTERPRISE_ORG_ID] === link.everOrgId;
                    if (!companyIdentity) return { preselectedOrganizationId: null, refused: true };
                }
            }
            return { preselectedOrganizationId: organizationId, refused: false };
        }
        return none;
    }

    /** Write the preselected landing scope. Best-effort: a failure never fails a sign-in. */
    async applyPreselection(userId: string, organizationId: string): Promise<void> {
        try {
            await this.dataSource
                .getRepository(User)
                .update({ id: userId }, { lastScopeOrganizationId: organizationId });
        } catch (error) {
            this.logger.warn(
                `Could not preselect the landing organization: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /** Whether the account owns (through its Tenant) or is a member of the Organization. */
    private async belongsTo(userId: string, organizationId: string): Promise<boolean> {
        try {
            const organization = await this.dataSource
                .getRepository(Organization)
                .findOne({ where: { id: organizationId } });
            if (!organization) return false;
            const user = await this.dataSource
                .getRepository(User)
                .findOne({ where: { id: userId } });
            if (user?.tenantId && organization.tenantId === user.tenantId) return true;
            const member = await this.dataSource
                .getRepository(OrganizationMember)
                .findOne({ where: { organizationId, userId } });
            return !!member;
        } catch {
            return false;
        }
    }
}

function isSupportedVersion(value: unknown): boolean {
    return value === SUPPORTED_CLAIMS_VERSION;
}

function idsOf(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .slice(0, MAX_ORGS)
        .map((entry) =>
            entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : null,
        )
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** The Works Organization ids the unfiltered Ever organizations link to, in claim order. */
function worksOrganizationIds(value: unknown, filtered: ReadonlySet<string>): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const org of value.slice(0, MAX_ORGS)) {
        if (!org || typeof org !== 'object') continue;
        const { id, links } = org as { id?: unknown; links?: unknown };
        if (typeof id === 'string' && filtered.has(id)) continue;
        if (!Array.isArray(links)) continue;
        for (const link of links.slice(0, MAX_LINKS)) {
            const productOrgId =
                link && typeof link === 'object'
                    ? (link as { product_org_id?: unknown }).product_org_id
                    : null;
            if (
                typeof productOrgId === 'string' &&
                isUuid(productOrgId) &&
                !out.includes(productOrgId)
            ) {
                out.push(productOrgId);
            }
        }
    }
    return out;
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
