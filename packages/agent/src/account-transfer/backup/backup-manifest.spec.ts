import { BACKUP_DOMAINS, BACKUP_EXCLUSIONS, BACKUP_FORMAT_SENTINEL } from '@ever-works/contracts';
import {
    buildManifest,
    countCompleteDomains,
    hasGaps,
    summarizeManifest,
    type BackupDomainOutcome,
} from './backup-manifest';
import { buildReadme, countReadmeWords } from './backup-readme';

/**
 * `manifest.json` is the contract the archive format publishes. Every
 * assertion here is something a person holding a downloaded `.zip` can check
 * for themselves with a text editor.
 */

function outcomes(
    overrides: Partial<Record<string, BackupDomainOutcome>> = {},
): BackupDomainOutcome[] {
    return BACKUP_DOMAINS.map(
        (domain) =>
            overrides[domain.key] ?? {
                key: domain.key,
                status: 'complete' as const,
                records: 3,
                files: [
                    {
                        name: `data/${domain.dataDir}/rows.jsonl`,
                        records: 3,
                        sha256: 'a'.repeat(64),
                    },
                ],
            },
    );
}

function manifestWith(input: Partial<Parameters<typeof buildManifest>[0]> = {}) {
    return buildManifest({
        producedAt: new Date('2026-09-06T14:12:00.000Z'),
        build: 'test-build',
        workspace: { id: 'org-1', slug: 'acme', displayName: 'Acme', kind: 'organization' },
        account: { id: 'u1', displayName: 'Owner', email: 'owner@example.invalid' },
        includeFullHistory: false,
        outcomes: outcomes(),
        filesIncluded: 2,
        fileBytes: 2048,
        omissions: [],
        archiveBytes: 4096,
        ...input,
    });
}

describe('buildManifest', () => {
    it('describes all fifteen domains, in the published order', () => {
        const manifest = manifestWith();
        expect(manifest.domains).toHaveLength(15);
        expect(manifest.domains.map((domain) => domain.key)).toEqual(
            BACKUP_DOMAINS.map((domain) => domain.key),
        );
    });

    it('carries the sentinel and the produced-at instant a check looks for', () => {
        const manifest = manifestWith();
        expect(manifest.everworksBackupFormat).toBe(BACKUP_FORMAT_SENTINEL);
        expect(manifest.producedAt).toBe('2026-09-06T14:12:00.000Z');
    });

    it('identifies the workspace and the account, so an archive found on a disk says whose it is', () => {
        const manifest = manifestWith();
        expect(manifest.workspace).toEqual({
            id: 'org-1',
            slug: 'acme',
            displayName: 'Acme',
            kind: 'organization',
        });
        expect(manifest.account.email).toBe('owner@example.invalid');
        expect(manifest.producedBy.build).toBe('test-build');
    });

    it('reports a domain whose collector never ran as failed, never as absent', () => {
        // The distinction spec FR-13 exists for: "you have none of these" is
        // not the same answer as "we did not export these".
        const manifest = manifestWith({ outcomes: outcomes().filter((o) => o.key !== 'fleet') });
        const fleet = manifest.domains.find((domain) => domain.key === 'fleet');
        expect(fleet?.status).toBe('failed');
        expect(fleet?.error).toEqual({ code: 'collector_missing' });
        expect(manifest.domains).toHaveLength(15);
    });

    it('takes each domain’s restorability from the format, not from the collector', () => {
        const manifest = manifestWith();
        expect(manifest.domains.find((d) => d.key === 'billing')?.restorability).toBe(
            'record-only',
        );
        expect(manifest.domains.find((d) => d.key === 'agents')?.restorability).toBe('restorable');
    });

    it('records a trim with its cutoff and the number of rows it left out', () => {
        const manifest = manifestWith({
            outcomes: outcomes({
                activity: {
                    key: 'activity',
                    status: 'trimmed',
                    records: 10,
                    files: [
                        {
                            name: 'data/activity/activity.jsonl',
                            records: 10,
                            sha256: 'b'.repeat(64),
                        },
                    ],
                    trims: [
                        {
                            field: 'createdAt',
                            cutoff: '2025-09-06T00:00:00.000Z',
                            omittedRecords: 4118,
                        },
                    ],
                },
            }),
        });
        expect(manifest.domains.find((d) => d.key === 'activity')?.trims).toEqual([
            { field: 'createdAt', cutoff: '2025-09-06T00:00:00.000Z', omittedRecords: 4118 },
        ]);
    });

    it('states all nine exclusion categories rather than omitting them silently', () => {
        expect(manifestWith().exclusions).toEqual(BACKUP_EXCLUSIONS);
    });

    it('totals the records across every domain', () => {
        expect(manifestWith().totals.records).toBe(45);
    });

    it('lists every omitted file with its id, name, size and reason', () => {
        const manifest = manifestWith({
            omissions: [
                {
                    id: 'up-1',
                    name: 'huge.mov',
                    sizeBytes: 250 * 1024 * 1024,
                    reason: 'size_limit',
                },
            ],
        });
        expect(manifest.files.omitted).toEqual([
            { id: 'up-1', name: 'huge.mov', sizeBytes: 262144000, reason: 'size_limit' },
        ]);
    });
});

