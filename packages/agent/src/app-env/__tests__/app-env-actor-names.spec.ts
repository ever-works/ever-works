import { appEnvActorNames, type AppEnvActorNameSources } from '../app-env-actor-names';

/**
 * Lane aw-builds-bindings (2026-10-27) — `APP_ENV_ACTOR_NAMES`, the "Set · by Maya" read.
 * Only the Work's owner or a member is named, by display name or username, never by email.
 */
describe('appEnvActorNames', () => {
    const users: Record<string, { displayName?: string | null; username?: string | null; email?: string }> = {
        owner: { displayName: 'Maya', username: 'maya', email: 'maya@example.invalid' },
        member: { displayName: null, username: 'sam', email: 'sam@example.invalid' },
        stranger: { displayName: 'Eve', username: 'eve', email: 'eve@example.invalid' },
        blank: { displayName: '  ', username: '', email: 'blank@example.invalid' },
    };

    function sources(over: Partial<AppEnvActorNameSources> = {}): AppEnvActorNameSources {
        return {
            works: () => ({ findById: async (id) => (id === 'w1' ? { userId: 'owner' } : null) }),
            members: () => ({
                findMember: async (workId, userId) =>
                    workId === 'w1' && (userId === 'member' || userId === 'blank') ? { userId } : null,
            }),
            users: () => ({ findById: async (id) => users[id] ?? null }),
            ...over,
        };
    }

    it('names the owner by display name and a member by username', async () => {
        const names = appEnvActorNames(sources());
        await expect(names.nameOf('w1', 'owner')).resolves.toBe('Maya');
        await expect(names.nameOf('w1', 'member')).resolves.toBe('sam');
    });

    it('never names someone with no relationship to the Work, and never returns an email', async () => {
        const names = appEnvActorNames(sources());
        await expect(names.nameOf('w1', 'stranger')).resolves.toBeNull();
        await expect(names.nameOf('w1', 'blank')).resolves.toBeNull();
        await expect(names.nameOf('w-unknown', 'owner')).resolves.toBeNull();
    });

    it('answers null when a repository is not bound in this process', async () => {
        await expect(
            appEnvActorNames(sources({ users: () => undefined })).nameOf('w1', 'owner'),
        ).resolves.toBeNull();
        await expect(
            appEnvActorNames(sources({ works: () => undefined })).nameOf('w1', 'owner'),
        ).resolves.toBeNull();
        // No member store: only the owner can be named.
        const ownerOnly = appEnvActorNames(sources({ members: () => undefined }));
        await expect(ownerOnly.nameOf('w1', 'owner')).resolves.toBe('Maya');
        await expect(ownerOnly.nameOf('w1', 'member')).resolves.toBeNull();
    });
});
