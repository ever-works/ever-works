---
id: auth-pages
title: Authentication Pages
sidebar_label: Authentication Pages
sidebar_position: 11
---

# Authentication Pages

The authentication pages live under the `(auth)` route group and handle login, registration, password recovery, and error display. All auth pages are public (no authentication required) and share a common `AuthLayout` wrapper. Each page follows the server component + client component split pattern.

## Route Structure

```
/[locale]/(auth)/
  login/
    page.tsx                    # Server: redirect if authenticated, render LoginClient
    login-client.tsx            # Client: login form with social login
  register/
    page.tsx                    # Server: render RegisterForm
    register-form.tsx           # Client: registration form with validation
  forgot-password/
    page.tsx                    # Server: render ForgotPasswordForm
    forgot-password-form.tsx    # Client: email input with success state
  reset-password/
    page.tsx                    # Server: render ResetPasswordForm
    reset-password-form.tsx     # Client: new password form with token validation
  auth/error/
    page.tsx                    # Server: render AuthErrorClient
    auth-error-content.tsx      # Client: error display with contextual actions
```

## Login Page

**Route**: `/login`

### Server Component (`page.tsx`)

Checks authentication status before rendering. If the user is already authenticated, redirects to the dashboard using the locale-aware `redirect()` from `next-intl/navigation`.

```typescript
const user = await getAuthFromCookie();
if (user) {
	return redirect({ locale, href: ROUTES.DASHBOARD });
}
```

Wraps `LoginClient` in a `Suspense` boundary with a loading placeholder (pulsing circle).

### Client Component (`login-client.tsx`)

**Form Fields**:

| Field    | Type       | Validation                       |
| -------- | ---------- | -------------------------------- |
| Email    | `email`    | Required, HTML5 email validation |
| Password | `password` | Required                         |

**Features**:

| Feature               | Description                                                                  |
| --------------------- | ---------------------------------------------------------------------------- |
| Password reset banner | Shown when `?reset=true` query param is present; auto-hides after 10 seconds |
| Redirect support      | Reads `redirect_uri` from search params; passes to `login` server action     |
| Social login          | Renders `SocialLoginButtons` component below a divider                       |
| Forgot password link  | Inline link next to the password label                                       |
| Registration link     | Footer link to the register page                                             |
| Theme toggle          | `ThemeToggle` component in the form header                                   |

**Server Action**: `login(email, password, redirectUrl)` from `src/app/actions/auth.ts`. On success, the server action sets auth cookies and redirects. On failure, an error banner is shown.

**State Management**: Uses `useTransition` for the form submission, disabling all inputs and showing a loading state on the submit button.

## Register Page

**Route**: `/register`

### Client Component (`register-form.tsx`)

**Form Fields**:

| Field            | Type       | Validation                            |
| ---------------- | ---------- | ------------------------------------- |
| Name             | `text`     | Required                              |
| Email            | `email`    | Required                              |
| Password         | `password` | Required, minimum 8 characters        |
| Confirm Password | `password` | Required, must match password         |
| Terms Checkbox   | `checkbox` | Required (HTML5 `required` attribute) |

**Client-Side Validations** (before calling server action):

1. Password and confirm password must match
2. Password must be at least 8 characters

**Additional Elements**:

- Terms of service and privacy policy links (to `/terms` and `/privacy`)
- Social sign-up buttons via `SocialLoginButtons`
- Login link in the footer for existing users

**Server Action**: `register(name, email, password)` from `src/app/actions/auth.ts`. On success, the server action sets auth cookies and redirects to the dashboard.

## Forgot Password Page

**Route**: `/forgot-password`

### Client Component (`forgot-password-form.tsx`)

**States**:

| State   | Display                                                             |
| ------- | ------------------------------------------------------------------- |
| Initial | Email input form with submit button                                 |
| Success | Email sent confirmation with check-spam note and back-to-login link |
| Error   | Red error banner above the form                                     |

**Form Fields**:

| Field | Type    | Validation |
| ----- | ------- | ---------- |
| Email | `email` | Required   |

**Server Action**: `forgotPassword(email)` from `src/app/actions/auth.ts`. On success, transitions to the success view showing which email address received the reset link.

