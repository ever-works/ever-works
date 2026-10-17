import { LICENSE_EVIDENCE_MAX, LICENSE_MAX_FILE_READS } from '@ever-works/contracts';
import {
    applyMixed,
    detectRepositoryLicense,
    identifyLicenseText,
    licenseIdSet,
    manifestLicense,
    mixedDirectories,
} from '../license-detect';

/**
 * APW-03 T41 — repository licence detection: the mixed rule at depth 4 vs 5, the `ee/`
 * case (ACC-03-32), the read cap, the truncated tree, and no write.
 */

type Entry = { path: string; type: 'blob' | 'tree' };

function gitDouble(input: {
    licenseSpdx?: string | null;
    tree?: { entries: Entry[]; truncated: boolean } | null;
    treeMissing?: boolean;
    files?: Record<string, string>;
}) {
    const writes = {
        commitFiles: jest.fn(),
        createBranchFromSha: jest.fn(),
        createPullRequest: jest.fn(),
    };
    const git = {
        getRepository: jest.fn(async () =>
            'licenseSpdx' in input
                ? { fullName: 'o/r', licenseSpdx: input.licenseSpdx }
                : { fullName: 'o/r' },
        ),
        getRepositoryTree: input.treeMissing
            ? undefined
            : jest.fn(async () =>
                  input.tree === undefined ? { entries: [], truncated: false } : input.tree,
              ),
        getFileContent: jest.fn(async (_o: string, _r: string, path: string) =>
            input.files && path in input.files
                ? { content: input.files[path], encoding: 'utf-8' }
                : null,
        ),
        ...writes,
    };
    return { git, writes };
}

const base = {
    owner: 'o',
    repo: 'r',
    ref: 'sha-1',
    options: { userId: 'u', providerId: 'github' },
};

