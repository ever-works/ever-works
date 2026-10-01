# Playbook — env classification

> DRAFT — `ever-works/agents` → `templates/app-provisioner/kb/playbooks/env-classification.md`.
> Seeded through `.works/agent.yml` (`kb.seedPaths: [kb/playbooks]`).

Every variable the app reads at build or run time is declared exactly once, with three facts: **is it a secret**, **when
is it read** (build-time, run-time or both) and **where does its value come from**. A variable you cannot attribute to a
file does not go in the spec.

## Where to look

| Evidence in the repository                     | What it tells you                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `.env.example`, `.env.sample`, `.env.template` | Candidate **names** — never values                                                 |
| Configuration loaders (`config.ts`, settings)  | Names, defaults, required flags, and whether a read is optional                    |
| Self-hosting docs                              | Which variables a deployment must supply                                           |
| CI workflows                                   | Which variables are build-time (they are set on the build step)                    |
| Framework docs and prefixes                    | Public-prefix variables (`NEXT_PUBLIC_*`, `VITE_*`, `PUBLIC_*`) are **build-time** |

## Classification rules

1. **Secret when in doubt.** A key, token, password, connection string with credentials, signing secret, cipher key or
   session secret is a secret. A public URL, a port, a log level, a feature flag or a public-prefix variable is not.
2. **Source is exactly one of**:
    - `generate` — the platform generates it; give the type, the length and any character constraint.
    - `from` — derived from something the platform already knows (a dependency's output, the app's own domain).
    - `template` — composed from other values.
    - `prompt` — only a person can supply it; give a description and a required flag.
    - a non-secret default — state the value.
3. **Never a literal for a secret.** `value` on a secret variable is rejected by the output guard, and so is a value
   copied out of an example env file.
4. **Encode exact shapes.** If the code demands exactly 32 characters, a hex string, or a base64 blob of a fixed size,
   the generator **and** a validation rule both say so.
5. **Required means required.** A `prompt` variable that the app cannot boot without is required; boot is then
   **blocked** until the user sets it, and the question names the variable — never a value.

## Common traps

- A variable read in a build script and again at run time is **both**, not one of them.
- A variable with a working default in code is not required; do not ask for it.
- A public-prefix variable compiled into the bundle is build-time only — changing it later needs a rebuild, and the spec
  should say so.
- A connection string is a secret even when it points at a container the platform creates: it carries credentials.
