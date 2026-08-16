'use client';

import { useState, useTransition } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { COMPANY_OWNER_WEBSITE } from '@/lib/constants';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { useTranslations } from 'next-intl';
import { SocialLoginButtons } from '@/components/auth/social-login';
import { register as registerAction } from '@/app/actions/auth';
import { PASSWORD_RULES, VALIDATION_RULES } from '@/app/actions/validation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';
import { ThemeToggle } from '@/components/theme-toggle';
import { OAuthProvider } from '@/lib/api/enums';
import type { TermsAcceptanceDocument } from '@/lib/api/types-only';

interface RegisterFormProps {
    availableSocialProviders: OAuthProvider[];
    /**
     * The legal documents this signup must accept, resolved server-side from the
     * published corpus. Empty means they could not be loaded, and registration
     * is blocked — see `termsUnavailable` below.
     */
    termsDocuments: TermsAcceptanceDocument[];
}

export default function RegisterForm({
    availableSocialProviders,
    termsDocuments,
}: RegisterFormProps) {
    const t = useTranslations('auth.register');
    // The rules this form has to state are already written, and already
    // translated into all 21 locales, under `validation.auth` — they are the
    // very strings the server action returns when it rejects. Reusing them
    // keeps the message a user reads BEFORE submit identical to the one they
    // would otherwise have read after.
    const tv = useTranslations('validation.auth');
    const [isPending, startTransition] = useTransition();
    const router = useRouter();

    const [formData, setFormData] = useState({
        name: '',
        email: '',
        password: '',
        confirmPassword: '',
        // The terms checkbox used to be uncontrolled — rendered with a bare
        // HTML5 `required`, absent from this object, never posted. It gated the
        // submit button and its value went nowhere, so the account was created
        // with no record that anything had been accepted. It is part of the form
        // state now, and the value it carries reaches the server.
        acceptedTerms: false,
    });

    /**
     * Errors keyed by the field they belong to.
     *
     * This used to be a single `error` string rendered as a banner above the
     * form. Every rule the server enforced and the page did not — lowercase,
     * number-or-special, no leading dot, the name minimum — arrived as that
     * banner, detached from the input that caused it, after a round trip. The
     * sibling reset-password form already keys its errors by field; this
     * matches it.
     */
    const [errors, setErrors] = useState<{
        name?: string;
        password?: string;
        confirmPassword?: string;
        general?: string;
    }>({});

    // Nothing to pin an acceptance to means nothing truthful to record, so the
    // form refuses rather than registering silently.
    const termsUnavailable = termsDocuments.length === 0;

    // EW-075: that refusal was correct and completely silent. With the corpus
    // unloaded the checkbox, Create account and every social button went
    // disabled, nothing said why, and there was no way forward short of
    // reloading the page by hand — a signup that looks broken rather than
    // temporarily unavailable. `router.refresh()` re-runs the server component
    // that fetches the corpus, so a transient upstream failure is retryable in
    // place; a persistent one at least explains itself.
    const [isRetrying, startRetry] = useTransition();
    const retryTerms = () => startRetry(() => router.refresh());

    /**
     * The password rules the server action will apply, in the order it applies
     * them, each paired with the message it would have returned.
     *
     * The regexes are imported rather than restated: the whole defect class
     * here (EW-073, EW-076) is a client that disagrees with the server about
     * what a valid password is, and a second copy of `/[\d\W_]/` in this file
     * would be the next instance of it.
     */
    const passwordError = (password: string): string | undefined => {
        if (password.length < PASSWORD_RULES.MIN_LENGTH) {
            return t('errors.passwordTooShort');
        }
        if (!PASSWORD_RULES.LOWERCASE.test(password)) {
            return tv('password.lowercase');
        }
        if (!PASSWORD_RULES.NUMBER_OR_SPECIAL.test(password)) {
            return tv('password.numberOrSpecial');
        }
        if (!PASSWORD_RULES.NOT_STARTING_WITH_DOT_OR_NEWLINE.test(password)) {
            return tv('password.cannotStartWith');
        }
        return undefined;
    };

    /**
     * Where to send someone who wants to READ what they are accepting.
     *
     * Resolved from the documents this form was handed, so the link and the
     * recorded acceptance can never disagree. `url` is a site-relative path on
     * the company website (e.g. `/tos`), so it is resolved against
     * COMPANY_OWNER_WEBSITE. Falls back to that same path convention when a
     * document omits `url` — never to the old in-app paths, which have no pages.
     */
    const legalHref = (kind: 'tos' | 'privacy') => {
        const doc = termsDocuments.find((d) => d.documentId.startsWith(`${kind}:`));
        return new URL(doc?.url || `/${kind}`, COMPANY_OWNER_WEBSITE).toString();
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setErrors({});

        // EW-074: the minimum was enforced but never shown. A two-character
        // entry was accepted by the page, posted, and came back as "Username
        // must contain at least 3 characters" — a rule about a field this form
        // does not display. It is checked here now, against the same constant
        // the action uses, and reported against the field actually filled in.
        if (formData.name.trim().length < VALIDATION_RULES.USERNAME_MIN_LENGTH) {
            setErrors({
                name: tv('name.minLength', { length: VALIDATION_RULES.USERNAME_MIN_LENGTH }),
            });
            return;
        }

        if (formData.password !== formData.confirmPassword) {
            setErrors({ confirmPassword: t('errors.passwordsDoNotMatch') });
            return;
        }

        // EW-073: only the length was checked here, so a 10-character
        // ALL-UPPERCASE password satisfied every rule the page stated and every
        // rule the page enforced, and was still rejected by the action. All
        // four rules run now, and the failing one is named against the field.
        const invalidPassword = passwordError(formData.password);
        if (invalidPassword) {
            setErrors({ password: invalidPassword });
            return;
        }

        if (!formData.acceptedTerms || termsUnavailable) {
            setErrors({ general: t('errors.termsNotAccepted') });
            return;
        }

        startTransition(async () => {
            const response = await registerAction(
                formData.name,
                formData.email,
                formData.password,
                // Exactly what was displayed: document id, version, digest and
                // locale. The API re-checks each against the published corpus
                // before it becomes a row.
                termsDocuments.map(({ documentId, version, sha256, locale }) => ({
                    documentId,
                    version,
                    sha256,
                    locale,
                })),
            );

            if (response && !response.success) {
                setErrors({ general: response.error || t('errors.generic') });
            }
        });
    };

    return (
        <AuthLayout
            title={t('title')}
            subtitle={t('subtitle')}
            formWidth="lg:w-3/5"
            innerMaxWidth="max-w-xl"
            mLeft="lg:-ml-10"
        >
            <ThemeToggle variant="fixed" />
            <form onSubmit={handleSubmit} className="space-y-4">
                {errors.general && (
                    <div className="bg-danger/10 border border-danger/20 text-danger px-4 py-3 rounded-lg text-sm">
                        {errors.general}
                    </div>
                )}

                {/*
                 * EW-075: say why the form is inert, and offer the way out.
                 * Without this the page is a set of disabled controls with no
                 * explanation — indistinguishable from a broken build, and with
                 * nothing to click that would ever change it.
                 */}
                {termsUnavailable && (
                    <div
                        role="alert"
                        className="bg-warning/10 border border-warning/20 px-4 py-3 rounded-lg text-sm space-y-3"
                    >
                        <div>
                            <p className="font-medium text-text dark:text-text-dark">
                                {t('errors.termsUnavailable.title')}
                            </p>
                            <p className="mt-1 text-text-secondary dark:text-text-secondary-dark">
                                {t('errors.termsUnavailable.message')}
                            </p>
                        </div>

                        <Button
                            type="button"
                            onClick={retryTerms}
                            loading={isRetrying}
                            disabled={isRetrying}
                            size="sm"
                        >
                            {t('errors.termsUnavailable.retry')}
                        </Button>
                    </div>
                )}

                <div className="lg:grid grid-cols-2 gap-4">
                    <Input
                        type="text"
                        label={t('form.name.label')}
                        name="name"
                        placeholder={t('form.name.placeholder')}
                        value={formData.name}
                        onChange={(e) => {
                            setFormData({ ...formData, name: e.target.value });
                            setErrors((prev) => ({ ...prev, name: undefined }));
                        }}
                        error={errors.name}
                        // EW-074: the 3-character minimum was undisclosed. It is
                        // the API's `@MinLength(3)` on `username`, so it is
                        // stated from the same constant the checks read.
                        helperText={t('form.name.hint', {
                            length: VALIDATION_RULES.USERNAME_MIN_LENGTH,
                        })}
                        required
                        disabled={isPending}
                        className="text-sm shadow-sm"
                    />

                    <Input
                        type="email"
                        label={t('form.email.label')}
                        name="email"
                        placeholder={t('form.email.placeholder')}
                        value={formData.email}
                        onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                        required
                        disabled={isPending}
                        className="text-sm shadow-sm"
                    />

                    <Input
                        type="password"
                        name="password"
                        label={t('form.password.label')}
                        placeholder={t('form.password.placeholder')}
                        value={formData.password}
                        onChange={(e) => {
                            setFormData({ ...formData, password: e.target.value });
                            setErrors((prev) => ({ ...prev, password: undefined }));
                        }}
                        error={errors.password}
                        // EW-073: this said only "Must be at least 8
                        // characters" while three further rules were being
                        // enforced. It now carries the sibling reset flow's
                        // wording, which already states all of them and is
                        // already translated into all 21 locales.
                        helperText={t('form.password.hint')}
                        required
                        disabled={isPending}
                        className="text-sm shadow-sm"
                    />

                    <Input
                        type="password"
                        name="confirmPassword"
                        label={t('form.confirmPassword.label')}
                        placeholder={t('form.confirmPassword.placeholder')}
                        value={formData.confirmPassword}
                        onChange={(e) => {
                            setFormData({ ...formData, confirmPassword: e.target.value });
                            setErrors((prev) => ({ ...prev, confirmPassword: undefined }));
                        }}
                        error={errors.confirmPassword}
                        required
                        disabled={isPending}
                        className="text-sm shadow-sm"
                    />
                </div>

                <div className="flex items-center mb-6">
                    {/*
                        Controlled, and its value is submitted. Previously this
                        was uncontrolled with only HTML5 `required`: the browser
                        blocked the submit until it was ticked and then the tick
                        was discarded, which is the appearance of consent with
                        none of the evidence.
                    */}
                    <input
                        id="terms"
                        type="checkbox"
                        required
                        checked={formData.acceptedTerms}
                        onChange={(e) =>
                            setFormData({ ...formData, acceptedTerms: e.target.checked })
                        }
                        disabled={isPending || termsUnavailable}
                        className="w-4 h-4 mt-0.5 bg-surface-secondary dark:bg-surface-secondary-dark border-border dark:border-border-dark rounded text-primary focus:ring-primary"
                    />

                    <label
                        htmlFor="terms"
                        className="ml-2 text-xs text-text-secondary dark:text-text-secondary-dark"
                    >
                        {t('form.terms.text')}{' '}
                        {/*
                         * Both hrefs come from the SAME documents whose acceptance
                         * this form records, so the page a user reads can never
                         * drift from the version they are agreeing to.
                         *
                         * They used to be hardcoded `/terms` and `/privacy`, and
                         * BOTH 404'd: those paths are declared public in
                         * constants.ts but no page exists behind them, so the
                         * signup told users they were agreeing to documents it
                         * then failed to show. The corpus has always carried the
                         * real locations — `/tos` and `/privacy` on the marketing
                         * site — which is also why `/terms` was never going to
                         * work: it is simply not the path.
                         */}
                        <a
                            href={legalHref('tos')}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:text-primary-hover"
                        >
                            {t('form.terms.termsLink')}
                        </a>{' '}
                        {t('form.terms.and')}{' '}
                        <a
                            href={legalHref('privacy')}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:text-primary-hover"
                        >
                            {t('form.terms.privacyLink')}
                        </a>
                    </label>
                </div>

                <Button
                    type="submit"
                    disabled={isPending || termsUnavailable}
                    loading={isPending}
                    fullWidth
                    className="bg-primary hover:bg-primary-hover"
                >
                    {isPending ? t('form.submitting') : t('form.submit')}
                </Button>

                {availableSocialProviders.length > 0 && (
                    <>
                        <div className="relative">
                            <div className="absolute inset-0 flex items-center">
                                <div className="w-full border-t border-border dark:border-border-dark" />
                            </div>

                            <div className="relative flex justify-center text-sm">
                                <span className="bg-background dark:bg-background-dark px-2 text-text-muted dark:text-text-muted-dark">
                                    {t('socialSignUp.divider')}
                                </span>
                            </div>
                        </div>

                        {/*
                         * Gated on the SAME condition as Create account. These
                         * buttons sit inside this form but are type="button",
                         * so they never triggered the required checkbox's
                         * validation and never reached handleSubmit — a click
                         * created a real account with consent unticked, and
                         * with the documents unloaded even though the email
                         * path refuses in that state.
                         */}
                        <SocialLoginButtons
                            providers={availableSocialProviders}
                            disabled={!formData.acceptedTerms || termsUnavailable}
                            disabledReason={t('form.terms.required')}
                        />
                    </>
                )}

                <p className="text-center text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('signIn.text')}{' '}
                    <Link
                        href={ROUTES.AUTH_LOGIN}
                        className="text-primary hover:text-primary-hover font-medium transition-colors"
                    >
                        {t('signIn.link')}
                    </Link>
                </p>
            </form>
        </AuthLayout>
    );
}
