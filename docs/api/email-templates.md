---
id: email-templates
title: Email Templates Reference
sidebar_label: Email Templates
sidebar_position: 13
---

# Email Templates Reference

The Ever Works platform uses **Handlebars** (`.hbs`) templates for all transactional emails. These templates live in `apps/api/src/templates/` and are rendered by the `MailService` using the `@nestjs/event-emitter` event system.

## Architecture Overview

```
User Action (e.g., signup)
  --> AuthService emits event (e.g., UserCreatedEvent)
    --> MailService listens via @OnEvent decorator
      --> MailerService renders .hbs template with context
        --> Email sent via configured provider (SMTP / Resend)
```

All templates share a consistent design system with a branded header, main content card, and footer section. They use the system font stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`) and a `#f8fafc` background color.

## Template Inventory

| Template File | Event Class | Event Name | Trigger |
|---|---|---|---|
| `signup-confirmation.hbs` | `UserCreatedEvent` | `user.created` | User registers a new account |
| `forgot-password.hbs` | `UserForgotPasswordEvent` | `user.forgot_password` | User requests password reset |
| `password-changed.hbs` | `UserPasswordChangedEvent` | `user.password_changed` | User successfully changes password |
| `welcome.hbs` | `UserConfirmedEvent` | `user.confirmed` | User confirms email address |
| `new-device-login.hbs` | `UserNewDeviceLoginEvent` | `user.new_device_login` | Login detected from new device |
| `account-deletion.hbs` | `UserAccountDeletionEvent` | `user.delete_account` | User requests account deletion |
| `member-invitation.hbs` | `MemberInvitedEvent` | `directory.member_invited` | User is invited to a directory |

## Global Context Variables

Every template receives these branding variables from the `getBrandingContext()` helper in `MailService`:

| Variable | Type | Description |
|---|---|---|
| `appName` | `string` | Application name (e.g., "Ever Works") |
| `companyOwner` | `string` | Company name for copyright |
| `platformWebsite` | `string` | Platform marketing website URL |
| `currentYear` | `number` | Current year for copyright notice |

## Template Details

### 1. Signup Confirmation (`signup-confirmation.hbs`)

Sent when a new user registers. Contains an email verification link.

**Context Variables:**

| Variable | Type | Description |
|---|---|---|
| `firstName` | `string` | User's display name |
| `confirmationUrl` | `string` | Email confirmation link |
| `confirmationToken` | `string` | Confirmation token value |

**Handlebars Usage:**

```handlebars
<h2 class="title">
    Welcome to {{appName}}{{#if firstName}}, {{firstName}}{{/if}}
</h2>
<a href="{{confirmationUrl}}" class="button">
    Confirm Email Address
</a>
```

The template includes a fallback plain-text link section for email clients that do not render buttons properly.

### 2. Forgot Password (`forgot-password.hbs`)

Sent when a user requests a password reset. Contains a time-limited reset link.

**Context Variables:**

| Variable | Type | Description |
|---|---|---|
| `firstName` | `string` | User's display name |
| `resetUrl` | `string` | Password reset link |
| `resetToken` | `string` | Reset token value |
| `expiresIn` | `string` | Expiry duration (e.g., "1 hour") |

**Handlebars Usage:**

```handlebars
{{#if firstName}}Hi {{firstName}}, we{{else}}We{{/if}}
received a request to reset the password for your {{appName}} account.
```

### 3. Password Changed (`password-changed.hbs`)

Security notification sent after a successful password change. Includes device and location details.

**Context Variables:**

| Variable | Type | Description |
|---|---|---|
| `firstName` | `string` | User's display name |
| `changedAt` | `string` | Formatted date/time of change |
| `ipAddress` | `string` | IP address of the requester |
| `location` | `string` | Geographic location |
| `device` | `string` | Device description |
| `browser` | `string` (optional) | Browser name |
| `secureAccountUrl` | `string` | Link to secure the account |

**Conditional Rendering:**

```handlebars
<strong>Device:</strong>
{{device}}{{#if browser}}<br>
<strong>Browser:</strong>
{{browser}}{{/if}}
```

### 4. Welcome (`welcome.hbs`)

Sent after a user confirms their email. Includes onboarding steps and a CTA to the dashboard.

**Context Variables:**

| Variable | Type | Description |
|---|---|---|
| `firstName` | `string` | User's display name |
| `dashboardUrl` | `string` | Link to create first directory |

