import { matchCheckoutWork, workRepositories } from '../checkout-remote-match';

describe('checkout → Work matching (FL-14 R-16, spec FR-6)', () => {
    const api = {
        id: 'w-api',
        name: 'API',
        sourceRepository: { url: 'https://github.com/acme/api', owner: 'acme', repo: 'api' },
    };
    const onPrem = {
        id: 'w-onprem',
        name: 'On-prem API',
        sourceRepository: { url: 'https://git.example.com/acme/api', owner: 'acme', repo: 'api' },
    };
    const installed = {
        id: 'w-web',
        name: 'Web',
        sourceRepository: {
            url: '',
            auth: { mode: 'github_app_installation', repoFullName: 'acme/web' },
        },
    };

    it('links a github.com remote to the Work naming that repository, in any remote form', () => {
        for (const remote of [
            'https://github.com/acme/api.git',
            'git@github.com:acme/api.git',
            'ssh://git@github.com/Acme/API',
        ]) {
            expect(matchCheckoutWork(remote, [api, onPrem])?.id).toBe('w-api');
        }
    });

    it('is host-aware: a same-named repository on another host links to its own Work only', () => {
        expect(matchCheckoutWork('https://git.example.com/acme/api', [api, onPrem])?.id).toBe(
            'w-onprem',
        );
        expect(matchCheckoutWork('https://gitlab.com/acme/api', [api, onPrem])).toBeNull();
    });

    it('reads a GitHub App installation repository by full name', () => {
        expect(workRepositories(installed)).toEqual([
            { host: 'github.com', owner: 'acme', repo: 'web', fullName: 'acme/web' },
        ]);
        expect(matchCheckoutWork('https://github.com/acme/web', [installed])?.id).toBe('w-web');
    });

    it('never links a remote that still carries a credential, or no remote at all', () => {
        expect(matchCheckoutWork('https://x:token@github.com/acme/api', [api])).toBeNull();
        expect(matchCheckoutWork(null, [api])).toBeNull();
    });
});
