import { lastValueFrom, of } from 'rxjs';
import { EverIdProvidersInterceptor } from './ever-id-providers.interceptor';

/**
 * APW-12 (Ever ID, FR-6, ACC-12-05) — `GET /api/auth/providers` keeps every
 * existing field and gains exactly one: `everId: { enabled, displayName }`.
 */
describe('EverIdProvidersInterceptor', () => {
    const existing = { emailPassword: true, magicLink: false, socialProviders: ['github'] };

    async function run(facade: Record<string, jest.Mock>, body: unknown = existing) {
        const interceptor = new EverIdProvidersInterceptor(facade as never);
        return lastValueFrom(interceptor.intercept({} as never, { handle: () => of(body) }));
    }

    it('adds everId.enabled = false and the default name while Ever ID is off, without asking for the display name', async () => {
        const facade = {
            isAvailable: jest.fn().mockResolvedValue(false),
            getDisplayName: jest.fn(),
        };

        await expect(run(facade)).resolves.toEqual({
            ...existing,
            everId: { enabled: false, displayName: 'Ever ID' },
        });
        expect(facade.getDisplayName).not.toHaveBeenCalled();
    });

    it('adds the configured display name when available', async () => {
        const facade = {
            isAvailable: jest.fn().mockResolvedValue(true),
            getDisplayName: jest.fn().mockResolvedValue('Example ID'),
        };

        await expect(run(facade)).resolves.toEqual({
            ...existing,
            everId: { enabled: true, displayName: 'Example ID' },
        });
    });

    it('answers enabled = false when the state cannot be read', async () => {
        const facade = {
            isAvailable: jest.fn().mockRejectedValue(new Error('db down')),
            getDisplayName: jest.fn(),
        };

        await expect(run(facade)).resolves.toMatchObject({ everId: { enabled: false } });
    });

    it('passes a non-object body through untouched', async () => {
        const facade = { isAvailable: jest.fn(), getDisplayName: jest.fn() };
        await expect(run(facade, 'text')).resolves.toBe('text');
        expect(facade.isAvailable).not.toHaveBeenCalled();
    });
});
