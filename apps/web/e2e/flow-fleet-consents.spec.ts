import { test, expect } from '@playwright/test';
import { FLEET_HUB_ON, freshFleetUser, signedInFleetUser } from './helpers/fleet-hub';
import {
    FLEET_LINK_ON,
    NO_CONSENTS,
    beatWithConsents,
    enrollLinkNode,
    helloFor,
    mintLinkToken,
    openLinkSocket,
} from './helpers/fleet-link';

/**
 * Fleet node link (FL-02, T-18, spec §5.1, §5.2, S1, S2) — the computer page
 * against a REAL enrolled node whose heartbeat reports its consents:
 *
 *  - the Overview's consents card ticks what the node allows and gives the
 *    exact command for what it does not (keeping the others), copyable;
 *  - the header's link line says what the platform's own socket sees — not
 *    open (or not accepted, with the link flag off) before the node links,
 *    and "connected · work · manage" once a link is up.
 *
 * Skips unless the web server under test runs with `FLEET_HUB_ENABLED=true`;
 * the connected case also needs `FLEET_NODE_LINK_ENABLED=true` on the API.
 */

test.describe('Fleet node link — consents and the link line on the computer page', () => {
    test.skip(!FLEET_HUB_ON, 'FLEET_HUB_ENABLED is not on for this run');

    test('the consents card names the missing consent with its command (S1, §5.2)', async ({
        browser,
        request,
    }) => {
        const u = await freshFleetUser(request);
        const node = await enrollLinkNode(request, u.access_token);
        await beatWithConsents(request, node, { ...NO_CONSENTS, work: true, manage: true });
        const { page, close } = await signedInFleetUser(browser, u);
        try {
            await page.goto(`/en/fleet/computers/${node.nodeId}`, { waitUntil: 'networkidle' });
            const card = page.getByTestId('fleet-consents-card');
            await expect(card).toContainText(`What ${node.name} lets Ever Works do`);
            await expect(page.getByTestId('fleet-consent-work')).toHaveAttribute(
                'data-granted',
                'true',
            );
            await expect(page.getByTestId('fleet-consent-attend')).toHaveAttribute(
                'data-granted',
                'false',
            );
            await expect(page.getByTestId('fleet-consent-manage')).toHaveAttribute(
                'data-granted',
                'true',
            );
            await expect(page.getByTestId('fleet-consent-command-attend-text')).toHaveText(
                'ever-works-node start --work --attend --manage',
            );
            await expect(page.getByTestId('fleet-consent-command-attend-copy')).toBeVisible();

            // No link yet: the line says so, and names the flag that is off.
            const line = page.getByTestId('fleet-computer-link');
            await expect(line).toHaveAttribute(
                'data-state',
                FLEET_LINK_ON ? 'not-open' : 'refused',
            );
            if (FLEET_LINK_ON) {
                await expect(page.getByTestId('fleet-computer-link-missing')).toContainText(
                    '--attend off',
                );
            }
        } finally {
            await close();
        }
    });

    test('an enrolled-only computer says it only reports health (S2)', async ({
        browser,
        request,
    }) => {
        test.skip(!FLEET_LINK_ON, 'the link line reads "not accepted" while links are off');
        const u = await freshFleetUser(request);
        const node = await enrollLinkNode(request, u.access_token);
        await beatWithConsents(request, node, NO_CONSENTS);
        const { page, close } = await signedInFleetUser(browser, u);
        try {
            await page.goto(`/en/fleet/computers/${node.nodeId}`, { waitUntil: 'networkidle' });
            await expect(page.getByTestId('fleet-computer-link-state')).toHaveText(
                'not open — this computer only reports health',
            );
            for (const key of ['work', 'attend', 'manage']) {
                await expect(page.getByTestId(`fleet-consent-${key}`)).toHaveAttribute(
                    'data-granted',
                    'false',
                );
                await expect(page.getByTestId(`fleet-consent-command-${key}`)).toBeVisible();
            }
        } finally {
            await close();
        }
    });

    test('with the node linked, the line reads connected with its consents (S1, FR-42)', async ({
        browser,
        request,
    }) => {
        test.skip(!FLEET_LINK_ON, 'FLEET_NODE_LINK_ENABLED is not on for this run');
        const consents = { ...NO_CONSENTS, work: true, manage: true };
        const u = await freshFleetUser(request);
        const node = await enrollLinkNode(request, u.access_token);
        await beatWithConsents(request, node, consents);
        const { token } = (await (await mintLinkToken(request, node)).json()) as { token: string };
        const link = await openLinkSocket();
        const { page, close } = await signedInFleetUser(browser, u);
        try {
            link.send(helloFor(node, token, consents));
            await link.until('link.ready');
            await page.goto(`/en/fleet/computers/${node.nodeId}`, { waitUntil: 'networkidle' });
            const line = page.getByTestId('fleet-computer-link');
            await expect(line).toHaveAttribute('data-state', 'connected');
            await expect(page.getByTestId('fleet-computer-link-state')).toHaveText('connected');
            await expect(page.getByTestId('fleet-computer-link-consent-work')).toBeVisible();
            await expect(page.getByTestId('fleet-computer-link-consent-manage')).toBeVisible();
            await expect(page.getByTestId('fleet-computer-link-consent-attend')).toHaveCount(0);
        } finally {
            link.close();
            await close();
        }
    });
});
