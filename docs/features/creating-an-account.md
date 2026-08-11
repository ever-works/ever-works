---
id: creating-an-account
title: Creating an Account
sidebar_label: Creating an Account
---

# Creating an Account

An Ever Works account is what your Works, Agents, credits and settings hang off. You can create one
with an email address and a password, or with a social provider your installation has configured.

Signing up is not always the first thing you do: the [onboarding page](./onboarding.md) lets a
visitor generate a Work from a guest session first. This page covers the point where you turn that
into a real account — or start with one.

## Create an account with email and password

Go to **`/register`** — on the hosted platform, `https://app.ever.works/register`. The form asks for
four things:

| Field                | Notes                                                             |
| -------------------- | ----------------------------------------------------------------- |
| **Full name**        | At least 3 characters. This becomes your display name.            |
| **Email address**    | Must be a valid address; it is also your sign-in identifier.      |
| **Password**         | At least 8 characters — the hint under the field says so.         |
| **Confirm password** | Must match **Password** exactly, or the form refuses to submit.   |

Then tick **I agree to the Terms of Service and Privacy Policy** and choose **Create account**. The
checkbox is required: without it the form shows "Please accept the Terms of Service and Privacy
Policy to continue" and nothing is submitted.

Beyond the 8-character minimum shown in the form, a password must also contain at least one
lowercase letter and at least one number or special character, and it cannot begin with a dot or a
newline. If it does not, the form tells you which rule failed instead of creating the account.

If the email already has an account, you are told the address is already registered — use
[Sign in](#signing-in) or [Forgot password?](#if-you-forgot-your-password) instead.

### What the terms checkbox actually records

Ticking the box does not just unlock the button. The signup page fetches the legal documents you
must accept **before it renders**, in your locale, and shows you that exact text. When you submit,
the same documents are sent back and recorded against your new account:

- the **document id** and its **version**,
- the **SHA-256 digest** of the published document source,
- the **locale** the text was displayed in.

The digest is what makes the record meaningful: it pins the acceptance to the precise wording that
was on screen, so the text you agreed to can be reproduced exactly later. The server re-checks every
field against its published corpus before writing anything — a claim that points at text that was
never published is rejected rather than stored.

One consequence is worth knowing: if the required documents cannot be loaded, the checkbox and the
**Create account** button are both disabled and registration is blocked. That is deliberate. There
would be nothing truthful to record, so the form refuses rather than creating an account with an
empty consent record.

Acceptance is recorded once per document version, so a double-submitted form does not produce two
records that disagree about the time.

## Sign up or sign in with a social provider

Under the divider **Or sign up with**, the page offers the providers your installation has
configured. Ever Works supports four:

- **GitHub**
- **Google**
- **Facebook**
- **LinkedIn**

The list is resolved from the API at page load, so an installation that has configured only some of
them shows only those, and one that has configured none shows no social section at all. The same
buttons appear on the sign-in page under **Or continue with** — for a social provider, signing up
and signing in are the same action.

:::note
Connecting **GitHub** as a sign-in provider is not the same thing as connecting GitHub as your Git
storage. The [setup wizard](./onboarding.md) asks for that separately, and you can change it later
under **Settings → Git Providers**.
:::

## Signing in

Go to **`/login`**, enter your email address and password, and choose **Sign in**. Wrong details
give one undifferentiated "Invalid email or password" — the page never tells you whether the address
exists.

The sign-in page has two tabs:

| Tab                 | What it does                                         |
| ------------------- | ---------------------------------------------------- |
| **Password**        | Email and password.                                  |
| **Email me a link** | Sends a one-time sign-in link. No password required. |

The social buttons sit below either tab. The tab strip itself only appears when your installation
has magic links enabled — otherwise the page is just the password form.

### Signing in with a magic link

Choose **Email me a link**, enter your email address, and choose **Send magic link**. The page then
says *Check your inbox* and offers **Send another link** if the first one does not arrive.

A magic link **can only be used once and stays valid for 15 minutes**. Opening it takes you to a
short "Signing you in" page that redeems the token and drops you at the dashboard. If the link has
expired or has already been used, you get "This link can't be used" with a **Send a new link**
action rather than a silent failure.

The confirmation is phrased conditionally — *if* an account exists for that address, a sign-in link
was sent — and reads the same either way, so the page cannot be used to discover which addresses are
registered.

## If you forgot your password

On the sign-in page, choose **Forgot password?** (or go to `/forgot-password` directly). Enter your
email address and choose **Send Reset Link**. You will see "Check your email", along with a reminder
to look in your spam folder.

The email links to `/reset-password` with a token in the URL. There you set a new password twice.
The new password has to satisfy the same rules as a password chosen at signup — at least 8
characters, at least one lowercase letter, at least one number or special character, and not
starting with a dot — and the two fields have to match.

Once it succeeds you are sent back to sign-in with a "Password reset successful" banner. If you open
`/reset-password` without a valid token, the page says the link is invalid and offers **Request New
Reset Link** instead of an unusable form.

## What happens right after you sign up

Creating an account signs you in immediately — there is no "now go and log in" step — and takes you
straight to the dashboard as a new user. Two things follow:

1. **A verification email is sent to your address.** Until you confirm it, **Settings → Profile**
   shows a banner with a button to resend the message.
2. **The setup wizard opens.** It is the 10-step walkthrough that picks your AI, Git storage,
   database, deployment and more. Every step can be skipped, and every choice can be changed later
   in Settings — see [Onboarding & Setup Wizard](./onboarding.md).

## Related pages

- [Onboarding & Setup Wizard](./onboarding.md) — the guided walkthrough that opens next.
- [The Settings Map](./settings-map.md) — where everything you just chose lives afterwards.
- [API Authentication](../api/authentication.md) — the REST equivalents of these flows.
- [Teams & Organizations](../advanced/teams-and-organizations.md) — how your data is scoped once you
  create an Organization.
