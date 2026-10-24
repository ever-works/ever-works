import { readFleetMachineError } from '../../machine/fleet-machine.errors';
import { FleetGitIdentityService } from '../fleet-git-identity.service';

/**
 * FL-15 P2 — `FleetGitIdentityService` (spec FR-12 … FR-16, ACC-FL15-09/10)
 * against fakes of the machine port, the node registry and the account rows.
 *
 * What is pinned: the owner reads the values and everyone else set / unset;
 * the no-reply address is composed from the GitHub link, the account email is
 * the fallback; without `confirm` the answer is `confirmation_required`
 * naming the computer; only the owner sets; the machine is asked for exactly
 * name and email; the audit row carries the field names and never the email.
 */

const OWNER = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const NODE = '33333333-3333-4333-8333-333333333333';

function make(options: { githubLinked?: boolean; capabilities?: string[] } = {}) {
    const requests: Array<{ verb: string; params: Record<string, unknown> }> = [];
    const port = {
        authorize: jest.fn(async () => ({ id: NODE, userId: OWNER, name: 'design-mac' })),
        request: jest.fn(async (input: { verb: string; params: Record<string, unknown> }) => {
            requests.push({ verb: input.verb, params: input.params });
            if (input.verb === 'git.identity') {
                return {
                    result: {
                        name: { set: true, value: 'Your Name' },
                        email: { set: false },
                        helper: { present: true, value: 'osxkeychain' },
                        readAt: '2026-10-21T12:00:00.000Z',
                    },
                };
            }
            return {
                result: {
                    fields: ['user.name', 'user.email'],
                    name: { set: true, value: input.params.name },
                    email: { set: true, value: input.params.email },
                    helper: { present: false },
                },
            };
        }),
    };
    const nodes = {
        findById: jest.fn(async () => ({ id: NODE, capabilities: options.capabilities ?? ['git', 'git-push'] })),
    };
    const users = {
        findOne: jest.fn(async () => ({ id: OWNER, displayName: 'Your Name', username: 'you', email: 'you@example.com' })),
    };
    const links = {
        findOne: jest.fn(async () =>
            options.githubLinked === false ? null : { userId: OWNER, githubUserId: '12345', githubLogin: 'your-login' },
        ),
    };
    const installations = { find: jest.fn(async () => [{ id: 'inst-1', createdByUserId: OWNER }]) };
    const installationRepos = { find: jest.fn(async () => [{ fullName: 'acme/api' }, { fullName: 'acme/web' }]) };
    const audit = { tryRecord: jest.fn(async () => true) };
    const service = new FleetGitIdentityService(
        nodes as never,
        users as never,
        links as never,
        installations as never,
        installationRepos as never,
        port as never,
        audit as never,
    );
    return { service, port, audit, requests };
}

async function refusal(promise: Promise<unknown>) {
    try {
        await promise;
    } catch (error) {
        return readFleetMachineError(error);
    }
    throw new Error('expected a refusal');
}

describe('FleetGitIdentityService.read (FR-12, FR-13)', () => {
    it('shows the values to the owner, with push coverage', async () => {
        const { service } = make();
        const identity = await service.read(NODE, { kind: 'user', userId: OWNER });
        expect(identity.name).toEqual({ set: true, value: 'Your Name' });
        expect(identity.email).toEqual({ set: false });
        expect(identity.helper).toEqual({ present: true, value: 'osxkeychain' });
        expect(identity.canPushForAgents).toEqual({ ok: true, repositories: ['acme/api', 'acme/web'] });
    });

    it('shows set / unset only to anyone else', async () => {
        const { service } = make();
        const identity = await service.read(NODE, { kind: 'user', userId: MEMBER });
        expect(identity.name).toEqual({ set: true });
        expect(identity.helper).toEqual({ present: true });
    });

    it('says why Ever Works cannot push without the git-push tag', async () => {
        const { service } = make({ capabilities: ['git'] });
        const identity = await service.read(NODE, { kind: 'user', userId: OWNER });
        expect(identity.canPushForAgents.ok).toBe(false);
        expect(identity.canPushForAgents.reason).toContain('design-mac');
    });

    it('keeps the machine read for 60 seconds', async () => {
        const { service, port } = make();
        await service.read(NODE, { kind: 'user', userId: OWNER });
        await service.read(NODE, { kind: 'user', userId: OWNER });
        expect(port.request).toHaveBeenCalledTimes(1);
        await service.read(NODE, { kind: 'user', userId: OWNER }, { fresh: true });
        expect(port.request).toHaveBeenCalledTimes(2);
    });
});

describe('FleetGitIdentityService.set (FR-14, FR-15, S8)', () => {
    it('asks for confirmation naming the computer before anything runs', async () => {
        const { service, requests } = make();
        const error = await refusal(service.set(NODE, { kind: 'user', userId: OWNER }));
        expect(error?.code).toBe('confirmation_required');
        expect(error?.details).toEqual(
            expect.objectContaining({
                class: 'confirm',
                summary: 'Set the global Git identity on design-mac for every repository there?',
                email: '12345+your-login@users.noreply.github.com',
                emailSource: 'github-noreply',
            }),
        );
        expect(requests).toHaveLength(0);
    });

    it('sets exactly the name and the no-reply email, and audits field names only', async () => {
        const { service, requests, audit } = make();
        const result = await service.set(NODE, { kind: 'user', userId: OWNER }, { confirm: true });
        expect(requests).toEqual([
            {
                verb: 'git.setIdentity',
                params: { name: 'Your Name', email: '12345+your-login@users.noreply.github.com' },
            },
        ]);
        expect(result.fields).toEqual(['user.name', 'user.email']);
        const row = (audit.tryRecord.mock.calls[0] as unknown[])[0] as { action: string; details: Record<string, unknown> };
        expect(row.action).toBe('node.git.identity.set');
        expect(row.details.fields).toEqual(['user.name', 'user.email']);
        expect(JSON.stringify(row)).not.toContain('your-login@users');
    });

    it('falls back to the account email without a GitHub link', async () => {
        const { service } = make({ githubLinked: false });
        const error = await refusal(service.set(NODE, { kind: 'user', userId: OWNER }));
        expect(error?.details).toEqual(expect.objectContaining({ emailSource: 'account', email: 'you@example.com' }));
    });

    it('lets only the computer’s owner set it', async () => {
        const { service, requests } = make();
        const error = await refusal(service.set(NODE, { kind: 'user', userId: MEMBER }, { confirm: true }));
        expect(error?.code).toBe('permission_denied');
        expect(requests).toHaveLength(0);
    });
});
