# Cross-repository issue drafts — Ever ID adoption

**Epic**: [`APW-12-ever-id`](../spec.md) · **Created**: 2026-09-17 · **Revised**: 2026-10-01 · **Owner**: APW-12

The Teams and Gauzy halves of this epic land in **other repositories**
([`cross-platform.md`](../cross-platform.md) §4–§5, tasks T35–T42), where nothing is tracked until an issue
exists there. These files hold those issue bodies, filed on 2026-10-01 as ever-co/ever-gauzy#10368 and
ever-co/ever-teams#4502. Every cited path was re-verified on 2026-10-01 at
`ever-co/ever-gauzy` `develop` `84a527d85` and `ever-co/ever-teams` `develop` `e6ebffadb`; re-verify again before
editing a filed issue, and keep the issue and the draft in step.

| Repository           | Draft                              | Lands                                                                                                           | Issue                                                        | Why it needs its own reviewed change                                                                                         |
| -------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `ever-co/ever-gauzy` | [`ever-gauzy.md`](./ever-gauzy.md) | right after Ever Works, on development and stage; production last, in a separate owner-supervised change        | [#10368](https://github.com/ever-co/ever-gauzy/issues/10368) | Gauzy's API also serves Ever Teams; one plugin, server-side and default off first, the production switch last and supervised |
| `ever-co/ever-teams` | [`ever-teams.md`](./ever-teams.md) | with Gauzy, on development and stage, once the Gauzy plugin's token route exists there; production with Gauzy's | [#4502](https://github.com/ever-co/ever-teams/issues/4502)   | Adds a sign-in button and three small routes; it relies entirely on the Gauzy API for accounts, links and sign-out           |

**Rules that apply to both** (they are binding here, in `cross-platform.md` and in
[`../idp-options.md`](../idp-options.md) §7):

1. **Pure addition.** Every existing sign-in method keeps working, unchanged: an e-mail/password or social sign-in that
   works today must still work with Ever ID off and on.
2. **One plugin, nothing in core.** Gauzy's Ever ID integration is the `auth-zitadel` plugin
   (`packages/plugins/auth-zitadel`), registered by one import and one conditional entry in `apps/api/src/plugins.ts`.
   `packages/core` sign-in code, `packages/config`, `FeatureEnum` and `packages/contracts` gain nothing for Ever ID;
   `packages/auth/src/lib/internal.ts` changes only by the Keycloak lines moving into the `auth-keycloak` plugin. Its
   one migration sits in core's migration directory only until Gauzy plugins can carry their own.
3. **Flags are environment variables, fail closed and are read strictly as `'true'`.** `ZITADEL_ENABLED` loads the
   plugin; `ZITADEL_AUTH_LINK` shows Gauzy's button; on Teams the provider exists only when
   `NEXT_PUBLIC_EVER_ID_APP_NAME`, the issuer and the client are all set. An unset or misspelled value means off.
4. **No tokens in addresses.** The callback hands off a one-time key; the existing hand-off patterns are neither
   extended nor reused for cross-site sign-in.
5. **Production is last.** Gauzy production (which also serves Ever Teams Cloud) is a separate, owner-supervised change
   with backups verified first ([`cross-platform.md`](../cross-platform.md) §5.4, task T42).
6. **Public repositories stay public-safe.** No hostnames, addresses or unfixed findings in an issue body; the
   provider's placement lives in the private operations repository.
