import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/**
 * Per-workspace / per-installation binding for INBOUND event receivers.
 *
 * Problem it fixes: both `SlackChatBridgeService` and
 * `GitHubPrReviewBridgeService` used to resolve "the oldest enabled
 * install platform-wide" and attribute EVERY inbound delivery to that one
 * platform user. In a hosted multi-tenant deployment that is a
 * data-isolation defect, not a limitation: a second customer's Slack
 * workspace or GitHub repository would have its messages, diffs and AI
 * replies executed under — and billed to — the first customer's account.
 *
 * The fix binds each external workspace/installation identity carried on
 * the webhook to exactly one platform user:
 *
 *   * Slack    — `team_id` (plus `enterprise_id` when the delivery
 *                carries one, for Enterprise Grid).
 *   * GitHub   — the App `installation.id` when present, otherwise the
 *                repository owner login. Both are stored in
 *                `externalWorkspaceId` under a disambiguating prefix
 *                (`installation:123` / `owner:acme`) so the two
 *                namespaces can never collide.
 *
 * ## Why a table rather than a plugin-settings field
 *
 *  1. **Cardinality.** One platform user may legitimately own several
 *     Slack workspaces or GitHub installations. Plugin settings are a
 *     single row per (user, plugin), so a scalar `teamId` field cannot
 *     express the relation without inventing an array-in-JSON.
 *  2. **Direction of the lookup.** Resolution runs workspace → user, the
 *     REVERSE of how settings are keyed. Over settings, every inbound
 *     webhook would have to load and DECRYPT the secret settings of every
 *     install just to find the owner — O(installs) decryptions per
 *     request on a public, unauthenticated endpoint. Here it is one
 *     indexed row.
 *  3. **Trust.** Plugin settings are user-editable, so a user could type
 *     another tenant's `team_id` into their own settings and hijack that
 *     tenant's events. Rows in this table are written by the SERVER only,
 *     and only after a delivery has passed signature verification — the
 *     binding is a record of proven ownership, never a user claim.
 *
 * Rows are additive and self-healing: a deployment that predates this
 * table keeps working through the single-install fallback in the bridges,
 * which records the binding on the first signature-verified delivery.
 *
 * NOTE: also registered in `database/_entities-inventory.ts` — this repo
 * has no `autoLoadEntities`, so a forFeature'd-but-unregistered entity
 * throws EntityMetadataNotFoundError on first query.
 */

/**
 * Inbound receiver this binding belongs to.
 *
 *   * `jira`   — Jira Cloud webhooks, keyed `site:<host>`;
 *   * `sentry` — Sentry integration webhooks, keyed
 *                `installation:<uuid>`; written by an authenticated
 *                claim rather than by a signature-verified delivery
 *                (Sentry signs with a platform-level client secret that
 *                cannot tell installations apart).
 *
 * Type-only widening: the column is an unconstrained varchar(32), so no
 * schema change accompanies a new provider.
 */
export type IngestInstallProvider = 'slack' | 'github' | 'jira' | 'sentry';

@Entity({ name: 'ingest_install_bindings' })
@Index('idx_ingest_install_bindings_workspace', ['provider', 'externalWorkspaceId'], {
    unique: true,
})
@Index('idx_ingest_install_bindings_user', ['userId'])
export class IngestInstallBinding {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /**
     * Receiver namespace. Deliberately a varchar (not an enum) so a new
     * inbound surface ships without a schema change — same convention as
     * `fleet_nodes.kind`.
     */
    @Column({ type: 'varchar', length: 32 })
    provider: string;

    /**
     * The external workspace / installation identity carried on the
     * webhook. Slack: the raw `team_id`. GitHub: `installation:<id>` or
     * `owner:<login>`. Unique per provider — one workspace has exactly one
     * owning platform user.
     */
    @Column({ type: 'varchar', length: 200 })
    externalWorkspaceId: string;

    /**
     * Slack `enterprise_id` when the delivery carries one (Enterprise
     * Grid). NULL for ordinary workspaces and for GitHub. When a stored
     * value is present it must match the incoming delivery, otherwise the
     * binding does NOT apply and the receiver refuses rather than guesses.
     */
    @Column({ type: 'varchar', length: 200, nullable: true })
    externalEnterpriseId?: string | null;

    /** Platform user every event from this workspace is attributed to. */
    @Column({ type: 'uuid' })
    userId: string;

    /** Plugin install the binding resolves through ('slack-connector' / 'github'). */
    @Column({ type: 'varchar', length: 64 })
    pluginId: string;

    /** Human-readable workspace/repo-owner label, for the settings UI. */
    @Column({ type: 'varchar', length: 200, nullable: true })
    externalWorkspaceName?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
