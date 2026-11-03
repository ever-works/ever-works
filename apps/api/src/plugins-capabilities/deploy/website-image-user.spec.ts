import { resolveWebsiteImageUser } from './website-image-user';

describe('resolveWebsiteImageUser', () => {
    it.each([
        ['ever-works', 'directory-web-template'],
        ['ever-works', 'web-template'],
        ['Ever-Works', 'Directory-Web-Template'],
    ])('%s/%s (Next.js, `USER node`) → 1000:1000', (owner, repo) => {
        expect(resolveWebsiteImageUser({ owner, repo })).toEqual({ uid: 1000, gid: 1000 });
    });

    // Stock nginx starts as root: forcing a user (or dropping ALL capabilities) crash-loops it.
    it.each([
        ['ever-works', 'directory-web-minimal-template'],
        ['ever-works', 'web-minimal-template'],
        // A fork or a custom catalog template: its Dockerfile is not ours to vouch for.
        ['someone-else', 'directory-web-template'],
        ['ever-works', 'my-custom-template'],
    ])('%s/%s → no forced user', (owner, repo) => {
        expect(resolveWebsiteImageUser({ owner, repo })).toBeNull();
    });

    it('answers null for a template without owner / repo', () => {
        expect(resolveWebsiteImageUser(null)).toBeNull();
        expect(resolveWebsiteImageUser(undefined)).toBeNull();
        expect(resolveWebsiteImageUser({ branch: 'main' } as never)).toBeNull();
        expect(resolveWebsiteImageUser({ owner: 'ever-works', repo: '' })).toBeNull();
    });
});
