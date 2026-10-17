import { WorkAppSpecStateRepository } from '../../database/repositories/work-app-spec-state.repository';
import { licensePreconditionsForTarget } from '../../app-runtime/app-license-gate';
import {
    AppLicenseService,
    attestationIsValid,
    attestationTextFor,
    hostingEligibilityOf,
    obligationsFor,
} from '../app-license.service';

/**
 * APW-03 T42 — `AppLicenseService`: R-3's eligibility, the attestation record and its
 * invalidation, and FR-37's upstream preview.
 */

const WORK_ID = '00000000-0000-4000-8000-00000000c0de';
const OWNER = 'owner-1';

function statesDouble(initial: Record<string, unknown>) {
    const row: Record<string, unknown> = {
        workId: WORK_ID,
        licenseRequestedSeq: 0,
        licenseEvaluatedSeq: 0,
        ...initial,
    };
    return {
        row,
        findByWorkId: jest.fn(async () => ({ ...row })),
        nextLicenseSeq: jest.fn(async () => {
            row.licenseRequestedSeq = Number(row.licenseRequestedSeq) + 1;
            return row.licenseRequestedSeq as number;
        }),
        writeLicense: jest.fn(async (_w: string, seq: number, result: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(result)) {
                if (value !== undefined) row[key] = value;
            }
            row.licenseEvaluatedSeq = seq;
            return true;
        }),
        findStaleRegistry: jest.fn(async () => [{ workId: WORK_ID }]),
        writeAttestation: jest.fn(async (_w: string, attestation: unknown) => {
            row.attestation = attestation;
            return true;
        }),
    };
}

function build(input: {
    row: Record<string, unknown>;
    detected?: string | null;
    type?: string;
    tree?: Array<{ path: string; type: 'blob' | 'tree' }>;
}) {
    const states = statesDouble(input.row);
    const works = {
        findById: jest.fn(async () => ({
            id: WORK_ID,
            userId: OWNER,
            slug: 'app',
            owner: 'member',
            gitProvider: 'github',
            sourceRepository: {
                owner: 'member',
                repo: 'app',
                type: input.type ?? 'app_fork',
            },
        })),
    };
    const git = {
        getRepository: jest.fn(async () => ({
            fullName: 'member/app',
            visibility: 'public',
            licenseSpdx: input.detected ?? null,
        })),
        ...(input.tree
            ? {
                  getRepositoryTree: jest.fn(async () => ({
                      entries: input.tree,
                      truncated: false,
                  })),
                  getFileContent: jest.fn(async () => null),
              }
            : {}),
    };
    const activity = { log: jest.fn(async (_entry: unknown) => ({ id: 'a' })) };
    const moduleRef = {
        get: (token: unknown) => {
            if (token === WorkAppSpecStateRepository) return states;
            throw new Error('not here');
        },
    };
    const service = new AppLicenseService(
        works as never,
        git as never,
        activity as never,
        moduleRef as never,
    );
    return { service, states, git, activity };
}

