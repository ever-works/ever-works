# Task prompt — Provision a repository as an App Work

> DRAFT — `ever-works/agents` → `templates/app-provisioner/prompts/tasks/provision-repository.md`.
> Referenced by `.works/agent.yml` (`prompts.tasks[0]`).

## Goal

Study the repository mounted at `repo/` and propose the App spec (`.works/works.yml`, kind `app`) that lets Ever Works
build it, boot it with its dependencies and smoke-test it — plus an overlay Dockerfile under `.works/overlay/` **only**
when no container descriptor exists and the zero-config build cannot work or is not supported by this App Work's build
capability.

## Inputs

- The repository, mounted read-only except the two writable paths.
- The Task brief: repository, base commit, deploy target, the build strategies this App Work supports, attempt number and
  budget, caps, the writable paths and the output contract.
- On a re-provision: the user's note and, when present, the upstream commit range that broke the smoke tests.
- On an iterate: the failing step, its verdict and a redacted log tail, fenced as untrusted output.
- On an answered question: the option the user picked.

## Steps

1. Read the detection order and record which source won, with the file that proves it.
2. Inspect the repository's configuration, example env files, configuration loaders and self-hosting docs; declare every
   variable the app reads at build or run time.
3. Classify each variable (secret or not; build-time, run-time or both; one source) and encode any exact shape the code
   requires.
4. Infer dependencies from client libraries and configuration, each citing its file.
5. Turn migrations into `pre-deploy` jobs, first-run setup into a `first-deploy` job with a negative smoke test,
   scheduled routes into authenticated `cron` entries, and health endpoints into probes.
6. Write `.works/works.yml` and, when unavoidable, the overlay Dockerfile.
7. Report: detection source, what you declared, what you could not determine, and every risk you found.

## Done when

The output block parses against the contract, every writable path is respected, every declared fact cites a file, and the
report explains any question or risk plainly enough for a person to answer it.
