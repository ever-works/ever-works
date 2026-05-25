// Phase 5 PR M — public surface of the web-side ideas/ directory.
// Begins with IdeaCard (extracted from dashboard/WorkProposalCard
// per spec §3 + Phase 2 PR E's Proposals → Ideas rename). Phase 5
// PR N adds the dedicated /ideas page client; PR O + PR P will
// expand this with the Dashboard preview block + the Done filter
// chip.
export { IdeaCard } from './IdeaCard';
export { IdeasPageClient, ACTIONABLE_STATUSES } from './IdeasPageClient';
