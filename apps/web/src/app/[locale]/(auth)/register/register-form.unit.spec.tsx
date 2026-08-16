import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import en from '../../../../../messages/en.json';

/**
 * Signup form — EW-073, EW-074, EW-075.
 *
 * All three defects are the same shape: a rule the server enforces that the
 * page neither states nor checks, so the only way to discover it is to fill the
 * form in, submit, and read a banner that names something you cannot see. These
 * are deliberately RENDER tests — the defect lives in what reaches the screen
 * and in whether `register` is called at all, neither of which a predicate test
 * can observe.
 *
 * The translation mock resolves real strings out of `messages/en.json` rather
 * than echoing the key back. That matters twice over: a key that does not exist
 * fails loudly here instead of silently rendering its own name, and assertions
 * can be made against the words a user actually reads ("Full name", not
 * "Username").
 */

const { registerActionMock, refreshMock } = vi.hoisted(() => ({
    registerActionMock: vi.fn(),
    refreshMock: vi.fn(),
}));

/** Walks a dotted path and applies next-intl's `{placeholder}` substitution. */
function translate(path: string, values?: Record<string, unknown>): string {
    const value = path.split('.').reduce<unknown>((node, key) => {
        if (node && typeof node === 'object' && key in node) {
            return (node as Record<string, unknown>)[key];
        }
        throw new Error(`missing message key: ${path}`);
    }, en as unknown);

    if (typeof value !== 'string') throw new Error(`message key is not a string: ${path}`);

    return values
        ? value.replace(/\{(\w+)\}/g, (match, name) =>
              name in values ? String(values[name]) : match,
          )
        : value;
}

vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
        translate(`${namespace}.${key}`, values),
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
    useRouter: () => ({ push: vi.fn(), refresh: refreshMock }),
}));

vi.mock('@/app/actions/auth', () => ({
    register: registerActionMock,
    connectProvider: vi.fn(),
}));

vi.mock('@/components/theme-toggle', () => ({ ThemeToggle: () => null }));

import RegisterForm from './register-form';
import type { TermsAcceptanceDocument } from '@/lib/api/types-only';

const TERMS: TermsAcceptanceDocument[] = [
    {
        documentId: 'tos:default',
        version: '2026-01-01',
        sha256: 'a'.repeat(64),
        locale: 'en',
        url: '/tos',
    } as TermsAcceptanceDocument,
    {
        documentId: 'privacy:default',
        version: '2026-01-01',
        sha256: 'b'.repeat(64),
        locale: 'en',
        url: '/privacy',
    } as TermsAcceptanceDocument,
];

/** Fills every field and ticks consent, then submits. */
function fillAndSubmit({ name = 'Jane Doe', password = 'lowercase1' } = {}) {
    fireEvent.change(screen.getByLabelText(en.auth.register.form.name.label), {
        target: { value: name },
    });
    fireEvent.change(screen.getByLabelText(en.auth.register.form.email.label), {
        target: { value: 'jane@example.com' },
    });
    fireEvent.change(screen.getByLabelText(en.auth.register.form.password.label), {
        target: { value: password },
    });
    fireEvent.change(screen.getByLabelText(en.auth.register.form.confirmPassword.label), {
        target: { value: password },
    });
    fireEvent.click(screen.getByRole('checkbox'));

    // Submit the FORM, not the button: React 19 attaches its form-action
    // handling to the submit event and calls `new FormData(event.target)`,
    // which throws in jsdom when the target is the button element.
    const form = screen
        .getByRole('button', { name: en.auth.register.form.submit })
        .closest('form') as HTMLFormElement;
    fireEvent.submit(form);
}

function renderForm(termsDocuments: TermsAcceptanceDocument[] = TERMS) {
    return render(<RegisterForm availableSocialProviders={[]} termsDocuments={termsDocuments} />);
}

beforeEach(() => {
    registerActionMock.mockReset();
    registerActionMock.mockResolvedValue({ success: true });
    refreshMock.mockReset();
});

