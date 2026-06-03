/**
 * EW-693 / EW-704 — decouple the API from distributable storage plugins.
 *
 * The API's runtime dependency on `@ever-works/aws-s3-plugin`,
 * `@ever-works/minio-plugin`, and `@ever-works/github-storage-plugin`
 * was moved to `devDependencies` so the production image no longer
 * carries them in `bundled` mode and a dynamic-mode deployment can
 * runtime-install them on demand. `local-fs` (a `systemPlugin`) stays
 * bundled as the boot default so the API boots with working storage
 * even when no distributable storage backend is configured (FR-4).
 *
 * What this spec pins (cheap, no real plugin instantiation needed):
 *
 * 1. `resolveStorageBackendId()` defaults to `'local-fs'` when
 *    `STORAGE_BACKEND` is unset — i.e. a fresh deployment with no
 *    config gets the bundled core backend, not a distributable one.
 * 2. `resolveStorageBackendId()` accepts the three legacy ids
 *    case-insensitively (existing behaviour, must not regress).
 * 3. `resolveStorageBackendId()` rejects unknown ids with a clear
 *    error — pinned so a future "silently fall back to local-fs"
 *    tweak (which would hide a misconfiguration) is a deliberate diff.
 *
 * Heavier "factory does not touch distributable plugins when
 * STORAGE_BACKEND=local-fs" is covered by the existing factory
 * integration in dev/CI (the LocalFsStoragePlugin is statically
 * imported; the others go through `await import()` and have no
 * static analyzer reachable from local-fs).
 */
import { resolveStorageBackendId } from './storage-backend.factory';

describe('storage-backend.factory (EW-693 / EW-704)', () => {
    const originalEnv = process.env.STORAGE_BACKEND;

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env.STORAGE_BACKEND;
        } else {
            process.env.STORAGE_BACKEND = originalEnv;
        }
    });

    describe('resolveStorageBackendId', () => {
        it('defaults to local-fs when STORAGE_BACKEND is unset (boot-default invariant)', () => {
            delete process.env.STORAGE_BACKEND;
            expect(resolveStorageBackendId()).toBe('local-fs');
        });

        it('defaults to local-fs when STORAGE_BACKEND is empty string', () => {
            process.env.STORAGE_BACKEND = '';
            expect(resolveStorageBackendId()).toBe('local-fs');
        });

        it.each([
            ['local-fs', 'local-fs'],
            ['LOCAL-FS', 'local-fs'],
            ['Local-Fs', 'local-fs'],
            ['aws-s3', 'aws-s3'],
            ['AWS-S3', 'aws-s3'],
            ['minio', 'minio'],
            ['MINIO', 'minio'],
            ['github-storage', 'github-storage'],
            ['GitHub-Storage', 'github-storage'],
        ])('accepts %p (case-insensitive) and returns %p', (raw, expected) => {
            process.env.STORAGE_BACKEND = raw;
            expect(resolveStorageBackendId()).toBe(expected);
        });

        it('throws on an unknown backend id (no silent fallback)', () => {
            process.env.STORAGE_BACKEND = 'azure-blob';
            expect(() => resolveStorageBackendId()).toThrow(/STORAGE_BACKEND="azure-blob"/);
        });

        it('error message enumerates the four legal values', () => {
            process.env.STORAGE_BACKEND = 'nope';
            expect(() => resolveStorageBackendId()).toThrow(
                /local-fs, aws-s3, minio, github-storage/,
            );
        });
    });
});
