import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import * as fs from 'fs/promises';
import Handlebars from 'handlebars';
import { Resend } from 'resend';
import { MailerService as SmtpMailerService } from '@nestjs-modules/mailer';
import { FakerMailerService } from './faker-mailer.service';
import { config } from '@src/config/constants';
import { Address, SendMailOptions } from '../types';
import { describeTemplatesDir, inspectTemplatesDir, resolveTemplatePath } from '../templates';

/**
 * Raised when a templated email cannot be rendered because the `.hbs` file
 * is not on disk. Distinct from a transport failure on purpose: a transport
 * failure is transient and worth retrying, this one means the *image is
 * mis-built* and every templated email will fail until it is rebuilt.
 */
export class EmailTemplateUnavailableError extends Error {
    /**
     * Declared explicitly: `tsconfig` targets ES2021, whose `Error` type has
     * no `cause` (that landed in ES2022), so the inherited property is not
     * visible to the compiler.
     */
    readonly cause?: unknown;

    constructor(
        readonly templateName: string,
        readonly templatePath: string,
        cause?: unknown,
    ) {
        super(
            `Email template "${templateName}" is not available at ${templatePath}. ` +
                `No mail was sent. This almost always means the Handlebars templates were ` +
                `not copied into the build output — check apps/api/nest-cli.json ` +
                `(compilerOptions.assets, resolved relative to sourceRoot) and the API image. ` +
                describeTemplatesDir(),
        );
        this.name = 'EmailTemplateUnavailableError';
        this.cause = cause;
    }
}

@Injectable()
export class MailerService {
    private readonly logger = new Logger(MailerService.name);

    constructor(
        private readonly smtpMailerService: SmtpMailerService,
        private readonly fakerMailerService: FakerMailerService,
        @Optional() @Inject('RESEND_CLIENT') private readonly resend?: Resend,
    ) {
        this.logger.log(`Mailer service initialized with provider: ${config.mail.provider()}`);
        this.assertTemplatesAvailable();
    }

    /**
     * Boot-time packaging check. The templates are baked into the image and
     * cannot appear later, so a missing directory here means *every*
     * templated email will fail for the lifetime of this pod — password
     * reset and signup verification included, which locks new users out of
     * the platform entirely. Say so once, loudly, at startup rather than
     * leaving it to be discovered by a customer who never got their mail.
     *
     * Deliberately does NOT throw: refusing to boot would take the whole API
     * down over an email fault. The failure is loud in logs, reported as
     * `email: degraded` on /api/health/ready, and every individual send
     * still fails hard instead of pretending success.
     */
    private assertTemplatesAvailable(): void {
        const status = inspectTemplatesDir({ refresh: true });
        if (status.ok) {
            this.logger.log(
                `Email templates loaded: ${status.available.length} from ${status.dir}`,
            );
            return;
        }

        this.logger.error(
            `EMAIL TEMPLATES MISSING — every templated email (signup confirmation, ` +
                `password reset, magic link, invitations, budget alerts) will FAIL. ` +
                describeTemplatesDir(),
        );
    }

    async sendMail(data: SendMailOptions): Promise<void> {
        const provider = config.mail.provider();
        const recipient = data.to ? this.getDestination(data.to).join(', ') : 'unknown';

        switch (provider) {
            case 'smtp':
                this.logger.log(`Sending email via SMTP to=${recipient} subject="${data.subject}"`);
                await this.smtpMailerService.sendMail(data);
                this.logger.log(`Email sent via SMTP to=${recipient}`);
                break;

            case 'resend': {
                if (!this.resend) {
                    this.logger.warn(
                        `Resend client not initialized (missing RESEND_APIKEY?), falling back to faker for to=${recipient}`,
                    );
                    await this.fakerMailerService.sendMail(data);
                    break;
                }

                const from = config.mail.resend.emailFrom();
                // Render BEFORE announcing the send. When the template is
                // missing this throws here, so `resend.emails.send()` is never
                // reached and no message is queued at the provider — and the
                // log does not carry a "Sending ..." line for a message that
                // never left the process.
                const html = await this.readHtmlTemplate(data);
                this.logger.log(
                    `Sending email via Resend to=${recipient} from="${from}" subject="${data.subject}"`,
                );
                const result = await this.resend.emails.send({
                    to: data.to ? this.getDestination(data.to) : [],
                    from,
                    subject: data.subject,
                    html,
                });
                this.logger.log(
                    `Email sent via Resend to=${recipient} id=${result.data?.id ?? 'unknown'}`,
                );
                break;
            }

            default:
                this.logger.debug(`No mail provider configured, using faker for to=${recipient}`);
                await this.fakerMailerService.sendMail(data);
                break;
        }
    }

    private getDestination(destination: string | Address | (string | Address)[]) {
        const dest = Array.isArray(destination) ? destination : [destination];
        return dest.map((to) => (typeof to === 'string' ? to : 'address' in to ? to.address : to));
    }

    private async readHtmlTemplate(data: SendMailOptions) {
        if (data.template) {
            // Security: prevent path traversal via a user-supplied template
            // name. `resolveTemplatePath` restricts to a safe charset (no `/`,
            // `\`, `.` or `..` segments) and then re-checks that the resolved
            // path stays inside the templates directory, so a value like
            // `../../config/constants` can never escape it and read arbitrary
            // `.hbs`-suffixed files from the tree.
            const templatePath = resolveTemplatePath(data.template);

            let content: string;
            try {
                content = await fs.readFile(templatePath, { encoding: 'utf8' });
            } catch (error) {
                // Do NOT degrade to an empty body: an email with no content
                // still counts as "delivered" to the provider and to the
                // caller, which is how a broken image can masquerade as a
                // working one. Fail loudly and send nothing.
                this.logger.error(
                    `Cannot render email template "${data.template}" — NOT sending. ` +
                        describeTemplatesDir(),
                    (error as Error)?.stack,
                );
                throw new EmailTemplateUnavailableError(data.template, templatePath, error);
            }

            const template = Handlebars.compile(content);
            const result = template(data.context || {});

            return result;
        }

        if (data.html) {
            return data.html instanceof Buffer ? data.html.toString() : (data.html as string);
        } else if (data.text) {
            return data.text instanceof Buffer ? data.text.toString() : (data.text as string);
        }

        return '';
    }
}
