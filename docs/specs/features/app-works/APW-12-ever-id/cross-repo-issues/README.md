# Cross-repository issue drafts — Ever ID adoption

**Epic**: [`APW-12-ever-id`](../spec.md) · **Created**: 2026-09-17 · **Owner**: APW-12

The Teams and Gauzy halves of this epic land in **other repositories**
([`cross-platform.md`](../cross-platform.md) §4–§5, tasks T35–T42), where nothing is tracked until an issue
exists there. These files are those issue bodies, ready to file. They are drafts, not commitments: **re-verify
every cited path at the target repository's current head before filing**, then update the row in this table with
the issue number.

| Repository           | Draft                              | Lands       | Why it needs its own reviewed change                                                                                       |
| -------------------- | ---------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ever-co/ever-teams` | [`ever-teams.md`](./ever-teams.md) | Wave 2 (P2) | First platform to adopt Ever ID; adds a sign-in button, a connect flow and the launcher token route                        |
| `ever-co/ever-gauzy` | [`ever-gauzy.md`](./ever-gauzy.md) | Wave 3 (P3) | **The only production platform today.** Server-side and default-off first; production flag last and by owner approval only |

**Rules that apply to both** (they are binding here, in `cross-platform.md` and in
[`../idp-options.md`](../idp-options.md) §7):

1. **Pure addition.** Every existing sign-in method keeps working, unchanged and untested-against-nothing: an
   e-mail/password or social sign-in that works today must still work with the Ever ID flags both off and on.
2. **Nothing in core.** The Gauzy integration is a plugin (`@gauzy/plugin-*`, registered through
   `apps/api/src/plugins.ts`), not an edit to `packages/core`, `packages/auth/src/lib/internal.ts` or
   `packages/config`. The `zitadel`, `keycloak`, `supertokens` and `auth0` provider plugins are independent and
   each fails closed when unconfigured.
3. **Flags fail closed and are read strictly as `'true'`.** `FEATURE_EVER_ID_API` and `FEATURE_EVER_ID_LOGIN`
   are evaluated inside the plugin; an unset or misspelled value means off.
4. **No tokens in addresses.** The callback hands off a one-time code; the existing hand-off patterns are neither
   extended nor reused for cross-site sign-in.
5. **Production is last.** Gauzy production is a separate, owner-approved change with backups verified first
   ([`cross-platform.md`](../cross-platform.md) §5, tasks T42).
6. **Public repositories stay public-safe.** No hostnames, addresses or unfixed findings in an issue body; the
   provider's placement lives in the private operations repository.
