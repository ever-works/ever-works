import {
    bareSenderAddress,
    inboundEmailAutoDispatchAll,
    isTrustedSender,
    senderAuthVerdict,
} from '../inbound-email-trust';

/** Prompt-injection hardening — the one trusted-sender rule for inbound email (reviews of #2769). */
describe('inbound email trusted-sender rule', () => {
    const owner = ['Owner <owner@acme.test>'];
    const env = { INBOUND_EMAIL_AUTHSERV_ID: 'mx.provider.test' };
    const ar = (value: string, ...more: string[]) => ({
        headers: [
            { Name: 'Authentication-Results', Value: value },
            ...more.map((v) => ({ Name: 'Authentication-Results', Value: v })),
        ],
    });

    describe('senderAuthVerdict — only the provider-stamped verdict counts', () => {
        it('reads the TOPMOST Authentication-Results with the configured authserv-id', () => {
            expect(
                senderAuthVerdict(
                    ar('mx.provider.test; dkim=pass header.d=acme.test; spf=none'),
                    'owner@acme.test',
                    env,
                ),
            ).toBe('pass');
        });

        it('FORGED header vs real fail: a lower, sender-written dmarc=pass never beats the stamped fail', () => {
            const metadata = ar(
                'mx.provider.test; spf=fail smtp.mailfrom=acme.test; dkim=none',
                'x; dmarc=pass header.from=acme.test',
            );
            expect(senderAuthVerdict(metadata, 'owner@acme.test', env)).toBe('fail');
            expect(senderAuthVerdict({ ...metadata, dmarc: 'fail' }, 'owner@acme.test', env)).toBe(
                'fail',
            );
        });

        it('ignores an Authentication-Results whose authserv-id is not the configured one (sender-written)', () => {
            // With an authserv-id configured, a message without its stamp has a MISSING
            // verdict: unverified, never the spelling-alone "none" (integration API gates lane).
            expect(senderAuthVerdict(ar('attacker.test; dmarc=pass'), 'owner@acme.test', env)).toBe(
                'unverified',
            );
            // And reads no header at all without a configured authserv-id.
            expect(
                senderAuthVerdict(ar('mx.provider.test; dmarc=pass'), 'owner@acme.test', {}),
            ).toBe('none');
        });

        it('never reads Received-SPF (any position is sender-writable)', () => {
            expect(
                senderAuthVerdict(
                    { headers: [{ Name: 'Received-SPF', Value: 'Pass' }] },
                    'owner@acme.test',
                    env,
                ),
            ).toBe('unverified');
            expect(
                senderAuthVerdict(
                    { headers: [{ Name: 'Received-SPF', Value: 'Pass' }] },
                    'owner@acme.test',
                    {},
                ),
            ).toBe('none');
        });

        it('UNALIGNED SPF pass is unverified, not a pass', () => {
            expect(
                senderAuthVerdict(
                    ar('mx.provider.test; spf=pass smtp.mailfrom=bounce@bulk-mailer.test'),
                    'owner@acme.test',
                    env,
                ),
            ).toBe('unverified');
            expect(
                senderAuthVerdict(
                    { dkim: 'pass', dkimDomain: 'evil.test' },
                    'owner@acme.test',
                    env,
                ),
            ).toBe('unverified');
            expect(senderAuthVerdict({ spf: 'pass' }, 'owner@acme.test', env)).toBe('unverified');
        });

        it('accepts relaxed alignment and a provider DMARC pass; any fail wins', () => {
            expect(
                senderAuthVerdict(
                    { dkim: 'pass', dkimDomain: 'mail.acme.test' },
                    'owner@acme.test',
                    env,
                ),
            ).toBe('pass');
            expect(senderAuthVerdict({ dmarc: 'pass' }, 'owner@acme.test', env)).toBe('pass');
            expect(
                senderAuthVerdict({ dmarc: 'pass', spf: 'softfail' }, 'owner@acme.test', env),
            ).toBe('fail');
            expect(senderAuthVerdict(undefined, 'owner@acme.test', {})).toBe('none');
        });

        // Works-security lane (integration API gates, finding 4) — with
        // INBOUND_EMAIL_AUTHSERV_ID set the receiving server stamps every message, so a
        // message carrying no verdict at all is unverified, not "none".
        it('a configured authserv-id turns a missing verdict into unverified', () => {
            expect(senderAuthVerdict(undefined, 'owner@acme.test', env)).toBe('unverified');
            expect(senderAuthVerdict({ headers: [] }, 'owner@acme.test', env)).toBe('unverified');
            expect(senderAuthVerdict({ headers: [] }, 'owner@acme.test', {})).toBe('none');
            // A stamp with the right id that reports nothing passed is unverified too.
            expect(senderAuthVerdict(ar('mx.provider.test; none'), 'owner@acme.test', env)).toBe(
                'unverified',
            );
        });
    });

    describe('isTrustedSender', () => {
        const pass = { dkim: 'pass', dkimDomain: 'acme.test' };

        it('an owner sending address needs an aligned pass', () => {
            expect(
                isTrustedSender({
                    from: 'OWNER@acme.test',
                    ownerAddresses: owner,
                    metadata: pass,
                    env,
                }),
            ).toBe(true);
            expect(isTrustedSender({ from: 'owner@acme.test', ownerAddresses: owner, env })).toBe(
                false,
            );
        });

        it('platform-sent agent-to-agent mail is trusted unless authentication failed', () => {
            expect(
                isTrustedSender({
                    from: 'ops@agents.test',
                    ownerAddresses: [],
                    platformSent: true,
                    env,
                }),
            ).toBe(true);
            expect(
                isTrustedSender({
                    from: 'ops@agents.test',
                    ownerAddresses: [],
                    platformSent: true,
                    metadata: { spf: 'fail' },
                    env,
                }),
            ).toBe(false);
        });

        it('a listed sender: pass when a verdict is reported, spelling alone only when none is', () => {
            // No authserv-id: the provider reports no verdict, so the spelling decides.
            const listed = {
                INBOUND_EMAIL_TRUSTED_SENDERS: 'ops@partner.test, @client.test',
            };
            expect(
                isTrustedSender({ from: 'ops@partner.test', ownerAddresses: [], env: listed }),
            ).toBe(true);
            expect(
                isTrustedSender({ from: 'anyone@client.test', ownerAddresses: [], env: listed }),
            ).toBe(true);
            expect(
                isTrustedSender({
                    from: 'anyone@client.test',
                    ownerAddresses: [],
                    metadata: { spf: 'pass', spfDomain: 'other.test' },
                    env: listed,
                }),
            ).toBe(false);
            expect(
                isTrustedSender({ from: 'x@partner.test', ownerAddresses: [], env: listed }),
            ).toBe(false);
            expect(
                isTrustedSender({ from: 'x@client.test.evil', ownerAddresses: [], env: listed }),
            ).toBe(false);
            expect(isTrustedSender({ from: 'not an address', ownerAddresses: owner, env })).toBe(
                false,
            );
        });

        // Works-security lane (integration API gates, finding 4).
        it('a listed sender is NOT trusted on its spelling once an authserv-id is configured and the stamp is missing', () => {
            const listedWithAuthserv = {
                ...env,
                INBOUND_EMAIL_TRUSTED_SENDERS: 'ops@partner.test',
            };
            expect(
                isTrustedSender({
                    from: 'ops@partner.test',
                    ownerAddresses: [],
                    env: listedWithAuthserv,
                }),
            ).toBe(false);
            expect(
                isTrustedSender({
                    from: 'ops@partner.test',
                    ownerAddresses: [],
                    metadata: ar('mx.provider.test; dkim=pass header.d=partner.test'),
                    env: listedWithAuthserv,
                }),
            ).toBe(true);
        });

        it('mail an integration pushed is never trusted: not listed, not owner, not platform-sent', () => {
            const listed = { INBOUND_EMAIL_TRUSTED_SENDERS: 'ops@partner.test' };
            const pushed = { source: 'integration', integrationKeyId: 'key-1' };
            // The listed sender on spelling alone (verdict "none") — trusted when a provider
            // delivered it, refused when an integration pushed it.
            expect(
                isTrustedSender({ from: 'ops@partner.test', ownerAddresses: [], env: listed }),
            ).toBe(true);
            expect(
                isTrustedSender({
                    from: 'ops@partner.test',
                    ownerAddresses: [],
                    metadata: pushed,
                    env: listed,
                }),
            ).toBe(false);
            // A replayed platform Message-ID does not earn agent-to-agent trust either.
            expect(
                isTrustedSender({
                    from: 'ops@agents.test',
                    ownerAddresses: [],
                    metadata: pushed,
                    platformSent: true,
                    env: listed,
                }),
            ).toBe(false);
            // Nor does the owner's own address (with or without a forged verdict field).
            expect(
                isTrustedSender({
                    from: 'owner@acme.test',
                    ownerAddresses: owner,
                    metadata: { ...pushed, dmarc: 'pass' },
                    env: listed,
                }),
            ).toBe(false);
        });
    });

    it('INBOUND_EMAIL_AUTO_DISPATCH_ALL and the older name both restore dispatch for all senders', () => {
        expect(inboundEmailAutoDispatchAll({})).toBe(false);
        expect(inboundEmailAutoDispatchAll({ INBOUND_EMAIL_AUTO_DISPATCH_ALL: 'true' })).toBe(true);
        expect(inboundEmailAutoDispatchAll({ INBOUND_EMAIL_REPLY_AUTO_DISPATCH: 'TRUE' })).toBe(
            true,
        );
        expect(inboundEmailAutoDispatchAll({ INBOUND_EMAIL_AUTO_DISPATCH_ALL: '1' })).toBe(false);
    });

    it('bareSenderAddress normalizes a header address', () => {
        expect(bareSenderAddress('"Ada L" <Ada@Example.COM>')).toBe('ada@example.com');
        expect(bareSenderAddress(42)).toBe('');
    });
});
