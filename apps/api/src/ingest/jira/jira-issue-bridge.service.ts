import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { IngestedEventEnvelope } from '@ever-works/contracts';
import {
    EventIngestService,
    IngestInstallBindingRepository,
    type IngestResult,
} from '@ever-works/agent/ingest';
import { PluginSettingsService, UserPluginRepository } from '@ever-works/agent/plugins';
import type { IngestBindingMatch, IngestBindingResolution } from '../install-binding.types';
import {
    INGESTED_EVENT_ACTOR_MAX_CHARS,
    INGESTED_EVENT_SOURCE_EVENT_ID_MAX_CHARS,
    INGESTED_EVENT_SUBJECT_EXTERNAL_ID_MAX_CHARS,
    INGESTED_EVENT_TEXT_MAX_CHARS,
    INGESTED_EVENT_TITLE_MAX_CHARS,
    capped,
    httpsUrl,
    isoOrNow,
    nonEmpty,
} from '../ingest-envelope.util';

/** The plugin whose installs own Jira deliveries. */
export const JIRA_CONNECTOR_PLUGIN_ID = 'jira-connector';

/** Binding-table namespace for Jira Cloud sites. */
export const JIRA_BINDING_PROVIDER = 'jira';

/** The ingested-event kind for issue activity — SAME as the pull path. */
export const JIRA_ISSUE_EVENT_KIND = 'jira.issue';

/** `webhookEvent` values the bridge turns into `jira.issue` envelopes. */
export const JIRA_ISSUE_WEBHOOK_EVENTS: readonly string[] = [
    'jira:issue_created',
    'jira:issue_updated',
    'jira:issue_deleted',
];

/** How the issue changed — `transitioned` is an `updated` whose changelog moved `status`. */
export type JiraIssueChangeType = 'created' | 'updated' | 'transitioned' | 'deleted';

/**
 * Private / loopback hosts a Jira "site" must never resolve to — a local
 * twin of the connector plugin's guard (the API never imports a plugin
 * package). Syntactic only: obvious loopback / link-local / RFC-1918
 * literals are rejected outright, and only `https:` is allowed.
 */
const PRIVATE_HOST_PATTERNS: readonly RegExp[] = [
    /^localhost$/i,
    /^127(?:\.\d{1,3}){3}$/,
    /^0\.0\.0\.0$/,
    /^10(?:\.\d{1,3}){3}$/,
    /^192\.168(?:\.\d{1,3}){2}$/,
    /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/,
    /^169\.254(?:\.\d{1,3}){2}$/,
    /^\[?::1\]?$/,
    /\.local$/i,
    /\.internal$/i,
];

/** Lower-cased https host out of a site URL / API self-link, or undefined. */
export function jiraSiteHost(value: unknown): string | undefined {
    const raw = nonEmpty(value);
    if (!raw) return undefined;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return undefined;
    }
    if (url.protocol !== 'https:') return undefined;
    if (url.username.length > 0 || url.password.length > 0) return undefined;
    const host = url.hostname.toLowerCase();
    if (host.length === 0) return undefined;
    if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) return undefined;
    return host;
}

/**
 * The external site identity a Jira delivery carries, as binding keys.
 * One key today — `site:<host>` — kept as an ordered list like the
 * GitHub twin so a more specific key (a cloud id) can be prepended later
 * without touching the resolver.
 */
export interface JiraSiteRef {
    readonly keys: readonly string[];
    readonly host: string;
    /** Human-readable label persisted alongside the binding. */
    readonly label?: string;
}

/** Per-site binding: the platform user that OWNS the Jira site a delivery came from. */
export interface JiraEventsBinding {
    readonly userId: string;
    readonly webhookSecret: string;
    /** Normalized site host from the install's `baseUrl`, when configured. */
    readonly siteHost?: string;
    readonly matchedBy: IngestBindingMatch;
    readonly workspace?: JiraSiteRef;
}

