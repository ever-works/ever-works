/**
 * APW-05 T8 — the embedded verification script, as the generated workflow
 * carries it (`run: |` under the "Verify in the runner" step of §2.4).
 *
 * ## This is a deliberate interlock shell, not the verification
 *
 * Plan §4.3 gives T15 `src/workflow/verify-runner.sh.ts` — "the embedded
 * verification script as a template literal": the plan schema check, the 12 GiB
 * refusal, the throwaway dependency containers, the recipe materialisation into a
 * `0600` env file, the readiness waits, the smoke requests, the shred. **None of
 * that exists yet.** T8 needs *a* script because §2.4's step list carries the
 * step and T12/T13's observation and classification paths key off its name
 * ("Verify in the runner" → `verificationFailed`, plan §4.9 row 10).
 *
 * So the constant below does the only honest thing an unfinished script can do:
 * it **fails loudly**, before touching anything, naming the task that owes the
 * real one. A verification Build dispatched today ends `failed` with
 * `EW_VERIFY_NOT_IMPLEMENTED` on its stderr — it does not report success, does not
 * silently skip the checks the owner asked for, and cannot be mistaken for a
 * passing verification.
 *
 * **T15 replaces this constant's body** (`EMBEDDED_VERIFY_RUNNER_SCRIPT`) and
 * leaves the name, the export and its use in `generator.ts` alone. Because the
 * generator hashes the script into the canonical inputs
 * (`verifyRunnerScriptSha256`), that replacement moves `inputsHash` on its own and
 * every App Work gets a commit or pull request with the new file on its next
 * preparation (plan §4.5) — no second place to remember.
 */
export const EMBEDDED_VERIFY_RUNNER_SCRIPT = [
	'set -euo pipefail',
	'echo "EW_VERIFY_NOT_IMPLEMENTED: the runner verification script is not embedded yet (APW-05 T15, plan §4.10)." >&2',
	'exit 70'
].join('\n');
