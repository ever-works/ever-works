import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { RegisterWorkRequestDto } from './register-work.dto';

const constraintsFor = (
    errs: { property: string; constraints?: Record<string, string> }[],
    property: string,
) => errs.find((e) => e.property === property)?.constraints ?? {};

describe('onboarding RegisterWorkRequestDto validation', () => {
    const valid = { repo: 'https://github.com/octocat/awesome-mcp' };

    it('accepts the minimal valid payload (only repo)', async () => {
        const dto = plainToInstance(RegisterWorkRequestDto, valid);
        expect(await validate(dto)).toHaveLength(0);
    });

    it('accepts a fully populated payload', async () => {
        const dto = plainToInstance(RegisterWorkRequestDto, {
            ...valid,
            email: 'dev@example.com',
            agentId: 'agent-123',
            webhookUrl: 'https://my-agent.example.com/webhooks/ever-works',
            subdomain: 'awesome-mcp',
            agentPayment: { provider: 'x402' },
        });
        expect(await validate(dto)).toHaveLength(0);
    });

    describe('repo', () => {
        it('rejects missing repo via @IsString', async () => {
            const dto = plainToInstance(RegisterWorkRequestDto, {});
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'repo').isString).toBeDefined();
        });

        it('accepts trailing slash on repo URL', async () => {
            const dto = plainToInstance(RegisterWorkRequestDto, {
                repo: 'https://github.com/octocat/awesome-mcp/',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts uppercase HTTPS in repo URL (case-insensitive @Matches)', async () => {
            const dto = plainToInstance(RegisterWorkRequestDto, {
                repo: 'HTTPS://github.com/octocat/awesome-mcp',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it.each([
            'http://github.com/foo/bar',
            'https://gitlab.com/foo/bar',
            'github.com/foo/bar',
            'https://github.com/foo',
            'https://github.com//bar',
            'not-a-url',
        ])('rejects invalid repo URL %s via @Matches', async (repo) => {
            const dto = plainToInstance(RegisterWorkRequestDto, { repo });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'repo').matches).toBe(
                'repo must be a https://github.com/<owner>/<repo> URL',
            );
        });

        it('rejects repo longer than 512 chars via @MaxLength', async () => {
            const repo = 'https://github.com/o/' + 'a'.repeat(500);
            const dto = plainToInstance(RegisterWorkRequestDto, { repo });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'repo').maxLength).toBeDefined();
        });
    });

    describe('email (optional)', () => {
        it('rejects invalid email via @IsEmail', async () => {
            const dto = plainToInstance(RegisterWorkRequestDto, {
                ...valid,
                email: 'not-an-email',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'email').isEmail).toBeDefined();
        });

        it('accepts undefined email (optional)', async () => {
            const dto = plainToInstance(RegisterWorkRequestDto, valid);
            expect(await validate(dto)).toHaveLength(0);
        });
    });

    describe('agentId (optional)', () => {
        it('accepts a printable-ASCII agentId', async () => {
            const dto = plainToInstance(RegisterWorkRequestDto, {
                ...valid,
                agentId: 'agent-abc-123!',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects an empty agentId via @Length', async () => {
            const dto = plainToInstance(RegisterWorkRequestDto, { ...valid, agentId: '' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'agentId').isLength).toBeDefined();
        });

        it('rejects agentId longer than 256 chars via @Length', async () => {
            const dto = plainToInstance(RegisterWorkRequestDto, {
                ...valid,
                agentId: 'a'.repeat(257),
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'agentId').isLength).toBeDefined();
        });

        it('rejects agentId containing non-printable ASCII (newline) via @Matches', async () => {
            const dto = plainToInstance(RegisterWorkRequestDto, {
                ...valid,
                agentId: 'agent\n123',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'agentId').matches).toBe(
                'agentId must be printable ASCII',
            );
        });

        it('rejects agentId containing space (space is 0x20, below 0x21)', async () => {
            const dto = plainToInstance(RegisterWorkRequestDto, {
                ...valid,
                agentId: 'agent 123',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'agentId').matches).toBeDefined();
        });
    });

    describe('webhookUrl (optional)', () => {
        it('accepts an https webhook URL', async () => {
            const dto = plainToInstance(RegisterWorkRequestDto, {
                ...valid,
                webhookUrl: 'https://example.com/webhook',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts an http webhook URL (regex allows http or https)', async () => {
            const dto = plainToInstance(RegisterWorkRequestDto, {
                ...valid,
                webhookUrl: 'http://example.com/webhook',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects non-http(s) webhook URL via @Matches', async () => {
            const dto = plainToInstance(RegisterWorkRequestDto, {
                ...valid,
                webhookUrl: 'ftp://example.com/webhook',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'webhookUrl').matches).toBe(
                'webhookUrl must be an http(s) URL',
            );
        });

        it('rejects webhookUrl longer than 2048 chars via @MaxLength', async () => {
            const url = 'https://example.com/' + 'a'.repeat(2050);
            const dto = plainToInstance(RegisterWorkRequestDto, { ...valid, webhookUrl: url });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'webhookUrl').maxLength).toBeDefined();
        });
    });

    describe('subdomain (optional)', () => {
        it('accepts a DNS-safe subdomain', async () => {
            const dto = plainToInstance(RegisterWorkRequestDto, {
                ...valid,
                subdomain: 'my-app-1',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it.each(['ab', 'a'.repeat(64)])(
            'rejects subdomain length boundary %s via @Length(3,63)',
            async (subdomain) => {
                const dto = plainToInstance(RegisterWorkRequestDto, { ...valid, subdomain });
                const errs = await validate(dto);
                expect(constraintsFor(errs, 'subdomain').isLength).toBeDefined();
            },
        );

        it('rejects uppercase letters via @Matches', async () => {
            const dto = plainToInstance(RegisterWorkRequestDto, {
                ...valid,
                subdomain: 'MyApp',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'subdomain').matches).toBe(
                'subdomain must be DNS-safe (lowercase, hyphens)',
            );
        });

        it.each(['-leading', 'trailing-', 'has_underscore', 'has space'])(
            'rejects malformed subdomain %s via @Matches',
            async (subdomain) => {
                const dto = plainToInstance(RegisterWorkRequestDto, { ...valid, subdomain });
                const errs = await validate(dto);
                expect(constraintsFor(errs, 'subdomain').matches).toBeDefined();
            },
        );
    });

    describe('agentPayment (optional)', () => {
        it('accepts an arbitrary object', async () => {
            const dto = plainToInstance(RegisterWorkRequestDto, {
                ...valid,
                agentPayment: { provider: 'stripe', meta: { x: 1 } },
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects non-object via @IsObject', async () => {
            const dto = plainToInstance(RegisterWorkRequestDto, {
                ...valid,
                agentPayment: 'not-an-object' as unknown as Record<string, unknown>,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'agentPayment').isObject).toBeDefined();
        });
    });
});
