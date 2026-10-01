/**
 * APW-06 T21 — `app-license-gate.ts` (plan §5.2, spec FR-9, ACC-06-39).
 *
 * Four things this suite exists to prove, in the order the task text names them:
 *
 * 1. `yourCluster: 'attestationRequired'` → `license_attestation_missing`;
 * 2. a `managed` reason — amber without a recorded upstream agreement, or red —
 *    → `license_blocks_target`;
 * 3. a changed eligibility after a licence change **re-requires attestation**,
 *    because nothing is cached (ACC-06-39);
 * 4. the gate **never writes to any repository** (ACC-06-39, R-3): the licence
 *    attestation is APW-03's single record and this epic stores none of its own.
 *
 * The last one is asserted two ways rather than one, because "stores nothing" is
 * easy to satisfy in a test and easy to lose in a refactor: every repository-shaped
 * call a spy could see is counted, **and** the module's own source is read and
 * scanned for a write path. The scan carries a known-good control, so a zero is
 * evidence rather than a broken reader.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { Logger } from '@nestjs/common';

import type { HostingEligibility, SourceOffer } from '@ever-works/contracts';

import {
    AppLicenseGate,
    LICENSE_ELIGIBILITY_UNAVAILABLE,
    licensePreconditionsForTarget,
    type AppLicenseService,
} from '../app-license-gate';

/* -------------------------------------------------------------------------- *
 * Fakes
 * -------------------------------------------------------------------------- */

/**
 * The gate logs every unreadable verdict. Spied rather than asserted on: the cases
 * below make a seam throw on purpose, and the result — not the log line — is the
 * behaviour under test.
 */
beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

/** A source offer that requires nothing — the ordinary green case. */
function noOffer(): SourceOffer {
    return { required: false, url: null, missing: false };
}

/** An eligibility whose every target is allowed until a test says otherwise. */
function eligibility(overrides: Partial<HostingEligibility> = {}): HostingEligibility {
    return {
        none: 'allowed',
        yourCluster: 'allowed',
        managed: 'allowed',
        sourceOffer: noOffer(),
        ...overrides,
    };
}

/**
 * APW-03's `AppLicenseService`, faked — with the write surface a repository-bound
 * service would have, so "the gate never writes" is a measurement and not a claim.
 */
class FakeAppLicenseService implements AppLicenseService {
    /** Every read, in order, with the arguments the gate passed. */
    readonly reads: Array<{ workId: string; commitSha?: string }> = [];

    /** Every repository-shaped call. Must stay empty for the whole suite. */
    readonly writes: string[] = [];

    eligibility: HostingEligibility | null = eligibility();
    failsWith: Error | null = null;

    async getHostingEligibility(
        workId: string,
        opts?: { commitSha?: string },
    ): Promise<HostingEligibility | null> {
        this.reads.push({ workId, commitSha: opts?.commitSha });
        if (this.failsWith) throw this.failsWith;
        return this.eligibility;
    }

    /* The calls a write path would make. Present so a regression is visible. */
    async save(): Promise<void> {
        this.writes.push('save');
    }

    async update(): Promise<void> {
        this.writes.push('update');
    }

    async insert(): Promise<void> {
        this.writes.push('insert');
    }

    async upsert(): Promise<void> {
        this.writes.push('upsert');
    }

    async delete(): Promise<void> {
        this.writes.push('delete');
    }
}

function makeGate(fake?: FakeAppLicenseService): {
    gate: AppLicenseGate;
    fake: FakeAppLicenseService;
} {
    const service = fake ?? new FakeAppLicenseService();
    return { gate: new AppLicenseGate(service), fake: service };
}

/* -------------------------------------------------------------------------- *
 * §5.2's table
 * -------------------------------------------------------------------------- */

