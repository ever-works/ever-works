import { expect, test } from '@playwright/test';

test('renders the unprefixed login route behind an ingress authority', async ({ request }) => {
    const forwardedHost = process.env.SMOKE_FORWARDED_HOST;
    const response = await request.get('/login', {
        headers: forwardedHost
            ? {
                  host: forwardedHost,
                  'x-forwarded-host': forwardedHost,
                  'x-forwarded-proto': 'https',
              }
            : undefined,
        maxRedirects: 0,
    });

    expect(response.status()).toBe(200);
    expect(response.headers().location).toBeUndefined();
    await expect(response.text()).resolves.toContain('Sign In');
});