describe('license detection (APW-03 T41)', () => {
    describe('mixedDirectories', () => {
        it('counts a mixed segment at depth 4 and ignores one at depth 5', () => {
            expect(
                mixedDirectories([
                    { path: 'a/b/c/ee/x.ts', type: 'blob' },
                    { path: 'a/b/c/d/enterprise/y.ts', type: 'blob' },
                ]),
            ).toEqual(['a/b/c/ee']);
        });

        it('reads a directory entry and never a file name', () => {
            expect(
                mixedDirectories([
                    { path: 'premium', type: 'tree' },
                    { path: 'src/ee', type: 'blob' },
                ]),
            ).toEqual(['premium']);
        });
    });

    it('an `ee/` directory makes the repository mixed, with the path in evidence (ACC-03-32)', async () => {
        const { git } = gitDouble({
            licenseSpdx: 'MIT',
            tree: {
                entries: [
                    { path: 'LICENSE', type: 'blob' },
                    { path: 'ee', type: 'tree' },
                    { path: 'ee/billing.ts', type: 'blob' },
                ],
                truncated: false,
            },
        });

        const detection = await detectRepositoryLicense({ ...base, git: git as never });

        expect(detection).toMatchObject({ spdx: 'MIT', mixed: true, scanIncomplete: false });
        expect(detection.evidence.mixedPaths).toEqual(['ee']);
        expect(detection.evidence.files).toEqual(['LICENSE']);
        expect(applyMixed('green', detection.mixed)).toBe('amber');
    });

    it('a nested licence file counts as mixed only when it names a different licence', async () => {
        const { git } = gitDouble({
            licenseSpdx: 'MIT',
            tree: {
                entries: [
                    { path: 'packages/a/LICENSE', type: 'blob' },
                    { path: 'packages/b/LICENSE', type: 'blob' },
                ],
                truncated: false,
            },
            files: {
                'packages/a/LICENSE': 'MIT License\n\nCopyright (c) someone',
                'packages/b/LICENSE': 'Business Source License 1.1\n\nParameters …',
            },
        });

        const detection = await detectRepositoryLicense({ ...base, git: git as never });

        expect(detection.mixed).toBe(true);
        expect(detection.evidence.mixedPaths).toEqual(['packages/b/LICENSE']);
    });

    it('an unreadable nested licence file marks the scan incomplete, not "same licence"', async () => {
        const { git } = gitDouble({
            licenseSpdx: 'MIT',
            tree: { entries: [{ path: 'packages/a/LICENSE', type: 'blob' }], truncated: false },
            files: {},
        });

        const detection = await detectRepositoryLicense({ ...base, git: git as never });

        expect(detection.scanIncomplete).toBe(true);
        expect(detection.mixed).toBe(false);
    });

    it('compares licence ids, so a root expression covering the nested licence is not mixed', async () => {
        expect([...licenseIdSet('Apache-2.0 WITH LLVM-exception')]).toEqual(['apache-2.0']);
        expect([...licenseIdSet('MIT OR Apache-2.0')].sort()).toEqual(['apache-2.0', 'mit']);
        const { git } = gitDouble({
            licenseSpdx: 'MIT OR Apache-2.0',
            tree: { entries: [{ path: 'packages/a/LICENSE', type: 'blob' }], truncated: false },
            files: { 'packages/a/LICENSE': 'MIT License\n\nCopyright (c) someone' },
        });

        const detection = await detectRepositoryLicense({ ...base, git: git as never });

        expect(detection.mixed).toBe(false);
    });

    it('fills a missing provider licence from the root text, then the manifests', async () => {
        const fromText = gitDouble({
            tree: { entries: [{ path: 'LICENSE.md', type: 'blob' }], truncated: false },
            files: { 'LICENSE.md': '# Apache License, Version 2.0\n' },
        });
        await expect(
            detectRepositoryLicense({ ...base, git: fromText.git as never }),
        ).resolves.toMatchObject({ spdx: 'Apache-2.0', mixed: false });

        const fromManifest = gitDouble({
            tree: { entries: [{ path: 'package.json', type: 'blob' }], truncated: false },
            files: { 'package.json': JSON.stringify({ name: 'x', license: 'BUSL-1.1' }) },
        });
        await expect(
            detectRepositoryLicense({ ...base, git: fromManifest.git as never }),
        ).resolves.toMatchObject({ spdx: 'BUSL-1.1' });
    });

    it('keeps NOASSERTION when the provider could not name the licence and nothing else does', async () => {
        const { git } = gitDouble({ licenseSpdx: null, tree: { entries: [], truncated: false } });
        await expect(
            detectRepositoryLicense({ ...base, git: git as never }),
        ).resolves.toMatchObject({
            spdx: 'NOASSERTION',
        });
    });

    it('a truncated or missing tree is scanIncomplete, never "nothing there"', async () => {
        const truncated = gitDouble({ licenseSpdx: 'MIT', tree: { entries: [], truncated: true } });
        await expect(
            detectRepositoryLicense({ ...base, git: truncated.git as never }),
        ).resolves.toMatchObject({ scanIncomplete: true });

        const missing = gitDouble({ licenseSpdx: 'MIT', treeMissing: true });
        await expect(
            detectRepositoryLicense({ ...base, git: missing.git as never }),
        ).resolves.toMatchObject({ spdx: 'MIT', scanIncomplete: true });
    });

    it('makes at most 12 file reads, caps evidence, and writes nothing', async () => {
        const entries: Entry[] = [];
        const files: Record<string, string> = {};
        for (let index = 0; index < 40; index += 1) {
            entries.push({ path: `vendor/p${index}/LICENSE`, type: 'blob' });
            files[`vendor/p${index}/LICENSE`] = 'Business Source License 1.1';
        }
        const { git, writes } = gitDouble({
            licenseSpdx: 'MIT',
            tree: { entries, truncated: false },
            files,
        });

        const detection = await detectRepositoryLicense({ ...base, git: git as never });

        expect(LICENSE_MAX_FILE_READS).toBe(12);
        expect(git.getFileContent.mock.calls.length).toBeLessThanOrEqual(LICENSE_MAX_FILE_READS);
        expect(detection.fileReads).toBe(12);
        expect(detection.evidence.mixedPaths.length).toBeLessThanOrEqual(LICENSE_EVIDENCE_MAX);
        // 28 nested licence files were never read, so the verdict says so.
        expect(detection.scanIncomplete).toBe(true);
        for (const write of Object.values(writes)) {
            expect(write).not.toHaveBeenCalled();
        }
    });

    describe('pure helpers', () => {
        it('identifyLicenseText prefers a header tag, then the longest registry name', () => {
            expect(identifyLicenseText('// SPDX-License-Identifier: AGPL-3.0-only\n')).toBe(
                'AGPL-3.0-only',
            );
            expect(identifyLicenseText('The MIT License (MIT)\n')).toBe('MIT');
            expect(identifyLicenseText('All rights reserved.')).toBeNull();
        });

        it('manifestLicense reads the four manifests', () => {
            expect(manifestLicense('package.json', '{"license":"MIT"}')).toBe('MIT');
            expect(manifestLicense('package.json', '{"license":"UNLICENSED"}')).toBeNull();
            expect(manifestLicense('composer.json', '{"license":["MIT","Apache-2.0"]}')).toBe(
                'MIT OR Apache-2.0',
            );
            expect(
                manifestLicense(
                    'Cargo.toml',
                    '[package]\nname = "x"\nlicense = "MIT OR Apache-2.0"\n',
                ),
            ).toBe('MIT OR Apache-2.0');
            expect(
                manifestLicense('pyproject.toml', '[project]\nlicense = { text = "BUSL-1.1" }\n'),
            ).toBe('BUSL-1.1');
            expect(manifestLicense('pyproject.toml', '[tool.x]\nlicense = "MIT"\n')).toBeNull();
        });

        it('applyMixed raises green to amber and leaves the rest', () => {
            expect(applyMixed('green', false)).toBe('green');
            expect(applyMixed('amber', true)).toBe('amber');
            expect(applyMixed('red', true)).toBe('red');
            expect(applyMixed('unknown', true)).toBe('unknown');
        });
    });
});
