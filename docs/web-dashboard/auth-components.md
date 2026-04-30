---
id: auth-components
title: Auth Components
sidebar_label: Auth Components
sidebar_position: 23
---

# Auth Components

## Overview

The auth components handle user authentication flows in the Ever Works web application, including email/password login, registration, OAuth social login (Google and GitHub), password reset, and email verification. These components live in `apps/web/src/components/auth/` and work closely with the server actions in `apps/web/src/app/actions/auth.ts` and the OAuth API routes in `apps/web/src/app/api/oauth/`.

## Architecture

```
Auth Flow
├── Login Page
│   ├── Email/Password form (server action: login)
│   └── SocialLoginButtons
│       ├── Google OAuth → connectProvider → redirect to OAuth URL
│       └── GitHub OAuth → connectProvider → redirect to OAuth URL
│
├── Register Page
│   ├── Email/Password/Username form (server action: register)
│   └── SocialLoginButtons
│
├── Forgot Password Page
│   └── Email form (server action: forgotPassword)
│
├── Reset Password Page
│   └── New password form (server action: resetPassword)
│
└── OAuth Callback Route
    └── /api/oauth/[providerId]/callback → validates state → sets auth cookies
```

Server actions handle all form submissions. OAuth flows redirect the browser to the provider's authorization page, then the callback API route processes the return.

## Components

### SocialLoginButtons

**File:** `apps/web/src/components/auth/social-login.tsx`

This component takes no props. It renders two OAuth buttons in a two-column grid:

| Button | Provider | Icon |
|--------|----------|------|
| Google | `OAuthProvider.GOOGLE` | Google "G" multicolor SVG |
| GitHub | `OAuthProvider.GITHUB` | GitHub octocat SVG |

Each button calls the `connectProvider` server action with the appropriate `OAuthProvider` enum value. The server action returns a `{ success, url }` response. If successful, the component redirects the browser to the OAuth authorization URL via `window.location.href`.

The component uses `useTransition` to manage the pending state during the server action call, disabling both buttons while a connection is in progress.

```tsx
import { SocialLoginButtons } from '@/components/auth/social-login';

// Used on both login and register pages
<div>
    <form>{/* email/password fields */}</form>
    <div className="divider">or</div>
    <SocialLoginButtons />
</div>
```

## Implementation Details

### OAuth Flow

The complete OAuth flow works as follows:

1. **Initiation:** User clicks a social login button. `connectProvider(provider)` server action is called.
2. **Server action:** The action calls the backend API to generate an OAuth authorization URL with a state parameter and PKCE code verifier. It sets a state cookie for CSRF protection.
3. **Redirect:** The browser is redirected to the provider's authorization page (e.g., `accounts.google.com`).
4. **Callback:** After authorization, the provider redirects back to `/api/oauth/[providerId]/callback`.
5. **Callback route:** The API route handler validates the state cookie against the returned state parameter, then exchanges the authorization code for tokens via the backend API.
6. **Session:** On success, the callback route sets authentication cookies (`access_token`, `refresh_token`) and redirects the user to the dashboard.

### Server Actions for Auth

The auth server actions in `apps/web/src/app/actions/auth.ts` include:

| Action | Purpose | Validation |
|--------|---------|------------|
| `login` | Email/password authentication | Zod schema (email, password) |
| `register` | New user registration | Zod schema (username, email, password) |
| `logout` | Clear session and redirect | None |
| `connectProvider` | Initiate OAuth flow | Provider enum |
| `forgotPassword` | Send password reset email | Zod schema (email) |
| `resetPassword` | Set new password with token | Zod schema (token, password) |

All form-based actions use Zod for input validation. On validation failure, they return structured error objects with field-level error messages. On success, `login` and `register` redirect to the dashboard.

### Cookie Management

Authentication state is stored in HTTP-only cookies:

- `access_token` - Short-lived JWT for API authentication.
- `refresh_token` - Long-lived token for session renewal.
- `oauth_state` - Temporary cookie for CSRF protection during OAuth flows.

The OAuth callback route sets the auth cookies with `httpOnly`, `secure`, and `sameSite: 'lax'` flags.

### Error Handling

Auth components display errors using:

- **Field-level errors** - Returned from Zod validation and displayed beneath each form input.
- **Toast notifications** - For server-side errors that are not field-specific, using the `sonner` toast library.
- **Console errors** - OAuth connection failures are logged to the console in `SocialLoginButtons`.

### Internationalization

All auth strings use `useTranslations('auth.login')` or `useTranslations('auth.register')` from `next-intl`. Key namespaces:

- `auth.login.socialLogin.google` / `auth.login.socialLogin.github` - Social button labels
- `auth.login.email` / `auth.login.password` - Form field labels
- `auth.register.username` - Registration-specific fields

## Styling & Theming

The social login buttons use the `Button` component with `variant="secondary"` and `text-sm` sizing. The icon SVGs are sized at `w-4 h-4`.

The buttons are laid out in a `grid grid-cols-2 gap-3` pattern, giving equal width to both providers. The Google icon uses its official brand colors directly in the SVG paths (blue `#4285F4`, green `#34A853`, yellow `#FBBC05`, red `#EA4335`). The GitHub icon uses `fill="currentColor"` to inherit the text color from the button variant.

Auth forms follow the standard form pattern with the `Input` component (variant `form`) for fields and `Button` for submission.

## Usage Examples

### Login Page with Social Login

```tsx
'use client';

import { SocialLoginButtons } from '@/components/auth/social-login';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export function LoginPage() {
    return (
        <div className="max-w-md mx-auto space-y-6">
            <h1>Sign In</h1>

            <form action={login}>
                <Input
                    variant="form"
                    label="Email"
                    name="email"
                    type="email"
                />
                <Input
                    variant="form"
                    label="Password"
                    name="password"
                    type="password"
                />
                <Button type="submit" className="w-full">
                    Sign In
                </Button>
            </form>

            <div className="relative">
                <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-white px-2 text-text-muted">Or</span>
                </div>
            </div>

            <SocialLoginButtons />
        </div>
    );
}
```

## Related Components

- [Server Actions Deep Dive](./server-actions-deep-dive.md) - Detailed documentation of all auth server actions
- [Web API Routes](./web-api-routes.md) - OAuth callback routes and authorization endpoint
- [UI Component Library](./ui-component-library.md) - Button and Input components used in auth forms
- [Settings Components](./settings-components.md) - SecuritySettings for password changes post-login