describe('AppLicenseGate — plan §5.2 mapping', () => {
    it('refuses Your cluster with license_attestation_missing when APW-03 requires an attestation', async () => {
        const { gate } = makeGate(
            Object.assign(new FakeAppLicenseService(), {
                eligibility: eligibility({ yourCluster: 'attestationRequired' }),
            }),
        );

        const result = await gate.evaluate({ workId: 'work-1', target: 'your-cluster' });

        expect(result.allowed).toBe(false);
        expect(result.preconditions.map((entry) => entry.code)).toEqual([
            'license_attestation_missing',
        ]);
        // The copy names the one person who can clear it (spec §8's non-owner message).
        expect(result.preconditions[0].message).toContain('owner');
    });

    it('allows Your cluster when the eligibility says allowed', async () => {
        const { gate } = makeGate();

        const result = await gate.evaluate({ workId: 'work-1', target: 'your-cluster' });

        expect(result.allowed).toBe(true);
        expect(result.preconditions).toEqual([]);
        expect(result.warnings).toEqual([]);
    });

    it.each([
        ['an amber licence with no upstream agreement', 'upstreamAgreementMissing'],
        ['a red licence', 'licenseNotGreen'],
        ['an unknown licence', 'licenseNotGreen'],
        ['an entry that disallows managed hosting', 'entryDisallows'],
        ['an unverified Blueprint', 'blueprintNotVerified'],
        ['a closed managed tier', 'managedTierDisabled'],
    ])('refuses Ever Works Apps for %s with license_blocks_target', async (_case, reason) => {
        const { gate } = makeGate(
            Object.assign(new FakeAppLicenseService(), {
                eligibility: eligibility({ managed: reason as HostingEligibility['managed'] }),
            }),
        );

        const result = await gate.evaluate({ workId: 'work-1', target: 'ever-works-apps' });

        expect(result.allowed).toBe(false);
        expect(result.preconditions.map((entry) => entry.code)).toEqual(['license_blocks_target']);
        // §5.1 writes this code's reason set as "(+ reasons)"; the reason rides in `names`.
        expect(result.preconditions[0].names).toEqual([reason]);
    });

    it('allows Ever Works Apps when the managed reason is `allowed`', async () => {
        const { gate } = makeGate();

        const result = await gate.evaluate({ workId: 'work-1', target: 'ever-works-apps' });

        expect(result.allowed).toBe(true);
        expect(result.preconditions).toEqual([]);
    });

    it('judges only the target being deployed to, never the other one', async () => {
        // Amber: Your cluster needs the owner's attestation, Ever Works Apps is blocked.
        const amber = eligibility({
            yourCluster: 'attestationRequired',
            managed: 'upstreamAgreementMissing',
        });

        const yours = licensePreconditionsForTarget(amber, 'your-cluster', 'work-1');
        const managed = licensePreconditionsForTarget(amber, 'ever-works-apps', 'work-1');

        expect(yours.preconditions.map((entry) => entry.code)).toEqual([
            'license_attestation_missing',
        ]);
        expect(managed.preconditions.map((entry) => entry.code)).toEqual(['license_blocks_target']);
    });

    it('refuses nothing for target None and reads nothing for it', async () => {
        const { gate, fake } = makeGate(
            Object.assign(new FakeAppLicenseService(), {
                eligibility: eligibility({
                    yourCluster: 'attestationRequired',
                    managed: 'licenseNotGreen',
                }),
            }),
        );

        const result = await gate.evaluate({ workId: 'work-1', target: 'none' });

        expect(result.allowed).toBe(true);
        expect(result.preconditions).toEqual([]);
        expect(result.eligibility).toBeNull();
        // R-12: None runs nothing, so there is nothing to judge — and no read to make.
        expect(fake.reads).toEqual([]);
    });

    it('echoes the source offer without ever refusing over it', async () => {
        // §5.2's third row: `sourceOffer` "feeds §4.7 / T30" and produces no precondition.
        const offer: SourceOffer = { required: true, url: null, missing: true };
        const { gate } = makeGate(
            Object.assign(new FakeAppLicenseService(), {
                eligibility: eligibility({ sourceOffer: offer }),
            }),
        );

        const result = await gate.evaluate({ workId: 'work-1', target: 'your-cluster' });

        expect(result.sourceOffer).toEqual(offer);
        expect(result.allowed).toBe(true);
        expect(result.preconditions).toEqual([]);
    });
});

/* -------------------------------------------------------------------------- *
 * Freshness — ACC-06-39's "attestation re-required on license change"
 * -------------------------------------------------------------------------- */

describe('AppLicenseGate — a licence change re-requires the attestation', () => {
    it('answers from a fresh read every time, so a cleared record is seen immediately', async () => {
        const fake = new FakeAppLicenseService();
        fake.eligibility = eligibility();
        const { gate } = makeGate(fake);

        const before = await gate.evaluate({ workId: 'work-1', target: 'your-cluster' });
        expect(before.allowed).toBe(true);

        // The classified licence changed under us — APW-03 clears its own attestation and
        // this read, with no cache in between, is what makes the requirement come back.
        fake.eligibility = eligibility({ yourCluster: 'attestationRequired' });

        const after = await gate.evaluate({ workId: 'work-1', target: 'your-cluster' });

        expect(after.allowed).toBe(false);
        expect(after.preconditions.map((entry) => entry.code)).toEqual([
            'license_attestation_missing',
        ]);
        expect(fake.reads).toHaveLength(2);
    });

    it('passes the commit it is judging to APW-03, so the verdict and the spec share one commit', async () => {
        const { gate, fake } = makeGate();

        await gate.evaluate({ workId: 'work-1', target: 'your-cluster', commitSha: 'commit-b' });

        expect(fake.reads).toEqual([{ workId: 'work-1', commitSha: 'commit-b' }]);
    });

    it('asks for no particular commit when none was given', async () => {
        const { gate, fake } = makeGate();

        await gate.evaluate({ workId: 'work-1', target: 'your-cluster' });

        expect(fake.reads).toEqual([{ workId: 'work-1', commitSha: undefined }]);
    });
});