/** Inputs the receiver passes when resolving a delivery to its owner. */
export interface JiraBindingLookup {
    readonly workspace?: JiraSiteRef;
    /** Verifies the raw delivery against a candidate's webhook secret. */
    readonly verifySignature?: (webhookSecret: string) => boolean;
}

/** Atlassian Document Format node (v3 rich text). */
interface AdfNode {
    type?: string;
    text?: string;
    content?: AdfNode[];
}

/** The subset of a Jira Cloud webhook body the bridge consumes. */
export interface JiraWebhookBody {
    timestamp?: number | string;
    webhookEvent?: string;
    issue_event_type_name?: string;
    user?: {
        self?: string;
        accountId?: string;
        displayName?: string;
    };
    issue?: {
        id?: string | number;
        key?: string;
        self?: string;
        fields?: {
            summary?: string;
            description?: unknown;
            created?: string;
            updated?: string;
            status?: { name?: string };
            issuetype?: { name?: string };
            priority?: { name?: string };
            project?: { id?: string | number; key?: string; name?: string };
            assignee?: { displayName?: string; accountId?: string } | null;
            reporter?: { displayName?: string; accountId?: string } | null;
            labels?: string[];
        };
    };
    changelog?: {
        id?: string;
        items?: Array<{
            field?: string;
            fieldtype?: string;
            fieldId?: string;
            from?: string | null;
            fromString?: string | null;
            to?: string | null;
            toString?: string | null;
        }>;
    };
    comment?: { self?: string };
}

/**
 * Read the site identity off a delivery body (from the API self-links
 * Jira stamps on every issue / user / comment). NOT yet
 * signature-verified, and that is safe: the value only SELECTS which
 * install's webhook secret to verify against — a forged host picks a
 * secret that fails the HMAC and the delivery is rejected.
 */
export function extractJiraSiteRef(body: JiraWebhookBody | undefined): JiraSiteRef | undefined {
    const host =
        jiraSiteHost(body?.issue?.self) ??
        jiraSiteHost(body?.user?.self) ??
        jiraSiteHost(body?.comment?.self);
    if (!host) return undefined;
    return { keys: [`site:${host}`], host, label: host };
}

/**
 * ADF document → plain text (local twin of the connector's helper).
 * Jira Cloud webhooks carry `description` as a v2 wiki string or a v3
 * ADF tree depending on the site; both must flatten.
 */