describe('AppLicenseService (APW-03 T42)', () => {
    describe('hostingEligibilityOf (R-3)', () => {
        const base = {
            attested: false,
            obligations: [] as string[],
            relation: 'fork',
            aheadBy: 0,
            isPublic: true,
            owner: 'o',
            repo: 'r',
            registrySnapshot: true,
            verified: false,
        };

        it('green runs on your cluster without attestation; managed fails closed on the snapshot', () => {
            const verdict = hostingEligibilityOf({ ...base, licenseClass: 'green' });
            expect(verdict.yourCluster).toBe('allowed');
            expect(verdict.managed).toBe('blueprintNotVerified');
            expect(verdict.none).toBe('allowed');
        });

        it('APW-10 lite: an open tier with scope any admits green only — amber/red/unknown keep their codes even attested', () => {
            const open = { ...base, managedScope: 'any' as const, tierOpen: true };
            expect(hostingEligibilityOf({ ...open, licenseClass: 'green' }).managed).toBe(
                'allowed',
            );
            expect(
                hostingEligibilityOf({ ...open, licenseClass: 'amber', attested: true }).managed,
            ).toBe('upstreamAgreementMissing');
            expect(
                hostingEligibilityOf({ ...open, licenseClass: 'red', attested: true }).managed,
            ).toBe('licenseNotGreen');
            expect(
                hostingEligibilityOf({ ...open, licenseClass: 'unknown', attested: true }).managed,
            ).toBe('licenseNotGreen');
        });

        it('APW-10 lite: a closed tier is managedTierDisabled, and verified-blueprints keeps the snapshot rule', () => {
            expect(
                hostingEligibilityOf({
                    ...base,
                    licenseClass: 'green',
                    managedScope: 'any',
                    tierOpen: false,
                }).managed,
            ).toBe('managedTierDisabled');
            expect(
                hostingEligibilityOf({
                    ...base,
                    licenseClass: 'green',
                    managedScope: 'verified-blueprints',
                    tierOpen: true,
                }).managed,
            ).toBe('blueprintNotVerified');
        });

        it('an amber Work is refused for Ever Works Apps (ACC-03-33) and needs attestation', () => {
            const verdict = hostingEligibilityOf({ ...base, licenseClass: 'amber' });
            expect(verdict.yourCluster).toBe('attestationRequired');
            expect(verdict.managed).toBe('upstreamAgreementMissing');
            expect(
                licensePreconditionsForTarget(verdict, 'your-cluster', WORK_ID).preconditions,
            ).toEqual([expect.objectContaining({ code: 'license_attestation_missing' })]);
        });

        it('red runs on your cluster only after attestation and is never managed (ACC-03-47)', () => {
            expect(hostingEligibilityOf({ ...base, licenseClass: 'red' }).yourCluster).toBe(
                'attestationRequired',
            );
            const attested = hostingEligibilityOf({ ...base, licenseClass: 'red', attested: true });
            expect(attested.yourCluster).toBe('allowed');
            expect(attested.managed).toBe('licenseNotGreen');
        });

        it('a private AGPL Work without a source offer URL is missing its offer (ACC-03-36)', () => {
            const verdict = hostingEligibilityOf({
                ...base,
                licenseClass: 'green',
                obligations: obligationsFor('AGPL-3.0-only'),
                isPublic: false,
                aheadBy: null,
                commitSha: 'a'.repeat(40),
            });
            expect(verdict.sourceOffer).toEqual({ required: true, url: null, missing: true });
        });

        it('a public AGPL Work offers the tree at the deployed commit', () => {
            const verdict = hostingEligibilityOf({
                ...base,
                licenseClass: 'green',
                obligations: obligationsFor('AGPL-3.0-only'),
                aheadBy: 2,
                commitSha: 'b'.repeat(40),
            });
            expect(verdict.sourceOffer).toEqual({
                required: true,
                url: `https://github.com/o/r/tree/${'b'.repeat(40)}`,
                missing: false,
            });
        });
    });

    describe('evaluate', () => {
        it('classifies the declared Blueprint licence first, then the detected one', async () => {
            const declared = build({
                row: { effectiveSpec: { license: { spdx: 'BUSL-1.1' } } },
                detected: 'MIT',
            });
            const verdict = await declared.service.evaluate(WORK_ID);
            expect(verdict).toMatchObject({
                spdx: 'BUSL-1.1',
                licenseClass: 'amber',
                source: 'blueprint',
            });

            const detected = build({ row: {}, detected: 'MIT' });
            await expect(detected.service.evaluate(WORK_ID)).resolves.toMatchObject({
                spdx: 'MIT',
                licenseClass: 'green',
                source: 'detected',
            });
        });

        it('MIT → BUSL-1.1 clears the attestation and requires a new one (ACC-03-35)', async () => {
            const h = build({
                row: {
                    licenseSpdx: 'BUSL-1.1',
                    licenseClass: 'amber',
                    attestation: {
                        userId: OWNER,
                        spdx: 'BUSL-1.1',
                        class: 'amber',
                        textId: 'busl-1.1-v1',
                        textSha256: 'x',
                        commitSha: 'c',
                        attestedAt: 'now',
                    },
                },
                detected: 'PolyForm-Noncommercial-1.0.0',
            });
            expect(attestationIsValid(h.states.row as never)).toBe(true);

            const verdict = await h.service.evaluate(WORK_ID, 'upstream_synced');

            expect(verdict?.attestationCleared).toBe(true);
            expect(h.states.row.attestation).toBeNull();
            const eligibility = await h.service.getHostingEligibility(WORK_ID);
            expect(eligibility?.yourCluster).toBe('attestationRequired');
            const actions = h.activity.log.mock.calls.map(
                (call) => (call[0] as { action: string }).action,
            );
            expect(actions).toEqual(['app.license.changed', 'app.license.attestation_required']);
        });
    });

    describe('T41 detection and T43 triggers', () => {
        it('a declared MIT over an ee/ directory is mixed and at least amber (ACC-03-32)', async () => {
            const h = build({
                row: { effectiveSpec: { license: { spdx: 'MIT' } }, trackedBranch: 'main' },
                detected: 'MIT',
                tree: [
                    { path: 'LICENSE', type: 'blob' },
                    { path: 'ee', type: 'tree' },
                    { path: 'ee/feature.ts', type: 'blob' },
                    { path: 'src/index.ts', type: 'blob' },
                ],
            });

            const verdict = await h.service.evaluate(WORK_ID);

            expect(verdict).toMatchObject({ spdx: 'MIT', licenseClass: 'amber' });
            expect(h.states.row.licenseMixed).toBe(true);
            expect(h.states.row.licenseScanIncomplete).toBe(false);
            expect(
                (h.states.row.licenseEvidence as { mixedPaths: string[] }).mixedPaths.join(','),
            ).toContain('ee');
        });

        it('without a tree capability the scan is recorded as incomplete', async () => {
            const h = build({ row: {}, detected: 'MIT' });
            await h.service.evaluate(WORK_ID);
            expect(h.states.row.licenseScanIncomplete).toBe(true);
            expect(h.states.row.licenseClass).toBe('green');
        });

        it('re-classifies on app.spec.applied', async () => {
            const h = build({ row: {}, detected: 'MIT' });
            const request = jest.spyOn(h.service, 'request');
            await h.service.onSpecApplied({ workId: WORK_ID });
            await h.service.onSpecApplied({});
            expect(request).toHaveBeenCalledTimes(1);
            expect(request).toHaveBeenCalledWith(WORK_ID, 'spec_changed');
        });

        it('the registry fan-out re-classifies the stale rows, capped at 500', async () => {
            const h = build({ row: {}, detected: 'MIT' });
            await expect(h.service.refreshStaleRegistry(10_000)).resolves.toEqual({
                scanned: 1,
                evaluated: 1,
            });
            expect(h.states.findStaleRegistry).toHaveBeenCalledWith(expect.any(String), 500);
        });
    });

    describe('getHostingEligibility', () => {
        it('re-classifies when the effective spec now declares a different licence', async () => {
            const h = build({
                row: {
                    licenseSpdx: 'MIT',
                    licenseClass: 'green',
                    licenseSource: 'detected',
                    effectiveSpec: { license: { spdx: 'BUSL-1.1' } },
                },
                detected: 'MIT',
            });

            const eligibility = await h.service.getHostingEligibility(WORK_ID);

            expect(eligibility?.yourCluster).toBe('attestationRequired');
            expect(h.states.row.licenseSpdx).toBe('BUSL-1.1');
        });
    });

    describe('attest (T44)', () => {
        it('records the owner with the text id and hash, then eligibility allows your cluster', async () => {
            const h = build({
                row: { licenseSpdx: 'BUSL-1.1', licenseClass: 'amber', licenseCommitSha: 'c1' },
            });

            const record = await h.service.attest(WORK_ID, OWNER);

            expect(record).toMatchObject({
                userId: OWNER,
                spdx: 'BUSL-1.1',
                class: 'amber',
                textId: attestationTextFor('BUSL-1.1')?.textId,
                commitSha: 'c1',
            });
            await expect(h.service.getHostingEligibility(WORK_ID)).resolves.toMatchObject({
                yourCluster: 'allowed',
            });
        });

        it('refuses anyone but the owner', async () => {
            const h = build({ row: { licenseSpdx: 'BUSL-1.1', licenseClass: 'amber' } });
            await expect(h.service.attest(WORK_ID, 'manager-2')).rejects.toMatchObject({
                response: { code: 'ownerOnly' },
            });
        });
    });

    describe('previewUpstream (FR-37)', () => {
        it('is worse when upstream moved from green to amber', async () => {
            const h = build({
                row: { licenseSpdx: 'MIT', licenseClass: 'green' },
                detected: 'BUSL-1.1',
            });
            await expect(
                h.service.previewUpstream(WORK_ID, 'up', 'stream', 'sha'),
            ).resolves.toMatchObject({
                worse: true,
                licenseClass: 'amber',
            });
        });

        it('is not worse when upstream stays green', async () => {
            const h = build({
                row: { licenseSpdx: 'MIT', licenseClass: 'green' },
                detected: 'Apache-2.0',
            });
            await expect(
                h.service.previewUpstream(WORK_ID, 'up', 'stream', 'sha'),
            ).resolves.toMatchObject({
                worse: false,
            });
        });
    });
});