**Submit Button**: Disabled when the email field is empty or the submission is pending.

## Reset Password Page

**Route**: `/reset-password`

### Client Component (`reset-password-form.tsx`)

Reads the `token` query parameter from the URL via `useSearchParams()`. The component is wrapped in a `Suspense` boundary because `useSearchParams()` requires it.

**Token Validation**:

| Condition             | Display                                                               |
| --------------------- | --------------------------------------------------------------------- |
| No token in URL       | Error panel with "Request new link" button linking to forgot-password |
| Token present         | Password reset form                                                   |
| Submission successful | Success panel with "Log in" button                                    |

**Form Fields**:

| Field            | Type       | Validation                        |
| ---------------- | ---------- | --------------------------------- |
| New Password     | `password` | Required                          |
| Confirm Password | `password` | Required, must match new password |

**Server Action**: `resetPassword(token, password)` from `src/app/actions/auth.ts`. On success, redirects to `/login?reset=true` which triggers the success banner on the login page.

## Auth Error Page

**Route**: `/auth/error`

### Client Component (`auth-error-content.tsx`)

A centralized error display page that handles 16 distinct error types based on the `?error` query parameter.

**Error Categories**:

| Category           | Error Types                                                                                                             | Icon Color       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------- |
| OAuth              | `oauth_missing_code`, `oauth_invalid_state`, `oauth_unsupported_provider`, `oauth_callback`                             | Warning (yellow) |
| Credentials        | `invalid_credentials`                                                                                                   | Danger (red)     |
| Account            | `email_not_verified`, `account_locked`                                                                                  | Danger (red)     |
| Session            | `session_expired`                                                                                                       | Danger (red)     |
| Network            | `network_error`                                                                                                         | Danger (red)     |
| Password Reset     | `reset_password_missing_token`, `reset_password_invalid_token`, `reset_password_expired_token`, `reset_password_failed` | Warning (yellow) |
| Email Verification | `verify_email_missing_token`, `verify_email_invalid_token`, `verify_email_expired_token`, `verify_email_failed`         | Warning (yellow) |
| Authorization      | `authorize_invalid_redirect_url`                                                                                        | Warning (yellow) |
| Generic            | Any unknown error type                                                                                                  | Danger (red)     |

**Contextual Action Buttons**: The page dynamically renders action buttons based on the error type:

| Error Type           | Primary Action            | Secondary Action |
| -------------------- | ------------------------- | ---------------- |
| `email_not_verified` | Resend verification email | Back to login    |
| `account_locked`     | Contact support           | Back to login    |
| `reset_password_*`   | Request new reset link    | Back to login    |
| `verify_email_*`     | Resend verification email | Back to login    |
| `oauth_*`            | Back to login             | Try register     |
| Other                | Back to login             | --               |

## Shared Components

### AuthLayout

All auth pages wrap their content in `AuthLayout`, which provides a centered card layout with a title and subtitle.

```typescript
interface AuthLayoutProps {
	title: string;
	subtitle: string;
	children: React.ReactNode;
}
```

### SocialLoginButtons

Renders OAuth login/signup buttons (currently GitHub and Google). Each button initiates the OAuth flow via the `connectProvider` server action from `src/app/actions/auth.ts`.

## Server Actions Summary

| Action            | Description                                                |
| ----------------- | ---------------------------------------------------------- |
| `login`           | Authenticates with email/password, sets cookies, redirects |
| `register`        | Creates account, sets cookies, redirects                   |
| `forgotPassword`  | Sends password reset email                                 |
| `resetPassword`   | Validates token and sets new password                      |
| `connectProvider` | Initiates OAuth flow for social login                      |

## Common Patterns

**Error Display**: All forms use the same error banner pattern:

```tsx
{
	error && (
		<div className="bg-danger/10 border border-danger/20 text-danger px-4 py-3 rounded-lg text-sm">{error}</div>
	);
}
```

**Pending State**: Every form uses `useTransition` with `startTransition` to handle server action calls. During pending state, all inputs are disabled and the submit button shows a loading indicator.

**Navigation**: All internal links use the locale-aware `Link` component from `@/i18n/navigation` and reference routes from `ROUTES` constants. This ensures links automatically include the current locale prefix.
