import { readFileSync } from 'fs';
import { join } from 'path';
import { CONSTANTS, SCHEMAS } from '@ever-co/connect-contracts';
import { SDK_VERSION } from '@ever-co/connect-sdk';
import { EVER_STATS_V1_SOURCE } from '@ever-works/contracts';
import { contractBytes, contractJson, sha256 } from './contract-files.helper-spec';

/**
 * The statistics contract is the published package, pinned: the schema file of
 * the installed `@ever-co/connect-contracts` hashes to the SHA-256 this module
 * was built against (the value Ever Platform publishes), the schema the SDK
 * validates with is that very file, and every manifest that depends on the
 * Ever Connect packages pins the same exact version, the one installed.
 *
 * A version bump that changes the schema therefore fails here until
 * `EVER_STATS_V1_SOURCE` is updated on purpose, with the golden and canary
 * tests run against the new schema.
 */
const REPO = join(__dirname, '..', '..', '..', '..', '..');

/** Every manifest that names an Ever Connect package, and the packages it names. */
const MANIFESTS: ReadonlyArray<[string, string[]]> = [
    ['packages/contracts/package.json', ['@ever-co/connect-contracts']],
    ['packages/agent/package.json', ['@ever-co/connect-sdk']],
    ['apps/api/package.json', ['@ever-co/connect-sdk', '@ever-co/connect-contracts']],
    ['tools/egress-audit/package.json', ['@ever-co/connect-tools']],
];

function pinnedVersion(manifest: string, name: string): string | undefined {
    const json = JSON.parse(readFileSync(join(REPO, manifest), 'utf8')) as Record<
        string,
        Record<string, string> | undefined
    >;
    return json.dependencies?.[name] ?? json.devDependencies?.[name];
}

describe('ever.stats.v1 contract — the pinned package, no drift', () => {
    const installed = contractJson<{ name: string; version: string }>('package.json');

    it('the installed schema file hashes to the SHA-256 this module was built against', () => {
        expect(installed.name).toBe(EVER_STATS_V1_SOURCE.package);
        expect(sha256(contractBytes(EVER_STATS_V1_SOURCE.path))).toBe(EVER_STATS_V1_SOURCE.sha256);
    });

    it('the schema the SDK validates with is exactly the hashed file', () => {
        expect(SCHEMAS.stats).toEqual(contractJson(EVER_STATS_V1_SOURCE.path));
    });

    it.each(MANIFESTS.flatMap(([manifest, names]) => names.map((name) => [manifest, name])))(
        '%s pins %s to the exact installed version',
        (manifest, name) => {
            // An exact version: no range, so every install verifies with the same code.
            expect(pinnedVersion(manifest, name)).toBe(installed.version);
        },
    );

    it('the SDK and the contracts are the same release', () => {
        expect(SDK_VERSION).toBe(installed.version);
        expect(CONSTANTS.contracts_version).toBe(installed.version);
    });

    it('control: a one-byte change is a different hash', () => {
        const bytes = Buffer.from(contractBytes(EVER_STATS_V1_SOURCE.path));
        bytes[bytes.length - 2] = bytes[bytes.length - 2] ^ 0x01;
        expect(sha256(bytes)).not.toBe(EVER_STATS_V1_SOURCE.sha256);
    });
});
