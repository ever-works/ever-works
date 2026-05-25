// Phase 5 PR M — back-compat shim. The canonical implementation
// now lives at `apps/web/src/components/ideas/IdeaCard.tsx`
// (extracted as part of the Proposals → Ideas rename, Phase 2 PR
// E + spec §3). Existing imports of `WorkProposalCard` keep
// working via this re-export so external surfaces (CLI, plugin
// templates, anything outside this monorepo) aren't broken by the
// relocation. Workspace NN #20: extension only, never replacement.
//
// Once Phase 5 PR N + PR O ship and the dashboard preview block +
// `/ideas` page have switched to the new import path, a later
// cleanup PR may delete this shim — but only with explicit
// user signoff.
export { IdeaCard as WorkProposalCard } from '@/components/ideas/IdeaCard';
