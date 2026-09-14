// Agent email (AW-05) — approve-before-send + per-inbox / per-account send ceilings.
export * from './email-send-policy.port';
export * from './email-send-policy.service';
export * from './email-send-policy.module';
export * from './email-send-cap-exceeded.exception';
export * from './email-approval-required.exception';
export * from './agent-inbox.service';
export * from './email-draft.service';
export * from './email-draft-approval.listener';
export * from './email-drafts.module';
