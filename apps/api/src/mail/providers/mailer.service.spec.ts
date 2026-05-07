jest.mock('fs/promises', () => ({
    readFile: jest.fn(),
}));

const ORIGINAL_ENV = { ...process.env };

const setEnv = (provider?: string) => {
    if (provider === undefined) {
        delete process.env.MAILER_PROVIDER;
    } else {
        process.env.MAILER_PROVIDER = provider;
    }
};

beforeEach(() => {
    setEnv(undefined);
});

afterAll(() => {
    process.env = ORIGINAL_ENV;
});

import * as fs from 'fs/promises';
import { MailerService } from './mailer.service';
import type { FakerMailerService } from './faker-mailer.service';
import type { MailerService as SmtpMailerService } from '@nestjs-modules/mailer';
import type { Resend } from 'resend';

describe('MailerService', () => {
    let smtp: { sendMail: jest.Mock };
    let faker: { sendMail: jest.Mock };
    let resend: { emails: { send: jest.Mock } };
    let logSpy: jest.SpyInstance;
    let debugSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;

    const buildService = (resendClient?: Resend) => {
        const service = new MailerService(
            smtp as unknown as SmtpMailerService,
            faker as unknown as FakerMailerService,
            resendClient,
        );
        logSpy = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
        debugSpy = jest
            .spyOn((service as any).logger, 'debug')
            .mockImplementation(() => undefined);
        warnSpy = jest
            .spyOn((service as any).logger, 'warn')
            .mockImplementation(() => undefined);
        return service;
    };

    beforeEach(() => {
        smtp = { sendMail: jest.fn().mockResolvedValue(undefined) };
        faker = { sendMail: jest.fn().mockResolvedValue(undefined) };
        resend = {
            emails: {
                send: jest.fn().mockResolvedValue({ data: { id: 'r-1' } }),
            },
        };
        (fs.readFile as jest.Mock).mockReset();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('SMTP provider', () => {
        beforeEach(() => setEnv('smtp'));

        it('routes through SmtpMailerService and logs to=/from= details', async () => {
            const service = buildService();

            await service.sendMail({
                to: 'recipient@test.example',
                subject: 'Greetings',
                text: 'hi',
            });

            expect(smtp.sendMail).toHaveBeenCalledWith({
                to: 'recipient@test.example',
                subject: 'Greetings',
                text: 'hi',
            });
            expect(logSpy).toHaveBeenCalledWith(
                'Sending email via SMTP to=recipient@test.example subject="Greetings"',
            );
            expect(logSpy).toHaveBeenCalledWith('Email sent via SMTP to=recipient@test.example');
            expect(faker.sendMail).not.toHaveBeenCalled();
            expect(resend.emails.send).not.toHaveBeenCalled();
        });

        it('joins multiple recipients (string + Address) with commas in log output', async () => {
            const service = buildService();

            await service.sendMail({
                to: ['a@b.test', { name: 'C', address: 'c@b.test' }],
                subject: 'multi',
            });

            expect(logSpy).toHaveBeenCalledWith(
                'Sending email via SMTP to=a@b.test, c@b.test subject="multi"',
            );
        });

        it('renders to=unknown when "to" is omitted', async () => {
            const service = buildService();

            await service.sendMail({ subject: 'no-to' });

            expect(logSpy).toHaveBeenCalledWith(
                'Sending email via SMTP to=unknown subject="no-to"',
            );
            expect(smtp.sendMail).toHaveBeenCalledTimes(1);
        });

        it('falls through to address property for objects without "address" key', async () => {
            const service = buildService();

            // Object without an `address` property exercises the trailing
            // `: to` branch in getDestination(): the object itself is
            // returned and joined via Array.prototype.join (toString).
            const stringy = { toString: () => 'stringy@test.example' } as any;
            await service.sendMail({ to: stringy, subject: 'via-tostring' });

            expect(logSpy).toHaveBeenCalledWith(
                'Sending email via SMTP to=stringy@test.example subject="via-tostring"',
            );
        });
    });

    describe('Resend provider', () => {
        beforeEach(() => {
            setEnv('resend');
            process.env.RESEND_EMAIL_FROM = 'from@resend.test';
        });

        afterEach(() => {
            delete process.env.RESEND_EMAIL_FROM;
        });

        it('falls back to faker when no Resend client is wired', async () => {
            const service = buildService(undefined);

            await service.sendMail({ to: 'r@test.example', subject: 'Hi' });

            expect(faker.sendMail).toHaveBeenCalledWith({
                to: 'r@test.example',
                subject: 'Hi',
            });
            expect(warnSpy).toHaveBeenCalledWith(
                'Resend client not initialized (missing RESEND_APIKEY?), falling back to faker for to=r@test.example',
            );
            expect(smtp.sendMail).not.toHaveBeenCalled();
            expect(resend.emails.send).not.toHaveBeenCalled();
        });

        it('sends via Resend with html body when no template is set', async () => {
            const service = buildService(resend as unknown as Resend);

            await service.sendMail({
                to: 'r@test.example',
                subject: 'Hi',
                html: '<p>Hello</p>',
            });

            expect(resend.emails.send).toHaveBeenCalledWith({
                to: ['r@test.example'],
                from: 'from@resend.test',
                subject: 'Hi',
                html: '<p>Hello</p>',
            });
            expect(logSpy).toHaveBeenCalledWith(
                'Email sent via Resend to=r@test.example id=r-1',
            );
            expect(fs.readFile).not.toHaveBeenCalled();
        });

        it('coerces Buffer html to string and Buffer text fallback', async () => {
            const service = buildService(resend as unknown as Resend);

            await service.sendMail({
                to: 'r@test.example',
                subject: 'Bufferized',
                html: Buffer.from('<b>BufHtml</b>'),
            });

            expect(resend.emails.send).toHaveBeenCalledWith(
                expect.objectContaining({ html: '<b>BufHtml</b>' }),
            );

            (resend.emails.send as jest.Mock).mockClear();
            await service.sendMail({
                to: 'r@test.example',
                subject: 'TextOnly',
                text: Buffer.from('plain'),
            });
            expect(resend.emails.send).toHaveBeenCalledWith(
                expect.objectContaining({ html: 'plain' }),
            );
        });

        it('returns empty html string when neither template, html, nor text is provided', async () => {
            const service = buildService(resend as unknown as Resend);

            await service.sendMail({ to: 'r@test.example', subject: 'Bare' });

            expect(resend.emails.send).toHaveBeenCalledWith(
                expect.objectContaining({ html: '' }),
            );
        });

        it('renders Handlebars template via fs.readFile when "template" is set', async () => {
            (fs.readFile as jest.Mock).mockResolvedValue(
                'Hello {{name}}, your code is {{code}}',
            );
            const service = buildService(resend as unknown as Resend);

            await service.sendMail({
                to: 'r@test.example',
                subject: 'Welcome',
                template: 'welcome',
                context: { name: 'Ever', code: 12345 },
            });

            expect(fs.readFile).toHaveBeenCalledTimes(1);
            const [filePath, opts] = (fs.readFile as jest.Mock).mock.calls[0];
            expect(typeof filePath).toBe('string');
            expect(filePath).toMatch(/src[\\/]templates[\\/]welcome\.hbs$/);
            expect(opts).toEqual({ encoding: 'utf8' });

            expect(resend.emails.send).toHaveBeenCalledWith(
                expect.objectContaining({ html: 'Hello Ever, your code is 12345' }),
            );
        });

        it('handles undefined Resend response id gracefully', async () => {
            (resend.emails.send as jest.Mock).mockResolvedValue({ data: undefined });
            const service = buildService(resend as unknown as Resend);

            await service.sendMail({
                to: 'r@test.example',
                subject: 'no-id',
                html: '<p>x</p>',
            });

            expect(logSpy).toHaveBeenCalledWith(
                'Email sent via Resend to=r@test.example id=unknown',
            );
        });

        it('logs to=unknown for Resend when "to" is omitted (then crashes inside Resend send because getDestination is unguarded)', async () => {
            // Documents the current behavior: the "to=unknown" log fires
            // because `data.to ? this.getDestination(data.to) : 'unknown'`
            // is evaluated for the log line, but the call site
            // `to: this.getDestination(data.to)` inside resend.emails.send is
            // unguarded and throws. This pins behavior so a future refactor
            // either keeps it or makes the bug visible by failing this test.
            const service = buildService(resend as unknown as Resend);

            await expect(
                service.sendMail({ subject: 'Anon', html: '<p>hi</p>' }),
            ).rejects.toThrow(/'address' in/);

            expect(logSpy).toHaveBeenCalledWith(
                expect.stringContaining('Sending email via Resend to=unknown'),
            );
            expect(resend.emails.send).not.toHaveBeenCalled();
        });
    });

    describe('faker fallback', () => {
        it('routes to faker when MAILER_PROVIDER is unset (defaults to faker)', async () => {
            setEnv(undefined);
            const service = buildService();

            await service.sendMail({ to: 'q@test.example', subject: 'X' });

            expect(faker.sendMail).toHaveBeenCalledWith({
                to: 'q@test.example',
                subject: 'X',
            });
            expect(smtp.sendMail).not.toHaveBeenCalled();
        });

        it('routes to faker when MAILER_PROVIDER=none (treated as faker)', async () => {
            setEnv('none');
            const service = buildService();

            await service.sendMail({ to: 'q@test.example', subject: 'X' });

            expect(faker.sendMail).toHaveBeenCalled();
            expect(smtp.sendMail).not.toHaveBeenCalled();
        });
    });

    describe('init log', () => {
        it('emits provider name in constructor when service is built', () => {
            setEnv('smtp');
            // Spy on Logger.prototype.log so we capture the constructor log
            // before our per-instance spy is installed.
            const protoSpy = jest
                .spyOn(
                    require('@nestjs/common').Logger.prototype,
                    'log' as any,
                )
                .mockImplementation(() => undefined);

            new MailerService(
                smtp as unknown as SmtpMailerService,
                faker as unknown as FakerMailerService,
            );

            expect(protoSpy).toHaveBeenCalledWith(
                'Mailer service initialized with provider: smtp',
            );
        });
    });
});
