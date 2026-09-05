import { DependabotIncidentSource } from './dependabot-incident.source';
import { INCIDENT_EVENT_KIND } from './incident-source.types';

function alertBody(
    overrides: Record<string, unknown> = {},
    alertOverrides: Record<string, unknown> = {},
) {
    return {
        action: 'created',
        repository: { full_name: 'octo/site', html_url: 'https://github.com/octo/site' },
        sender: { login: 'dependabot[bot]', type: 'Bot' },
        alert: {
            number: 42,
            state: 'open',
            html_url: 'https://github.com/octo/site/security/dependabot/42',
            created_at: '2026-09-01T10:00:00Z',
            updated_at: '2026-09-01T10:00:00Z',
            dependency: {
                manifest_path: 'apps/api/package.json',
                scope: 'runtime',
                package: { ecosystem: 'npm', name: 'lodash' },
            },
            security_advisory: {
                ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
                cve_id: 'CVE-2026-0001',
                summary: 'Prototype pollution in lodash',
                severity: 'high',
            },
            security_vulnerability: {
                severity: 'high',
                vulnerable_version_range: '< 4.17.21',
                first_patched_version: { identifier: '4.17.21' },
            },
            ...alertOverrides,
        },
        ...overrides,
    };
}

describe('DependabotIncidentSource', () => {
    const source = new DependabotIncidentSource();

    it('declares the provider and lands under the GitHub source namespace', () => {
        expect(source.provider).toBe('dependabot');
        expect(source.source).toBe('github');
    });

    it('normalizes a created alert into a cross-vendor incident envelope', () => {
        const envelope = source.normalize(alertBody());
        expect(envelope).not.toBeNull();
        expect(envelope).toMatchObject({
            source: 'github',
            kind: INCIDENT_EVENT_KIND,
            sourceEventId: 'dependabot:octo/site#42@created:2026-09-01T10:00:00Z',
            occurredAt: '2026-09-01T10:00:00.000Z',
            actor: { name: 'dependabot[bot]' },
            subject: {
                type: 'dependabot_alert',
                externalId: 'octo/site#dependabot-42',
                title: 'Prototype pollution in lodash',
            },
            workHint: { kind: 'repo', externalId: 'octo/site' },
            sourceUrl: 'https://github.com/octo/site/security/dependabot/42',
            payload: {
                provider: 'dependabot',
                externalId: 'octo/site#dependabot-42',
                title: 'Prototype pollution in lodash',
                culprit: 'npm:lodash (apps/api/package.json)',
                level: 'high',
                status: 'open',
                action: 'created',
                url: 'https://github.com/octo/site/security/dependabot/42',
                ghsaId: 'GHSA-xxxx-yyyy-zzzz',
                cveId: 'CVE-2026-0001',
                firstPatchedVersion: '4.17.21',
                vulnerableVersionRange: '< 4.17.21',
                repoFullName: 'octo/site',
                alertNumber: 42,
            },
        });
    });

    it('keeps the alert out of the GitHub issues id namespace', () => {
        const envelope = source.normalize(alertBody());
        // `octo/site#42` is issue 42; the alert is `octo/site#dependabot-42`.
        expect(envelope?.subject?.externalId).not.toBe('octo/site#42');
        expect(envelope?.subject?.externalId).toBe('octo/site#dependabot-42');
    });

    it('lands every lifecycle action as a NEW revision of the same alert', () => {
        const created = source.normalize(alertBody());
        const dismissed = source.normalize(
            alertBody(
                { action: 'dismissed' },
                {
                    state: 'dismissed',
                    dismissed_reason: 'tolerable_risk',
                    updated_at: '2026-09-02T08:00:00Z',
                },
            ),
        );
        expect(dismissed?.subject?.externalId).toBe(created?.subject?.externalId);
        expect(dismissed?.sourceEventId).not.toBe(created?.sourceEventId);
        expect(dismissed?.payload).toMatchObject({
            action: 'dismissed',
            status: 'dismissed',
            dismissedReason: 'tolerable_risk',
        });
    });

    it('is deterministic for an exact redelivery (same sourceEventId)', () => {
        const a = source.normalize(alertBody());
        const b = source.normalize(alertBody());
        expect(a?.sourceEventId).toBe(b?.sourceEventId);
    });

    it('ignores actions that are not a state change worth filing', () => {
        expect(source.normalize(alertBody({ action: 'edited' }))).toBeNull();
        expect(source.normalize(alertBody({ action: undefined }))).toBeNull();
    });

    it('refuses a delivery without a repository or an alert number', () => {
        expect(source.normalize(alertBody({ repository: {} }))).toBeNull();
        expect(source.normalize(alertBody({}, { number: undefined }))).toBeNull();
        expect(source.normalize({ action: 'created' })).toBeNull();
    });

    it('drops a non-https alert link instead of persisting it', () => {
        const envelope = source.normalize(alertBody({}, { html_url: 'javascript:alert(1)' }));
        expect(envelope?.sourceUrl).toBeUndefined();
        expect(envelope?.payload.url).toBeUndefined();
    });

    it('falls back to a package-derived title when the advisory has no summary', () => {
        const envelope = source.normalize(
            alertBody({}, { security_advisory: { severity: 'LOW' } }),
        );
        expect(envelope?.subject?.title).toBe('Dependabot alert for npm:lodash');
        expect(envelope?.payload.level).toBe('low');
    });
});