/* -------------------------------------------------------------------------- *
 * The unbound / unreadable answer
 * -------------------------------------------------------------------------- */

describe('AppLicenseGate — no verdict can be read', () => {
    it('refuses Ever Works Apps, because hosting somebody else’s code may not proceed unjudged', async () => {
        // The port is unbound: APW-03 has not landed in this process.
        const gate = new AppLicenseGate();

        const result = await gate.evaluate({ workId: 'work-1', target: 'ever-works-apps' });

        expect(result.allowed).toBe(false);
        expect(result.preconditions.map((entry) => entry.code)).toEqual(['license_blocks_target']);
        expect(result.warnings.map((warning) => warning.code)).toEqual([
            LICENSE_ELIGIBILITY_UNAVAILABLE,
        ]);
        expect(result.eligibility).toBeNull();
    });

    it('refuses nothing on Your cluster, and says that it judged nothing', async () => {
        // Wave 1 on infrastructure the owner controls: an unread classification is not
        // evidence of an amber one, and APW-01 takes the same posture for the same
        // missing service. The warning is the tell.
        const gate = new AppLicenseGate();

        const result = await gate.evaluate({ workId: 'work-1', target: 'your-cluster' });

        expect(result.allowed).toBe(true);
        expect(result.preconditions).toEqual([]);
        expect(result.warnings.map((warning) => warning.code)).toEqual([
            LICENSE_ELIGIBILITY_UNAVAILABLE,
        ]);
    });

    it('treats a throwing licence service as no verdict, not as a crash', async () => {
        const fake = Object.assign(new FakeAppLicenseService(), {
            failsWith: new Error('app-license database is unreachable'),
        });
        const { gate } = makeGate(fake);

        const unreadable = await gate.evaluate({ workId: 'work-1', target: 'ever-works-apps' });

        expect(unreadable.allowed).toBe(false);
        expect(unreadable.warnings.map((warning) => warning.code)).toEqual([
            LICENSE_ELIGIBILITY_UNAVAILABLE,
        ]);
    });

    it('never throws, whatever the licence service does', async () => {
        const broken = {
            getHostingEligibility: async () => {
                throw new Error('boom');
            },
        } as unknown as AppLicenseService;

        const gate = new AppLicenseGate(broken);

        await expect(gate.evaluate({ workId: 'w', target: 'your-cluster' })).resolves.toBeDefined();
        await expect(
            gate.evaluate({ workId: 'w', target: 'ever-works-apps' }),
        ).resolves.toBeDefined();
        await expect(gate.evaluate({ workId: 'w', target: 'none' })).resolves.toBeDefined();
    });
});

/* -------------------------------------------------------------------------- *
 * R-3 / ACC-06-39 — the gate stores nothing
 * -------------------------------------------------------------------------- */

describe('AppLicenseGate — R-3: read, never stored (ACC-06-39)', () => {
    it('makes no repository-shaped call on any path', async () => {
        const fake = Object.assign(new FakeAppLicenseService(), {
            eligibility: eligibility({
                yourCluster: 'attestationRequired',
                managed: 'licenseNotGreen',
            }),
        });
        const { gate } = makeGate(fake);

        for (const target of ['none', 'your-cluster', 'ever-works-apps'] as const) {
            await gate.evaluate({ workId: 'work-1', target });
        }

        expect(fake.writes).toEqual([]);
    });

    it('has no write path in its own source — and the scan reads real content', () => {
        const file = path.resolve(__dirname, '..', 'app-license-gate.ts');
        const source = fs.readFileSync(file, 'utf8');

        // Known-good control first: a scan that read nothing would "pass" the
        // assertions below for the wrong reason.
        expect(source).toContain('getHostingEligibility');

        // Comments talk about repositories on purpose (this file's docstring quotes
        // R-3), so the scan is over the code alone.
        const code = source
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '')
            .replace(/`[^`]*`/g, '``')
            .replace(/'[^']*'/g, "''");

        expect(code).toContain('class AppLicenseGate');
        expect(code).not.toMatch(/Repository|DataSource|@InjectRepository/);
        expect(code).not.toMatch(/\.(save|update|insert|upsert|delete)\s*\(/);
    });

    it('declares no attestation field of its own — the record is APW-03’s alone', () => {
        const file = path.resolve(__dirname, '..', 'app-license-gate.ts');
        const source = fs
            .readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');

        // The two codes are refusals, not storage: nothing here records who attested,
        // when, or against which text (R-3, C3).
        expect(source).not.toMatch(/attestation\s*[:=]\s*\{/);
        expect(source).not.toMatch(/\battestedAt\b|\btextSha256\b|\btextId\b/);
    });
});
