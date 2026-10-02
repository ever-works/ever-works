import { EVER_STATS_V1_SOURCE } from '@ever-works/contracts';
import { EVER_STATS_V1_SCHEMA } from '@ever-works/agent/ever-instance';
import { contractBytes, contractJson, sha256, type VendorRecord } from './contract-files';

/**
 * The vendored contract is the published one, byte for byte: the schema's
 * SHA-256 equals the value Ever Platform publishes (and the SDK records), every
 * fixture equals what was vendored, and the schema the validator compiles is
 * the very file that was hashed.
 */
describe('vendored ever.stats.v1 contract — drift', () => {
    const vendor = contractJson<VendorRecord>('VENDOR.json');

    it('the schema file hashes to the published SHA-256', () => {
        const hash = sha256(contractBytes(vendor.schema.path));
        expect(hash).toBe(EVER_STATS_V1_SOURCE.sha256);
        expect(hash).toBe(vendor.schema.sha256);
        expect(contractBytes('ever.stats.v1.sha256').toString('utf8').trim()).toBe(hash);
    });

    it('records the same public source everywhere', () => {
        expect(vendor.repository).toBe(EVER_STATS_V1_SOURCE.repository);
        expect(vendor.commit).toBe(EVER_STATS_V1_SOURCE.commit);
        expect(vendor.schema.source).toBe(EVER_STATS_V1_SOURCE.path);
        // A public repository pinned by a full commit SHA — never a branch name.
        expect(vendor.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(vendor.repository).toMatch(/^https:\/\/github\.com\/ever-co\//);
    });

    it.each(
        contractJson<VendorRecord>('VENDOR.json').fixtures.map((fixture) => [
            fixture.path,
            fixture.sha256,
        ]),
    )('%s is unchanged since it was vendored', (path, expected) => {
        expect(sha256(contractBytes(path))).toBe(expected);
    });

    it('the validator compiles exactly the hashed file', () => {
        expect(EVER_STATS_V1_SCHEMA).toEqual(contractJson(vendor.schema.path));
    });

    it('control: a one-byte change is a different hash', () => {
        const bytes = Buffer.from(contractBytes(vendor.schema.path));
        bytes[bytes.length - 2] = bytes[bytes.length - 2] ^ 0x01;
        expect(sha256(bytes)).not.toBe(EVER_STATS_V1_SOURCE.sha256);
    });
});
