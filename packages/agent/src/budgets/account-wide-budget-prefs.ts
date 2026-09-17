/**
 * The account-wide cap preferences, narrowed for `BudgetService.summarizeForUser`.
 *
 * `accountWideMonthlyCapCents` is a bigint column serialized as a string on
 * the wire (so power-user caps survive), and it is narrowed through
 * `Number(...)` at every reader: the `GET /me/usage/account-wide` endpoint and
 * the Home spend panel. One helper keeps both readers on the same rule — a
 * value that does not narrow to a finite number reads as "no cap".
 */
export interface AccountWideBudgetPrefsSource {
    accountWideMonthlyCapCents: string | number | null;
    accountWideAllowOverage: boolean;
}

export interface AccountWideBudgetPrefs {
    capCents: number | null;
    allowOverage: boolean;
}

export function toAccountWideBudgetPrefs(
    prefs: AccountWideBudgetPrefsSource,
): AccountWideBudgetPrefs {
    const raw = prefs.accountWideMonthlyCapCents;
    const capCents = raw === null ? null : Number(raw);
    return {
        capCents: Number.isFinite(capCents) ? capCents : null,
        allowOverage: prefs.accountWideAllowOverage,
    };
}