The template displays a three-step getting-started guide:
1. Create your first directory
2. Generate with AI
3. Deploy your directory

### 5. New Device Login (`new-device-login.hbs`)

Security alert sent when a login is detected from a previously unseen device.

**Context Variables:**

| Variable | Type | Description |
|---|---|---|
| `firstName` | `string` | User's display name |
| `loginTime` | `string` | Formatted login timestamp |
| `device` | `string` | Device name/type |
| `browser` | `string` | Browser name |
| `location` | `string` | Geographic location |
| `ipAddress` | `string` | IP address |
| `verifyUrl` | `string` | "Yes, this was me" link |
| `verifyToken` | `string` | Verification token |
| `secureAccountUrl` | `string` | "No, secure my account" link |

This template uses two CTA buttons: a primary "Yes, this was me" button and a danger-styled "No, secure my account" button.

### 6. Account Deletion (`account-deletion.hbs`)

Sent when a user requests account deletion. Requires explicit confirmation before proceeding.

**Context Variables:**

| Variable | Type | Description |
|---|---|---|
| `firstName` | `string` | User's display name |
| `deleteUrl` | `string` | Confirm deletion link |
| `deleteToken` | `string` | Deletion confirmation token |
| `keepAccountUrl` | `string` | Cancel deletion link |
| `expiresIn` | `string` | Expiry duration (e.g., "24 hours") |

The template includes a prominent warning box listing what will be permanently deleted:
- All projects and data
- Profile and settings
- Access to platform services

### 7. Member Invitation (`member-invitation.hbs`)

Sent when a user is invited to collaborate on a directory.

**Context Variables:**

| Variable | Type | Description |
|---|---|---|
| `inviteeName` | `string` | Invited user's name |
| `inviterName` | `string` | Name of the person inviting |
| `directoryName` | `string` | Name of the directory |
| `roleName` | `string` | Assigned role (formatted) |
| `directoryUrl` | `string` | Link to the directory |

The template displays an info box with a table layout showing directory name, assigned role (with a styled badge), and inviter name.

## Handlebars Patterns Used

### Conditional Greetings

All user-facing templates use a consistent pattern for optional personalization:

```handlebars
{{#if firstName}}{{firstName}}, your{{else}}Your{{/if}}
```

### Branding Footer

Every template ends with:

```handlebars
© {{currentYear}} {{companyOwner}} All rights reserved.
```

## Customizing Templates

To customize email templates:

1. Edit the `.hbs` file in `apps/api/src/templates/`
2. Maintain all existing context variables (removing a used variable will show `undefined`)
3. Keep the responsive layout (`max-width: 600px` container)
4. Use inline CSS styles (many email clients strip `<style>` tags from the body)
5. Test with tools like Litmus or Email on Acid for client compatibility

### Adding a New Template

1. Create a new `.hbs` file in the templates directory
2. Define a new event class in `apps/api/src/events/index.ts`
3. Add an `@OnEvent` handler in `MailService`
4. Emit the event from the relevant service using `EventEmitter2`

```typescript
// 1. Define the event
export class MyCustomEvent extends BaseUserEvent {
    static EVENT_NAME = 'user.custom_action';
    constructor(public user: User, public customUrl: string) {
        super();
    }
}

// 2. Handle in MailService
@OnEvent(MyCustomEvent.EVENT_NAME)
async sendCustomEmail(data: MyCustomEvent): Promise<void> {
    await this.mailerService.sendMail({
        to: data.user.email,
        subject: 'Custom Subject',
        template: 'my-custom-template',
        context: {
            ...this.getBrandingContext(),
            firstName: data.user.username,
            customUrl: data.customUrl,
        },
    });
}
```

## Email Provider Configuration

Templates are rendered and sent through the `MailerService`, which supports:

| Provider | Environment Variables |
|---|---|
| SMTP | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` |
| Resend | `RESEND_APIKEY`, `RESEND_EMAIL_FROM` |

The active provider is selected via `MAILER_PROVIDER` and the sender address via `EMAIL_FROM`.

## Source Files

| File | Purpose |
|---|---|
| `apps/api/src/templates/*.hbs` | Handlebars email templates |
| `apps/api/src/mail/mail.service.ts` | Event listeners and template rendering |
| `apps/api/src/events/index.ts` | Event class definitions |
| `apps/api/src/mail/providers/mailer.service.ts` | Mail transport abstraction |
