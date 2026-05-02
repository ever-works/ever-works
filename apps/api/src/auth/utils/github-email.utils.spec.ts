import { resolveGitHubAccountEmail } from './github-email.utils';
import { of } from 'rxjs';

describe('resolveGitHubAccountEmail', () => {
    const createHttpService = (
        emails: Array<{ email: string; primary?: boolean; verified?: boolean }>,
    ) =>
        ({
            get: jest.fn().mockReturnValue(
                of({
                    data: emails,
                }),
            ),
        }) as any;

    it('prefers a verified email from /user/emails over an unverified public profile email', async () => {
        const httpService = createHttpService([
            {
                email: 'public@example.com',
                primary: false,
                verified: false,
            },
            {
                email: 'verified@example.com',
                primary: true,
                verified: true,
            },
        ]);

        const result = await resolveGitHubAccountEmail(httpService, 'token', 'public@example.com');

        expect(result).toEqual({
            email: 'verified@example.com',
            emailVerified: true,
        });
    });

    it('keeps the profile email but marks it unverified when no verified GitHub email exists', async () => {
        const httpService = createHttpService([
            {
                email: 'public@example.com',
                primary: true,
                verified: false,
            },
        ]);

        const result = await resolveGitHubAccountEmail(httpService, 'token', 'public@example.com');

        expect(result).toEqual({
            email: 'public@example.com',
            emailVerified: false,
        });
    });

    it('returns the verified primary email when the profile endpoint has no email', async () => {
        const httpService = createHttpService([
            {
                email: 'primary@example.com',
                primary: true,
                verified: true,
            },
        ]);

        const result = await resolveGitHubAccountEmail(httpService, 'token', null);

        expect(result).toEqual({
            email: 'primary@example.com',
            emailVerified: true,
        });
    });
});
