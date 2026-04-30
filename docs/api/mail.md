---
id: mail
title: Mail System
sidebar_label: Mail
sidebar_position: 9
---

# Mail System

The mail system handles all transactional email delivery for the platform, supporting SMTP, Resend, and a development faker provider. Emails are rendered using Handlebars templates and triggered by domain events via NestJS `@OnEvent` decorators.

## Architecture

```
apps/api/src/mail/
  mail.service.ts                   # Event listeners and email orchestration
  mail.module.ts                    # Module config (SMTP, Resend, templates)
  types.ts                          # SendMailOptions interface
  providers/
    mailer.service.ts               # Multi-provider dispatch (SMTP, Resend, faker)
    faker-mailer.service.ts         # Development-only logger provider

apps/api/src/templates/
  signup-confirmation.hbs           # Account signup verification
  forgot-password.hbs               # Password reset link
  password-changed.hbs              # Password change confirmation
  welcome.hbs                       # Post-confirmation welcome email
  new-device-login.hbs              # New device login alert
  account-deletion.hbs              # Account deletion confirmation
  member-invitation.hbs             # Directory collaboration invitation
```

## Mail Providers

The `MailerService` selects a provider based on `config.mail.provider()`:

| Provider   | Value       | Description                                                  |
| ---------- | ----------- | ------------------------------------------------------------ |
| **SMTP**   | `smtp`      | Standard SMTP transport via `@nestjs-modules/mailer`         |
| **Resend** | `resend`    | Resend API client, falls back to faker if API key is missing |
| **Faker**  | _(default)_ | Logs email data to console; used in development              |

### SMTP Configuration

| Config Method                 | Environment Variable   | Description               |
| ----------------------------- | ---------------------- | ------------------------- |
| `config.mail.smtpHost()`      | `MAIL_SMTP_HOST`       | SMTP server hostname      |
| `config.mail.smtpPort()`      | `MAIL_SMTP_PORT`       | SMTP server port          |
| `config.mail.smtpSecure()`    | `MAIL_SMTP_SECURE`     | Use TLS                   |
| `config.mail.smtpIgnoreTLS()` | `MAIL_SMTP_IGNORE_TLS` | Ignore TLS errors         |
| `config.mail.smtpUser()`      | `MAIL_SMTP_USER`       | SMTP username             |
| `config.mail.smtpPassword()`  | `MAIL_SMTP_PASSWORD`   | SMTP password             |
| `config.mail.from()`          | `MAIL_FROM`            | Default "From" address    |
| `config.mail.provider()`      | `MAIL_PROVIDER`        | `smtp`, `resend`, or omit |

### Resend Configuration

| Config Method                    | Environment Variable | Description           |
| -------------------------------- | -------------------- | --------------------- |
| `config.mail.resend.apiKey()`    | `RESEND_APIKEY`      | Resend API key        |
| `config.mail.resend.emailFrom()` | `RESEND_FROM`        | Resend sender address |

## Email Templates

Templates use Handlebars (`.hbs`) with inline CSS enabled. All templates receive common branding context:

```typescript
{
  appName: string,       // Application name from config
  companyOwner: string,  // Company owner name
  platformWebsite: string, // Platform URL
  currentYear: number    // Current year for footer
}
```

### Available Templates

| Template              | Event                      | Additional Context                                                                                                     |
| --------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `signup-confirmation` | `UserCreatedEvent`         | `firstName`, `confirmationUrl`, `confirmationToken`                                                                    |
| `forgot-password`     | `UserForgotPasswordEvent`  | `firstName`, `resetUrl`, `resetToken`, `expiresIn`                                                                     |
| `password-changed`    | `UserPasswordChangedEvent` | `firstName`, `changedAt`, `ipAddress`, `location`, `device`, `browser`, `secureAccountUrl`                             |
| `welcome`             | `UserConfirmedEvent`       | `firstName`, `dashboardUrl`                                                                                            |
| `new-device-login`    | `UserNewDeviceLoginEvent`  | `firstName`, `loginTime`, `device`, `browser`, `location`, `ipAddress`, `verifyUrl`, `verifyToken`, `secureAccountUrl` |
| `account-deletion`    | `UserAccountDeletionEvent` | `firstName`, `deleteUrl`, `deleteToken`, `keepAccountUrl`, `expiresIn`                                                 |
| `member-invitation`   | `MemberInvitedEvent`       | `inviteeName`, `inviterName`, `directoryName`, `roleName`, `directoryUrl`                                              |

## Event-Driven Delivery

The `MailService` subscribes to domain events using `@OnEvent()`:

```typescript
@OnEvent(UserCreatedEvent.EVENT_NAME)
async sendSignupConfirmation(data: UserCreatedEvent): Promise<void> {
  await this.mailerService.sendMail({
    to: data.user.email,
    subject: `Confirm your ${appName} account`,
    template: 'signup-confirmation',
    context: { ...brandingContext, firstName: data.user.username, ... },
  });
}
```

All email sends are wrapped in try/catch blocks and errors are logged without throwing, ensuring email failures do not break the calling flow.

## Adding a New Template

1. Create a `.hbs` file in `apps/api/src/templates/`:

    ```handlebars
    <h1>Hello {{firstName}},</h1>
    <p>Your notification from {{appName}}.</p>
    <p>&copy; {{currentYear}} {{companyOwner}}</p>
    ```

2. Define a new event class in `apps/api/src/events/`.

3. Add an `@OnEvent()` handler in `MailService`:

    ```typescript
    @OnEvent(MyNewEvent.EVENT_NAME)
    async sendMyNewEmail(data: MyNewEvent): Promise<void> {
      await this.mailerService.sendMail({
        to: data.user.email,
        subject: 'My Subject',
        template: 'my-new-template',
        context: { ...this.getBrandingContext(), ...data },
      });
    }
    ```

4. Emit the event from your service:

    ```typescript
    this.eventEmitter.emit(MyNewEvent.EVENT_NAME, new MyNewEvent({ ... }));
    ```

## SendMailOptions

The `types.ts` file defines the `SendMailOptions` interface:

```typescript
interface SendMailOptions {
	to?: string | Address | Array<string | Address>;
	cc?: string | Address | Array<string | Address>;
	bcc?: string | Address | Array<string | Address>;
	from?: string | Address;
	subject?: string;
	text?: string | Buffer;
	html?: string | Buffer;
	template?: string; // Handlebars template name (without .hbs)
	context?: Record<string, any>; // Template variables
}
```

## Module Registration

```typescript
@Module({
	imports: [
		MailerModule.forRootAsync({
			useFactory: () => ({
				transport: { host, port, secure, auth: { user, pass } },
				defaults: { from: config.mail.from() },
				template: {
					dir: path.join(process.cwd(), 'src/templates'),
					adapter: new HandlebarsAdapter(undefined, { inlineCssEnabled: true })
				}
			})
		})
	],
	providers: [
		{ provide: 'RESEND_CLIENT', useFactory: () => new Resend(apiKey) },
		MailService,
		MailerService,
		FakerMailerService
	]
})
export class MailModule {}
```
