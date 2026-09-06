import { ConflictException, Injectable, Logger } from '@nestjs/common';
import {
    IngestInstallBindingRepository,
    type RecordIngestBindingData,
} from '@ever-works/agent/ingest';

/** Binding-table namespace for Sentry installations. */
export const SENTRY_BINDING_PROVIDER = 'sentry';

/**
 * `ingest_install_bindings.pluginId` label for Sentry rows. There is no
 * per-user Sentry plugin (the secret is platform-level, see below), so
 * this is a label for the settings UI, not a plugin the binding resolves
 * through.
 */
export const SENTRY_PLUGIN_ID = 'sentry';

/** Sentry installation uuids are RFC 4122 uuids (Sentry issues v4). */
const INSTALLATION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Canonical (lower-cased) installation uuid, or undefined when malformed. */
export function normalizeSentryInstallationUuid(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const lowered = value.trim().toLowerCase();
    return INSTALLATION_UUID_RE.test(lowered) ? lowered : undefined;
}

/** `ingest_install_bindings.externalWorkspaceId` for one installation. */
export function sentryInstallationKey(installationUuid: string): string {
    return `installation:${installationUuid}`;
}

/** The platform user a Sentry installation's deliveries are attributed to. */
export interface SentryInstallationOwner {
    readonly userId: string;
    readonly installationUuid: string;
}

/** Settings-surface view of one claimed installation. */
export interface SentryInstallationBindingView {
    readonly installationUuid: string;
    readonly label: string | null;
    readonly createdAt: Date;
}

/**
 * Sentry installation → platform user bindings (self-build program note
 * §6, R23).
 *
 * Sentry signs every integration webhook with the integration's CLIENT
 * SECRET — one platform-level secret that cannot tell two installations
 * (two customers' Sentry orgs) apart. So, unlike GitHub / Jira, a
 * verified delivery proves only that it came from Sentry, never WHOSE it
 * is, and the owner cannot be learned from the delivery itself. The
 * analog of `github_app_installations.createdByUserId` here is an
 * AUTHENTICATED CLAIM: the owner reads the installation uuid off the
 * Sentry integration page and posts it to `POST /api/ingest/sentry/bindings`.
 *
 * Rules:
 *   * first claim wins — a uuid bound to another account is a 409, never
 *     silently re-pointed (that would let anyone who learns a uuid steal
 *     a stream of incidents);
 *   * re-claiming your own uuid is idempotent (label refresh only);
 *   * an unbound installation's deliveries are a 200 no-op at the
 *     receiver — nothing is filed for a stream nobody owns;
 *   * a signed `installation.deleted` delivery removes the binding.
 *
 * Which Organization / Work an incident lands in is decided by the
 * binding's user and that user's own Work claims — never by the payload.
 */
@Injectable()
export class SentryInstallBindingService {
    private readonly logger = new Logger(SentryInstallBindingService.name);

    constructor(private readonly bindings: IngestInstallBindingRepository) {}

    /** The owner of one installation, or null when nobody has claimed it. */
    async resolveOwner(installationUuid: unknown): Promise<SentryInstallationOwner | null> {
        const uuid = normalizeSentryInstallationUuid(installationUuid);
        if (!uuid) return null;
        const bound = await this.bindings.findByWorkspace(
            SENTRY_BINDING_PROVIDER,
            sentryInstallationKey(uuid),
        );
        return bound ? { userId: bound.userId, installationUuid: uuid } : null;
    }

    /**
     * Claim an installation for the authenticated user. First claim
     * wins; the same user may re-claim (idempotent, label refresh);
     * another user gets a 409.
     */
    async claim(
        userId: string,
        installationUuid: string,
        label?: string | null,
    ): Promise<SentryInstallationBindingView> {
        const uuid = normalizeSentryInstallationUuid(installationUuid);
        if (!uuid) {
            // The DTO already rejects malformed ids; this is the service-level floor.
            throw new ConflictException('Malformed Sentry installation uuid');
        }
        const key = sentryInstallationKey(uuid);

        const existing = await this.bindings.findByWorkspace(SENTRY_BINDING_PROVIDER, key);
        if (existing && existing.userId !== userId) {
            throw new ConflictException(
                'This Sentry installation is already claimed by another account',
            );
        }

        const write: RecordIngestBindingData = {
            provider: SENTRY_BINDING_PROVIDER,
            externalWorkspaceId: key,
            userId,
            pluginId: SENTRY_PLUGIN_ID,
            externalWorkspaceName: label?.trim() || null,
        };
        // Re-claiming a row we already own is a label refresh, and
        // `record` re-pointing it to its existing owner is a no-op. A
        // FIRST claim must go through the insert-only path instead:
        // `record` would happily overwrite a row that a concurrent claim
        // slipped in between the check above and this write, which is
        // exactly the "anyone who learns a uuid steals the stream" theft
        // the first-claim rule exists to prevent.
        const recorded = existing
            ? await this.bindings.record(write)
            : await this.bindings.recordIfAbsent(write);
        if (!recorded) {
            throw new Error('Failed to record the Sentry installation binding');
        }
        // A concurrent first claim may have won the race; the repository
        // hands back the winner, so re-check whose row this is.
        if (recorded.userId !== userId) {
            throw new ConflictException(
                'This Sentry installation is already claimed by another account',
            );
        }
        this.logger.log(`Sentry installation ${uuid} claimed by user ${userId}`);
        return this.viewOf(recorded);
    }

    /** Every installation the user has claimed, oldest first. */
    async listForUser(userId: string): Promise<SentryInstallationBindingView[]> {
        const rows = await this.bindings.findByUser(userId);
        return rows
            .filter((row) => row.provider === SENTRY_BINDING_PROVIDER)
            .map((row) => this.viewOf(row));
    }

    /**
     * Release an installation the user owns. False when there is nothing
     * of theirs to release — the same answer whether the uuid is unknown
     * or belongs to somebody else, so existence never leaks.
     */
    async unbind(userId: string, installationUuid: string): Promise<boolean> {
        const uuid = normalizeSentryInstallationUuid(installationUuid);
        if (!uuid) return false;
        const key = sentryInstallationKey(uuid);
        const existing = await this.bindings.findByWorkspace(SENTRY_BINDING_PROVIDER, key);
        if (!existing || existing.userId !== userId) return false;
        return this.bindings.remove(SENTRY_BINDING_PROVIDER, key);
    }

    /**
     * Sentry told us (in a SIGNED `installation` delivery) that the
     * installation is gone; drop the binding so a later re-install under
     * the same uuid cannot inherit a stale owner.
     */
    async onInstallationDeleted(installationUuid: unknown): Promise<boolean> {
        const uuid = normalizeSentryInstallationUuid(installationUuid);
        if (!uuid) return false;
        const removed = await this.bindings.remove(
            SENTRY_BINDING_PROVIDER,
            sentryInstallationKey(uuid),
        );
        if (removed) {
            this.logger.log(`Sentry installation ${uuid} deleted upstream; binding removed`);
        }
        return removed;
    }

    private viewOf(row: {
        externalWorkspaceId: string;
        externalWorkspaceName?: string | null;
        createdAt: Date;
    }): SentryInstallationBindingView {
        return {
            installationUuid: row.externalWorkspaceId.replace(/^installation:/, ''),
            label: row.externalWorkspaceName ?? null,
            createdAt: row.createdAt,
        };
    }
}
