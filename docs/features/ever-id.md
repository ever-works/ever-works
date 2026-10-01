---
id: ever-id
title: Ever ID
sidebar_label: Ever ID
---

# Ever ID

**Ever ID** is one identity you can use to sign in to Ever apps. On an Ever Works installation where it is turned on, **Sign in with Ever ID** appears next to the other sign-in methods. Nothing else changes: e-mail and password, magic link, GitHub and Google sign-in keep working exactly as they do today, and you can keep using them.

:::note Available only where it is turned on
Ever ID is off by default. A platform administrator turns it on for an installation; until then the button is not shown and nothing about signing in changes.
:::

## Signing in

Choose **Sign in with Ever ID** on the sign-in page, sign in at Ever ID, and you come back signed in to the page you were heading to.

- **Your Ever ID is connected to an account** — you are signed in to that account.
- **You are new to Ever Works** — a **Create your Ever Works account** screen shows the name and e-mail address from Ever ID and the terms to accept. The account is created only when you press **Create account**; closing the screen creates nothing.
- **An account already uses your e-mail address** — Ever Works does not connect the two on its own. Sign in to that account the way you usually do, then connect Ever ID from **Settings → Security** (below). An e-mail address alone never decides which account you sign in to.
- **Your e-mail address is not verified at Ever ID** — verify it there first, then try again.

## Connecting and disconnecting

Open **Settings → Security → Connected identities**.

- **Connect Ever ID** asks you to sign in to Ever ID again, then shows a confirmation with both e-mail addresses. If they differ, the screen says so; connect only if both are yours. After you confirm, you can sign in to this account with Ever ID. For your security, connecting needs a sign-in to Ever Works from the last 12 hours.
- **Disconnect** removes the connection. Other devices that were signed in with Ever ID are signed out; the device you are using stays signed in. You cannot disconnect Ever ID when it is the only way left to sign in to the account — add a password first.

An Ever ID can be connected to only one Ever Works account, and an account can have one Ever ID.

## Signing out

When you signed in with Ever ID, **Sign out** offers **Also sign out of Ever ID** (unticked). Leave it unticked to sign out of Ever Works only; tick it to sign out of Ever ID too.

If you sign out of Ever ID somewhere else, the Ever Works sessions you opened with Ever ID end as well, and you see **You were signed out of Ever ID.** the next time a page loads. Sessions you opened with a password are not affected.

## Signing in from a terminal

The CLI can sign you in with a short code instead of a browser redirect:

```bash
ever-works auth login --ever-id
```

It prints an address and a code. Open the address, enter the code and approve; the terminal then shows **Signed in as …**. No token is ever printed. Your Ever ID must already be connected to your account (connect it in **Settings → Security** first) — the terminal never creates accounts. The existing `ever-works auth login` browser sign-in keeps working unchanged.

## Apps that can see your App Works

Another Ever app you are signed in to with Ever ID can list your App Works — read-only — for example in its app launcher. The **Connected identities** card lists every app that did so in the last 30 days, with when it last did, and links to Ever ID to manage them. Such access never signs anyone in to Ever Works and cannot change anything.

## For administrators

Ever ID is provided by the built-in `oidc-identity` plugin, an OpenID Connect relying party that works with any standards-compliant provider. Configure the issuer, the client and its secret through the environment (see `apps/api/.env.example` and [Built-in Plugins](../plugin-system/built-in-plugins.md#identity)), then, signed in as a platform administrator, open the administration page at `/settings/admin/ever-id` (it is not linked from the menus):

1. **Test connection** checks the provider's discovery document and reports one row per check within 5 seconds. The client secret is never shown.
2. **Turn on** runs the test again and turns Ever ID on only when every required check passes. Every change is recorded in Activity.
3. **Turn off** at any time: the button disappears and the sign-in routes answer "not found" within seconds, while people can still list and disconnect connected identities.
4. **Settings** on the same page change the values an administrator manages: the label, the **Manage in Ever ID** address, the terminal clients allowed to sign in with a code, and the names shown for apps that read App Works. The issuer, the client and its secret stay operator configuration. Each change is recorded in Activity, naming the fields but never their values.

While Ever ID is off, the installation makes no request to the provider.
