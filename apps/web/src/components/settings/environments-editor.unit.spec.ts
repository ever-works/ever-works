import { describe, expect, it } from 'vitest';
import { buildPayload, toEditorState } from './environments-editor';
import type { Environment } from '@/lib/api/environments';

/**
 * Environments editor serialization — the package fields round-trip on
 * EVERY edit (and previously on every row Publish), so a lossy separator
 * corrupts stored data without anyone touching the field.
 *
 * A pip requirement specifier may legally contain a comma
 * (`pandas>=2.0,<3.0` is ONE specifier, per PEP 508), which is why
 * newline is the only separator these two functions may use.
 */
function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
    return {
        id: 'env-1',
        userId: 'user-1',
        name: 'Python Data',
        slug: 'python-data',
        description: null,
        pipPackages: [],
        npmPackages: [],
        networkingMode: 'unrestricted',
        allowedHosts: null,
        allowPackageManagers: true,
        status: 'draft',
        availableInAllProjects: true,
        createdAt: '2026-08-14T10:00:00.000Z',
        updatedAt: '2026-08-14T10:00:00.000Z',
        ...overrides,
    };
}

describe('Environments editor package round-trip', () => {
    it('preserves a pip specifier containing a comma across load → save', () => {
        const environment = makeEnvironment({
            pipPackages: ['pandas>=2.0,<3.0', 'requests'],
            npmPackages: ['typescript'],
        });

        const payload = buildPayload(toEditorState(environment));

        expect(payload.pipPackages).toEqual(['pandas>=2.0,<3.0', 'requests']);
        expect(payload.npmPackages).toEqual(['typescript']);
    });

    it('is idempotent across repeated round-trips', () => {
        const environment = makeEnvironment({ pipPackages: ['uvicorn[standard]>=0.29,<1'] });

        const once = buildPayload(toEditorState(environment));
        const twice = buildPayload(toEditorState({ ...environment, ...once } as Environment));

        expect(twice.pipPackages).toEqual(['uvicorn[standard]>=0.29,<1']);
    });

    it('splits typed package lists on newlines only, trimming blanks', () => {
        const payload = buildPayload({
            id: null,
            name: '  Data  ',
            description: '',
            availableInAllProjects: true,
            pipPackages: 'pandas>=2.0,<3.0\n\n  requests  \n',
            npmPackages: '',
            networkingMode: 'unrestricted',
            allowedHosts: '',
            allowPackageManagers: true,
        });

        expect(payload.name).toBe('Data');
        // Emptied description clears the stored value rather than leaving it.
        expect(payload.description).toBeNull();
        expect(payload.pipPackages).toEqual(['pandas>=2.0,<3.0', 'requests']);
        expect(payload.npmPackages).toEqual([]);
        // Unrestricted rows send no host list at all.
        expect(payload.allowedHosts).toBeUndefined();
    });

    it('still accepts comma OR newline separated allowed hosts', () => {
        const payload = buildPayload({
            id: 'env-1',
            name: 'Limited',
            description: 'x',
            availableInAllProjects: false,
            pipPackages: '',
            npmPackages: '',
            networkingMode: 'limited',
            allowedHosts: 'api.anthropic.com, *.example.com\nregistry.npmjs.org',
            allowPackageManagers: false,
        });

        expect(payload.allowedHosts).toEqual([
            'api.anthropic.com',
            '*.example.com',
            'registry.npmjs.org',
        ]);
    });
});
