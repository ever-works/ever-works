# No sign-on claims — translated term list (draft)

The App Launcher opens addresses; it never signs anyone in. Until **Ever ID** (APW-12) ships, no string on any
launcher surface may say or imply single sign-on, "one login", "already signed in" or a shared account
(launch-parity backlog **G-09**, spec ACC-11-33). Task **T21** enforces the English half with a regular
expression and the other 20 locales with this list.

**How T21 uses it.** The spec loads `dashboard.appLauncher`, `dashboard.settings.appLauncher` and
`dashboard.workDetail.settings.appLauncher` from every file in `apps/web/messages/` and fails when a value
matches the English pattern **or** any phrase below whose row is marked `reviewed`. A row marked `seeded` is a
starting point: it is either confirmed by a native reviewer (then flip it to `reviewed`) or replaced with the
phrasing that locale actually uses. Nothing here is removed when APW-12 ships — the list is relaxed only for
the specific strings APW-12 approves (T29).

**Review state.** `reviewed` = a native reviewer has confirmed the phrase is the one a reader of that locale
would recognise as a sign-on claim. `seeded` = written from the languages' common usage and awaiting that
review. Adding a phrase never removes one; a row that is wrong should be corrected in place and noted in the
pull request.

| Locale     | File      | Phrase(s) to forbid                                        | State    |
| ---------- | --------- | ---------------------------------------------------------- | -------- |
| English    | `en.json` | `single sign-on`, `sso`, `one login`, `already signed in`  | reviewed |
| Arabic     | `ar.json` | `تسجيل الدخول الموحد`, `دخول موحد`                         | seeded   |
| Bulgarian  | `bg.json` | `еднократно влизане`, `единен вход`                        | seeded   |
| German     | `de.json` | `Einmalanmeldung`, `Single Sign-on`, `einmaliges Anmelden` | seeded   |
| Spanish    | `es.json` | `inicio de sesión único`, `autenticación única`            | seeded   |
| French     | `fr.json` | `authentification unique`, `connexion unique`              | seeded   |
| Hebrew     | `he.json` | `כניסה חד פעמית`, `זיהוי מאוחד`                            | seeded   |
| Hindi      | `hi.json` | `सिंगल साइन-ऑन`, `एक बार लॉगिन`                            | seeded   |
| Indonesian | `id.json` | `masuk tunggal`, `satu kali masuk`                         | seeded   |
| Italian    | `it.json` | `accesso unico`, `single sign-on`                          | seeded   |
| Japanese   | `ja.json` | `シングルサインオン`, `一度のログイン`                     | seeded   |
| Korean     | `ko.json` | `싱글 사인온`, `한 번 로그인`                              | seeded   |
| Dutch      | `nl.json` | `eenmalige aanmelding`, `single sign-on`                   | seeded   |
| Polish     | `pl.json` | `pojedyncze logowanie`, `jednokrotne logowanie`            | seeded   |
| Portuguese | `pt.json` | `início de sessão único`, `login único`                    | seeded   |
| Russian    | `ru.json` | `единый вход`, `однократный вход`                          | seeded   |
| Thai       | `th.json` | `ลงชื่อเข้าใช้ครั้งเดียว`                                  | seeded   |
| Turkish    | `tr.json` | `tek oturum açma`, `tek seferlik giriş`                    | seeded   |
| Ukrainian  | `uk.json` | `єдиний вхід`, `одноразовий вхід`                          | seeded   |
| Vietnamese | `vi.json` | `đăng nhập một lần`, `đăng nhập hợp nhất`                  | seeded   |
| Chinese    | `zh.json` | `单点登录`, `一次登录`                                     | seeded   |

**What the copy must say instead.** The launcher's own wording is in spec §6: the footer reads
`Opens in a new tab. You may need to sign in.`, and the P2 signed-out state reads
`Sign in with Ever ID to see your apps here.` Both are permitted by the guard: they say a person **may need**
to sign in, which is true, and never claim a shared session.
