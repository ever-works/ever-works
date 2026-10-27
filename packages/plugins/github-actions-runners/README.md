# GitHub Actions runners (`github-actions-runners`)

The built-in provider of the `actions-runners` capability (Fleet epic FL-18, CONTRACTS R-14): the platform's one door to GitHub for self-hosted runners on computers of the Fleet.

- **What it does:** lists the runner builds GitHub publishes (with their SHA-256), mints the one-time registration and remove tokens a runner configures with, lists and deregisters a repository's or an organisation's self-hosted runners, lists the queued and running jobs that target self-hosted runners, cancels a whole workflow run, and checks whether the installation may manage runners.
- **How it authenticates:** every method takes a short-lived installation token that the platform minted for that one call through the Ever Works GitHub App, narrowed to the one permission it needs. The plugin holds no credential between calls, has no settings of its own, never logs a token and never asks for a personal access token or the `gh` CLI.
- **Rate limits and conditional reads:** reads accept an `ETag` and answer `notModified` on a 304; a rate-limited answer carries GitHub's reset time so the platform can back off.

Installing, verifying and running the runner on the computer is the node's work (`runner-install` / `runner-control` jobs); the node never talks to this plugin.

See [Actions runners on computers](../../../docs/features/fleet-actions-runners.md).