describe('signup — the stated password rules match the enforced ones (EW-073)', () => {
    it('control: a password satisfying every rule reaches the register action', async () => {
        // Without this, "the action was not called" below could be satisfied by
        // the form being broken in some way that has nothing to do with the
        // password.
        renderForm();
        fillAndSubmit({ password: 'lowercase1' });

        await waitFor(() => expect(registerActionMock).toHaveBeenCalledTimes(1));
        expect(registerActionMock.mock.calls[0][2]).toBe('lowercase1');
    });

    it('the hint states every rule the server applies, not just the length', () => {
        renderForm();

        const hint = en.auth.register.form.password.hint;
        expect(screen.getByText(hint)).toBeTruthy();

        // The three rules that were enforced in silence. Asserted on the text
        // the user sees, so a hint that regresses to length-only fails here.
        expect(hint).toMatch(/lowercase/i);
        expect(hint).toMatch(/number|special/i);
        expect(hint).toMatch(/8/);
    });

    it('an all-uppercase 10-character password is refused with the rule it broke', async () => {
        // The reported case: passes the on-screen length rule, passes the only
        // check the page ran, and is rejected by `actions/auth.ts` for want of
        // a lowercase letter.
        renderForm();
        fillAndSubmit({ password: 'PASSWORD12' });

        expect(await screen.findByText(en.validation.auth.password.lowercase)).toBeTruthy();
        expect(registerActionMock).not.toHaveBeenCalled();
    });

    it('a password with no number or special character is refused before submit', async () => {
        renderForm();
        fillAndSubmit({ password: 'onlyletters' });

        expect(await screen.findByText(en.validation.auth.password.numberOrSpecial)).toBeTruthy();
        expect(registerActionMock).not.toHaveBeenCalled();
    });

    it('a password starting with a dot is refused before submit', async () => {
        renderForm();
        fillAndSubmit({ password: '.lowercase1' });

        expect(await screen.findByText(en.validation.auth.password.cannotStartWith)).toBeTruthy();
        expect(registerActionMock).not.toHaveBeenCalled();
    });

    it('the too-short message still fires, and only for a short password', async () => {
        renderForm();
        fillAndSubmit({ password: 'short1' });

        expect(await screen.findByText(en.auth.register.errors.passwordTooShort)).toBeTruthy();
        expect(registerActionMock).not.toHaveBeenCalled();
    });
});

describe('signup — the client never rejects what the API accepts (EW-076)', () => {
    it('accepts a password whose only special character is an underscore', async () => {
        // `abcdefg_` satisfies the API's `/^(?=.*[a-z])(?=.*[\d\W_]).{8,}$/`.
        // The old web rule `/(\d|\W)/` did not match `_`, so the form told the
        // user their password lacked a number or special character while the
        // server would have taken it.
        renderForm();
        fillAndSubmit({ password: 'abcdefg_' });

        await waitFor(() => expect(registerActionMock).toHaveBeenCalledTimes(1));
        expect(screen.queryByText(en.validation.auth.password.numberOrSpecial)).toBeNull();
    });
});

describe('signup — the name field names itself (EW-074)', () => {
    it('states its minimum next to the field', () => {
        renderForm();

        expect(
            screen.getByText(translate('auth.register.form.name.hint', { length: 3 })),
        ).toBeTruthy();
    });

    it('rejects a two-character name before submit, naming the field on screen', async () => {
        renderForm();
        fillAndSubmit({ name: '山田' });

        const message = await screen.findByText(
            translate('validation.auth.name.minLength', { length: 3 }),
        );

        // The message must describe the field the form actually shows.
        expect(message.textContent).toMatch(/full name/i);
        expect(message.textContent).not.toMatch(/username/i);
        expect(registerActionMock).not.toHaveBeenCalled();
    });

    it('the old message that named a non-existent field is no longer what signup uses', () => {
        // `validation.auth.username.minLength` still exists — the profile
        // settings form edits a real username and is right to use it. What
        // must not happen is signup reaching for it again.
        expect(en.validation.auth.username.minLength).toMatch(/username/i);
        expect(en.validation.auth.name.minLength).not.toMatch(/username/i);
    });

    it('a three-character name is accepted', async () => {
        renderForm();
        fillAndSubmit({ name: '山田家' });

        await waitFor(() => expect(registerActionMock).toHaveBeenCalledTimes(1));
        expect(registerActionMock.mock.calls[0][0]).toBe('山田家');
    });

    it('padding with spaces does not fake the minimum', async () => {
        // The counterpart to the rule above: the check is on the trimmed
        // length, and `register`'s schema trims too, so the two agree rather
        // than the client being the stricter of the pair.
        renderForm();
        fillAndSubmit({ name: '  山田  ' });

        expect(
            await screen.findByText(translate('validation.auth.name.minLength', { length: 3 })),
        ).toBeTruthy();
        expect(registerActionMock).not.toHaveBeenCalled();
    });
});

describe('signup — an unloadable legal corpus explains itself (EW-075)', () => {
    it('control: with the documents loaded, no failure notice is shown', () => {
        renderForm();
        expect(screen.queryByRole('alert')).toBeNull();
        expect(
            (
                screen.getByRole('button', {
                    name: en.auth.register.form.submit,
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(false);
    });

    it('says why the form is inert instead of being silently disabled', () => {
        renderForm([]);

        const alert = screen.getByRole('alert');
        expect(alert.textContent).toContain(en.auth.register.errors.termsUnavailable.title);
        expect(alert.textContent).toContain(en.auth.register.errors.termsUnavailable.message);

        // The submit stays blocked — the explanation is added, the guard is not
        // traded away for it.
        expect(
            (
                screen.getByRole('button', {
                    name: en.auth.register.form.submit,
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
    });

    it('offers a retry that re-runs the server component which loads the corpus', () => {
        renderForm([]);

        fireEvent.click(
            screen.getByRole('button', { name: en.auth.register.errors.termsUnavailable.retry }),
        );

        expect(refreshMock).toHaveBeenCalledTimes(1);
    });
});