export function jiraTextOf(value: unknown): string {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    const walk = (node: AdfNode, depth: number): string => {
        if (depth > 64) return '';
        if (typeof node.text === 'string') return node.text;
        const children = Array.isArray(node.content)
            ? node.content.map((child) => walk(child, depth + 1))
            : [];
        const isBlock =
            node.type === 'paragraph' || node.type === 'heading' || node.type === 'listItem';
        return isBlock ? `${children.join('')}\n` : children.join('');
    };
    return walk(value as AdfNode, 0)
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Jira stamps `+0000`-style offsets (`2026-09-01T10:00:00.000+0000`),
 * which the ISO parser does not accept; widen to `+00:00` first.
 */
function jiraIso(value: string | number | null | undefined): string {
    if (typeof value === 'string') {
        return isoOrNow(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    }
    return isoOrNow(value);
}

/**
 * Jira Cloud inbound bridge (self-build program note §6, R2) — the
 * connector's first INBOUND surface.
 *
 * The `jira-connector` plugin is outbound + poll only; nothing in the
 * platform could receive a Jira webhook, so a created / transitioned
 * issue reached the spine only on the next pull sweep and never as a
 * push. This service mirrors the GitHub PR-review bridge shape:
 *
 * 1. `resolveBinding()` — the PER-SITE binding plus the webhook secret
 *    the receiver verifies deliveries with. Each `jira-connector`
 *    install carries its own `baseUrl` + `webhookSecret`, so a delivery
 *    is attributed to the platform user whose install names the site it
 *    came from — never to "the oldest install". Order: exact binding →
 *    unique site-host match → single install (legacy) → unique
 *    signature match → refuse. Fail-closed: no configured install → the
 *    endpoint 401s; an unknown / ambiguous site is refused as a clean
 *    no-op.
 * 2. `normalize()` — `jira:issue_created` / `jira:issue_updated` /
 *    `jira:issue_deleted` into `jira.issue` envelopes with the SAME
 *    `source`, `kind`, `subject` and `sourceEventId` shape the pull path
 *    emits, so a webhook and a later sweep of the same change dedupe
 *    against each other in the spine.
 * 3. `handleEvent()` — dedupe-inserts through the event-ingest spine,
 *    where the trigger matcher and the triage filer pick it up.
 *
 * The receiver never imports the plugin package (connector plugins are
 * dynamically distributed) — the helpers it needs live here.
 */
@Injectable()
export class JiraIssueBridgeService {
    private readonly logger = new Logger(JiraIssueBridgeService.name);

    constructor(
        private readonly userPluginRepository: UserPluginRepository,
        private readonly pluginSettingsService: PluginSettingsService,
        private readonly eventIngestService: EventIngestService,
        private readonly installBindings: IngestInstallBindingRepository,
    ) {}

    /** Resolve one delivery to the platform user that OWNS the Jira site it came from. */
    async resolveBinding(
        lookup: JiraBindingLookup = {},
    ): Promise<IngestBindingResolution<JiraEventsBinding>> {
        const candidates = await this.loadCandidates();
        if (candidates.length === 0) {
            return { status: 'not-configured' };
        }

        const workspace = lookup.workspace;
        const label = workspace?.keys[0] ?? 'unknown site';

        // 1. Exact binding.
        for (const key of workspace?.keys ?? []) {
            const bound = await this.installBindings
                .findByWorkspace(JIRA_BINDING_PROVIDER, key)
                .catch(() => null);
            if (!bound) continue;
            const owner = candidates.find((c) => c.userId === bound.userId);
            if (owner) {
                return {
                    status: 'resolved',
                    binding: { ...owner, matchedBy: 'binding', workspace },
                };
            }
            // The bound install was removed or lost its webhook secret.
            // Attributing its events to ANOTHER user is exactly the defect
            // the binding model exists to prevent, so refuse instead.
            this.logger.warn(
                `Refusing Jira delivery for ${key}: the bound install is disabled or unconfigured`,
            );
            return { status: 'unresolved', reason: 'bound-install-unavailable' };
        }

        // 2. Site-host match — each install is configured with the site
        //    it talks to, so a UNIQUE host match selects it. Several
        //    installs on one site (two teammates) fall through to the
        //    signature proof below.
        if (workspace?.host) {
            const onSite = candidates.filter((c) => c.siteHost === workspace.host);
            if (onSite.length === 1) {
                return {
                    status: 'resolved',
                    binding: { ...onSite[0], matchedBy: 'site-match', workspace },
                };
            }
        }

        // 3. Single-install legacy path — nothing to disambiguate.
        if (candidates.length === 1) {
            this.logger.warn(
                `Jira delivery for ${label} has no site binding; attributing it to the single configured install (legacy path)`,
            );
            return {
                status: 'resolved',
                binding: {
                    ...candidates[0],
                    matchedBy: 'single-install',
                    ...(workspace ? { workspace } : {}),
                },
            };
        }

        // 4. Signature proof — each install configures its OWN webhook
        //    secret, so a unique HMAC match is evidence of ownership.
        if (lookup.verifySignature) {
            const matches = candidates.filter((c) => lookup.verifySignature!(c.webhookSecret));
            if (matches.length === 1) {
                return {
                    status: 'resolved',
                    binding: {
                        ...matches[0],
                        matchedBy: 'signature',
                        ...(workspace ? { workspace } : {}),
                    },
                };
            }
            if (matches.length > 1) {
                this.logger.warn(
                    `Refusing Jira delivery for ${label}: ${matches.length} installs share a webhook secret and nothing distinguishes them`,
                );
                return { status: 'unresolved', reason: 'ambiguous-install' };
            }
        }

        this.logger.warn(`Refusing Jira delivery for ${label}: no install is bound to this site`);
        return { status: 'unresolved', reason: 'unknown-workspace' };
    }

    /**
     * Persist the site→user binding after a delivery has passed
     * signature verification. Best-effort: a failure here must never
     * break a webhook that has already been verified and handled.
     */
    async recordBinding(binding: JiraEventsBinding): Promise<void> {
        const key = binding.workspace?.keys[0];
        if (binding.matchedBy === 'binding' || !key) return;
        try {
            await this.installBindings.record({
                provider: JIRA_BINDING_PROVIDER,
                externalWorkspaceId: key,
                userId: binding.userId,
                pluginId: JIRA_CONNECTOR_PLUGIN_ID,
                externalWorkspaceName: binding.workspace?.label ?? null,
            });
        } catch (error) {
            this.logger.warn(
                `Failed to record Jira site binding for ${key}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Enabled jira-connector installs whose resolved settings carry a
     * webhook secret, oldest first (stable ordering keeps the
     * single-install path deterministic).
     */
    private async loadCandidates(): Promise<
        Array<{ userId: string; webhookSecret: string; siteHost?: string }>
    > {
        const installs = await this.userPluginRepository.findByPlugin(JIRA_CONNECTOR_PLUGIN_ID);
        const enabled = installs
            .filter((row) => row.enabled)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        const candidates: Array<{ userId: string; webhookSecret: string; siteHost?: string }> = [];
        for (const row of enabled) {
            const settings = await this.pluginSettingsService.getSettings(
                JIRA_CONNECTOR_PLUGIN_ID,
                { userId: row.userId, includeSecrets: true },
            );
            const webhookSecret = settings?.webhookSecret;
            if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) continue;
            const siteHost = jiraSiteHost(settings?.baseUrl);
            candidates.push({
                userId: row.userId,
                webhookSecret,
                ...(siteHost ? { siteHost } : {}),
            });
        }
        return candidates;
    }

    /**
     * Normalize one delivery into a `jira.issue` envelope, or null when
     * it is not issue activity (comment / worklog / project events fall
     * through; the pull path covers comments).
     */
    normalize(body: JiraWebhookBody): IngestedEventEnvelope | null {
        const webhookEvent = nonEmpty(body?.webhookEvent);
        if (!webhookEvent || !JIRA_ISSUE_WEBHOOK_EVENTS.includes(webhookEvent)) return null;

        const issue = body.issue;
        const issueId = typeof issue?.id === 'number' ? String(issue.id) : nonEmpty(issue?.id);
        if (!issue || !issueId) return null;

        const fields = issue.fields ?? {};
        const issueKey = nonEmpty(issue.key);
        const projectKey = nonEmpty(fields.project?.key);
        const summary = nonEmpty(fields.summary);
        const description = jiraTextOf(fields.description);
        const createdAt = jiraIso(fields.created);
        const updatedAt = jiraIso(fields.updated ?? fields.created ?? body.timestamp);

        const statusItem = (body.changelog?.items ?? []).find(
            (item) => (item.field ?? item.fieldId ?? '').toLowerCase() === 'status',
        );
        const changeType: JiraIssueChangeType =
            webhookEvent === 'jira:issue_created'
                ? 'created'
                : webhookEvent === 'jira:issue_deleted'
                  ? 'deleted'
                  : statusItem
                    ? 'transitioned'
                    : 'updated';

        // A deletion does not bump `updated`; key it on the delivery
        // time so it can never collide with the last update's revision.
        const revision =
            changeType === 'deleted' ? `deleted:${jiraIso(body.timestamp)}` : updatedAt;

        const siteHost = jiraSiteHost(issue.self) ?? jiraSiteHost(body.user?.self);
        // Through `httpsUrl` rather than as a bare template string: the
        // issue key is unbounded vendor data and `ingested_events.sourceUrl`
        // is varchar(2048), so an absurd key would otherwise turn a
        // VERIFIED delivery into a insert error → 500 → an endless Jira
        // redelivery loop instead of a filed issue.
        const sourceUrl =
            siteHost && issueKey
                ? httpsUrl(`https://${siteHost}/browse/${encodeURIComponent(issueKey)}`)
                : undefined;
        const actor = nonEmpty(body.user?.displayName);
        const labels = (Array.isArray(fields.labels) ? fields.labels : [])
            .filter((label): label is string => typeof label === 'string' && label.length > 0)
            .slice(0, 50);

        return {
            id: randomUUID(),
            source: JIRA_CONNECTOR_PLUGIN_ID,
            // Same shape as the pull path (`${issue.id}:${updatedAt}`) so a
            // webhook and a later sweep of the same change dedupe.
            sourceEventId: capped(
                `${issueId}:${revision}`,
                INGESTED_EVENT_SOURCE_EVENT_ID_MAX_CHARS,
            ),
            kind: JIRA_ISSUE_EVENT_KIND,
            occurredAt: changeType === 'deleted' ? jiraIso(body.timestamp) : updatedAt,
            // Every column-width cap is enforced here, not hoped for: a
            // Jira display name runs to 255 chars against an `actorName`
            // of varchar(200), and an over-long value fails the INSERT,
            // which on this public receiver means 500 + endless redelivery.
            ...(actor ? { actor: { name: capped(actor, INGESTED_EVENT_ACTOR_MAX_CHARS) } } : {}),
            subject: {
                type: 'issue',
                externalId: capped(issueId, INGESTED_EVENT_SUBJECT_EXTERNAL_ID_MAX_CHARS),
                ...(summary ? { title: capped(summary, INGESTED_EVENT_TITLE_MAX_CHARS) } : {}),
            },
            // Work routing: the project is the container an Ever Works Work
            // maps onto (claimed under Tracker team). Issues without a
            // project stay user-scoped.
            ...(projectKey
                ? {
                      workHint: {
                          kind: 'tracker-team' as const,
                          externalId: projectKey,
                          ...(fields.project?.name ? { label: fields.project.name } : {}),
                      },
                  }
                : {}),
            ...(sourceUrl ? { sourceUrl } : {}),
            payload: {
                issueId,
                ...(issueKey ? { issueKey } : {}),
                ...(projectKey ? { projectKey } : {}),
                ...(fields.project?.name ? { projectName: fields.project.name } : {}),
                ...(summary ? { summary: capped(summary, INGESTED_EVENT_TITLE_MAX_CHARS) } : {}),
                ...(description
                    ? { description: capped(description, INGESTED_EVENT_TEXT_MAX_CHARS) }
                    : {}),
                ...(fields.status?.name ? { status: fields.status.name } : {}),
                ...(fields.issuetype?.name ? { issueType: fields.issuetype.name } : {}),
                ...(fields.priority?.name ? { priority: fields.priority.name } : {}),
                ...(fields.assignee?.displayName ? { assignee: fields.assignee.displayName } : {}),
                ...(fields.reporter?.displayName ? { reporter: fields.reporter.displayName } : {}),
                ...(labels.length > 0 ? { labels } : {}),
                changeType,
                ...(nonEmpty(body.issue_event_type_name)
                    ? { eventType: body.issue_event_type_name }
                    : {}),
                ...(statusItem?.fromString ? { statusFrom: statusItem.fromString } : {}),
                ...(statusItem?.toString ? { statusTo: statusItem.toString } : {}),
                ...(sourceUrl ? { url: sourceUrl } : {}),
                createdAt,
                updatedAt,
            },
        };
    }

    /** Ingest one verified delivery. Dedupe makes Jira retries free. */
    async handleEvent(
        binding: JiraEventsBinding,
        body: JiraWebhookBody,
    ): Promise<{ ingested: IngestResult | null }> {
        const envelope = this.normalize(body);
        if (!envelope) {
            return { ingested: null };
        }
        const ingested = await this.eventIngestService.ingest(binding.userId, [envelope]);
        if (ingested.inserted > 0) {
            this.logger.log(
                `Ingested ${envelope.kind} ${envelope.subject?.externalId ?? envelope.sourceEventId} for user ${binding.userId}`,
            );
        }
        return { ingested };
    }
}