describe('summarizeManifest', () => {
    it('collapses the one unbounded part so the record can outlive the archive', () => {
        const manifest = manifestWith({
            omissions: Array.from({ length: 37 }, (_, i) => ({
                id: `up-${i}`,
                name: `f${i}.bin`,
                sizeBytes: 1,
                reason: 'size_limit' as const,
            })),
        });
        const summary = summarizeManifest(manifest);
        expect(summary.files).toEqual({ included: 2, bytes: 2048, omitted: 37 });
        // Everything else survives, so the coverage drawer still works after
        // the bytes are gone (spec FR-29).
        expect(summary.domains).toHaveLength(15);
        expect(summary.workspace).toEqual(manifest.workspace);
    });
});

describe('countCompleteDomains / hasGaps', () => {
    it('counts fifteen and reports no gaps for a clean run', () => {
        const manifest = manifestWith();
        expect(countCompleteDomains(manifest)).toBe(15);
        expect(hasGaps(manifest)).toBe(false);
    });

    it('counts fourteen and reports a gap when one domain failed (spec S-13)', () => {
        const manifest = manifestWith({
            outcomes: outcomes({
                runs: {
                    key: 'runs',
                    status: 'failed',
                    records: 0,
                    files: [],
                    errorCode: 'QueryFailedError',
                },
            }),
        });
        expect(countCompleteDomains(manifest)).toBe(14);
        expect(hasGaps(manifest)).toBe(true);
    });

    it('reports a gap when a file was left out for size, even with every domain complete', () => {
        const manifest = manifestWith({
            omissions: [{ id: 'up-1', name: 'huge.mov', sizeBytes: 1, reason: 'size_limit' }],
        });
        expect(countCompleteDomains(manifest)).toBe(15);
        expect(hasGaps(manifest)).toBe(true);
    });

    it('does not call a trimmed or empty domain a gap — both are complete answers', () => {
        const manifest = manifestWith({
            outcomes: outcomes({
                activity: { key: 'activity', status: 'trimmed', records: 5, files: [] },
                fleet: { key: 'fleet', status: 'empty', records: 0, files: [] },
            }),
        });
        expect(hasGaps(manifest)).toBe(false);
    });
});

describe('buildReadme', () => {
    const readme = () =>
        buildReadme({
            manifest: manifestWith(),
            retentionDays: 14,
            formatReferenceUrl: 'https://docs.ever.works/features/workspace-backup',
        });

    it('stays under the four-hundred-word ceiling', () => {
        expect(countReadmeWords(readme())).toBeLessThan(400);
    });

    it('says when it was taken and whose workspace it is', () => {
        const text = readme();
        expect(text).toContain('Acme');
        expect(text).toContain('2026-09-06T14:12:00.000Z');
        expect(text).toContain('owner@example.invalid');
    });

    it('explains every folder a reader will find at the top level', () => {
        const text = readme();
        for (const folder of ['manifest.json', 'data/', 'files/', 'checksums.txt']) {
            expect(text).toContain(folder);
        }
    });

    it('states the encryption posture in one sentence rather than implying it', () => {
        expect(readme()).toContain('not encrypted');
    });

    it('lists what is deliberately absent, from the same source the manifest uses', () => {
        const text = readme();
        for (const exclusion of BACKUP_EXCLUSIONS) {
            expect(text).toContain(exclusion.summary);
        }
    });

    it('says how long our copy lasted and where the field reference lives', () => {
        const text = readme();
        expect(text).toContain('14 days');
        expect(text).toContain('https://docs.ever.works/features/workspace-backup');
    });

    it('names which domains a restore can recreate and which are a record only', () => {
        const text = readme();
        expect(text).toContain('agents');
        expect(text).toContain('billing');
    });

    it('tells the reader when files were left out for size', () => {
        const text = buildReadme({
            manifest: manifestWith({
                omissions: [{ id: 'up-1', name: 'huge.mov', sizeBytes: 1, reason: 'size_limit' }],
            }),
            retentionDays: 14,
            formatReferenceUrl: 'https://docs.ever.works/features/workspace-backup',
        });
        expect(text).toContain('size_limit');
    });

    it('reads the retention that was in force, not a hard-coded fourteen', () => {
        const text = buildReadme({
            manifest: manifestWith(),
            retentionDays: 30,
            formatReferenceUrl: 'https://docs.ever.works/features/workspace-backup',
        });
        expect(text).toContain('30 days');
        expect(text).not.toContain('14 days');
    });
});
