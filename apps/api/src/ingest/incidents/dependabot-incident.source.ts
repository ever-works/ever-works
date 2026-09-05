import { Injectable } from '@nestjs/common';
import type { IngestedEventEnvelope } from '@ever-works/contracts';
import { GITHUB_PLUGIN_ID } from '../github/github-pr-review-bridge.service';
import { httpsUrl, nonEmpty } from '../ingest-envelope.util';
import {
    buildIncidentEnvelope,
    type IncidentPayload,
    type IncidentSource,
} from './incident-source.types';

/**
 * `dependabot_alert` actions that describe a state worth filing or
 * refreshing. `auto_dismissed` / `auto_reopened` are Dependabot's own
 * rule engine acting; they still change the alert's state.
 */
export const DEPENDABOT_ALERT_ACTIONS: readonly string[] = [
    'created',
    'reopened',
    'reintroduced',
    'auto_reopened',
    'fixed',
    'dismissed',
    'auto_dismissed',
];

/** The subset of a GitHub `dependabot_alert` delivery the source reads. */
export interface DependabotAlertWebhookBody {
    action?: string;
    repository?: { full_name?: string; html_url?: string };
    sender?: { login?: string; type?: string };
    alert?: {
        number?: number;
        state?: string;
        html_url?: string;
        url?: string;
        created_at?: string;
        updated_at?: string;
        dismissed_at?: string | null;
        dismissed_reason?: string | null;
        dismissed_comment?: string | null;
        fixed_at?: string | null;
        dependency?: {
            manifest_path?: string;
            scope?: string;
            package?: { ecosystem?: string; name?: string };
        };
        security_advisory?: {
            ghsa_id?: string;
            cve_id?: string | null;
            summary?: string;
            severity?: string;
            description?: string;
        };
        security_vulnerability?: {
            severity?: string;
            vulnerable_version_range?: string;
            first_patched_version?: { identifier?: string } | null;
        };
    };
}

/**
 * Dependabot security alerts as incidents — a THIN adapter.
 *
 * Rides the existing GitHub receiver: the delivery is verified with the
 * GitHub App / install secret and attributed through the same
 * install-binding model before this source ever sees it
 * (`GitHubIssueIntakeService` hands `dependabot_alert` deliveries here).
 * Nothing vendor-specific to verify, so the whole adapter is a
 * normalizer.
 *
 * Identity: `<owner/repo>#dependabot-<alert.number>` — the alert number
 * is stable for the life of the alert, and the `dependabot-` infix keeps
 * it out of the GitHub issues namespace (`<owner/repo>#<number>`), so
 * the two can share `source: 'github'` in `external_issue_links`.
 */
@Injectable()
export class DependabotIncidentSource implements IncidentSource<DependabotAlertWebhookBody> {
    readonly provider = 'dependabot' as const;
    readonly source = GITHUB_PLUGIN_ID;

    normalize(body: DependabotAlertWebhookBody): IngestedEventEnvelope | null {
        const action = nonEmpty(body?.action);
        if (!action || !DEPENDABOT_ALERT_ACTIONS.includes(action)) return null;

        const fullName = nonEmpty(body.repository?.full_name);
        const [owner, repo] = (fullName ?? '').split('/');
        if (!fullName || !owner || !repo) return null;

        const alert = body.alert;
        const number = alert?.number;
        if (!alert || typeof number !== 'number' || !Number.isFinite(number)) return null;

        const advisory = alert.security_advisory ?? {};
        const vulnerability = alert.security_vulnerability ?? {};
        const dependency = alert.dependency ?? {};
        const pkg = dependency.package ?? {};

        const packageLabel = [pkg.ecosystem, pkg.name].filter(Boolean).join(':');
        const culprit = [
            packageLabel,
            dependency.manifest_path ? `(${dependency.manifest_path})` : '',
        ]
            .filter(Boolean)
            .join(' ');
        const title =
            nonEmpty(advisory.summary) ??
            (packageLabel ? `Dependabot alert for ${packageLabel}` : `Dependabot alert #${number}`);
        const level = nonEmpty(advisory.severity) ?? nonEmpty(vulnerability.severity);
        const url = httpsUrl(alert.html_url);
        const revision = nonEmpty(alert.updated_at) ?? nonEmpty(alert.created_at) ?? action;

        const payload: IncidentPayload = {
            provider: this.provider,
            externalId: `${fullName}#dependabot-${number}`,
            title,
            ...(url ? { url } : {}),
            ...(culprit ? { culprit } : {}),
            ...(level ? { level: level.toLowerCase() } : {}),
            ...(alert.state ? { status: alert.state } : {}),
            action,
            repoFullName: fullName,
            alertNumber: number,
            ...(advisory.ghsa_id ? { ghsaId: advisory.ghsa_id } : {}),
            ...(advisory.cve_id ? { cveId: advisory.cve_id } : {}),
            ...(pkg.ecosystem ? { ecosystem: pkg.ecosystem } : {}),
            ...(pkg.name ? { package: pkg.name } : {}),
            ...(dependency.manifest_path ? { manifestPath: dependency.manifest_path } : {}),
            ...(dependency.scope ? { scope: dependency.scope } : {}),
            ...(vulnerability.vulnerable_version_range
                ? { vulnerableVersionRange: vulnerability.vulnerable_version_range }
                : {}),
            ...(vulnerability.first_patched_version?.identifier
                ? { firstPatchedVersion: vulnerability.first_patched_version.identifier }
                : {}),
            ...(alert.dismissed_reason ? { dismissedReason: alert.dismissed_reason } : {}),
        };

        return buildIncidentEnvelope({
            source: this.source,
            // Revision-bearing: a re-opened or re-dismissed alert lands as a
            // NEW event; an exact GitHub redelivery dedupes to zero.
            sourceEventId: `dependabot:${fullName}#${number}@${action}:${revision}`,
            occurredAt: alert.updated_at ?? alert.created_at,
            ...(body.sender?.login ? { actor: body.sender.login } : {}),
            subjectType: 'dependabot_alert',
            ...(url ? { sourceUrl: url } : {}),
            workHint: { kind: 'repo', externalId: fullName },
            payload,
        });
    }
}
