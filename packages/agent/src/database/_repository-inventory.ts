/**
 * EW-638 — Single source of truth for the repositories DatabaseModule wires.
 *
 * Before this file existed, three places duplicated the repository inventory
 * and had to be updated in lock-step:
 *
 *   1. `database.module.ts` providers + exports arrays
 *   2. `database.module.spec.ts`'s local `REPOSITORY_PROVIDERS` const
 *   3. The `"declares EXACTLY N providers"` magic numbers
 *
 * Forgetting any one of them broke `develop` CI on the next entity addition
 * (EW-634 webhook delivery worker hit it twice — see PR #889 and #891).
 *
 * Now there is exactly ONE list: `REPOSITORY_PROVIDERS` below.
 *   - `database.module.ts` spreads it into `providers` + `exports`.
 *   - `database.module.spec.ts` asserts against `REPOSITORY_PROVIDERS.length`
 *     (no magic number).
 *
 * # When adding a new repository
 *
 * Update THIS file (one import + one entry in the array). The module gets the
 * new provider/export automatically, and the regression-guard spec re-counts
 * automatically. Companion drift-checker in `database.module.spec.ts` flags
 * any wired-up-but-not-listed repo (or vice versa) so the inventory can't
 * silently fall behind reality.
 *
 * Order: alphabetical by class name. Easier diffs, easier merges.
 */

import type { Type } from '@nestjs/common';
import { ActivityLogRepository } from './repositories/activity-log.repository';
import { ApiKeyRepository } from './repositories/api-key.repository';
import { AuthAccountRepository } from './repositories/auth-account.repository';
import { ConversationRepository } from './repositories/conversation.repository';
import { GitHubAppInstallationRepoRepository } from './repositories/github-app-installation-repository.repository';
import { GitHubAppInstallationRepository } from './repositories/github-app-installation.repository';
import { GitHubAppUserLinkRepository } from './repositories/github-app-user-link.repository';
import { NotificationRepository } from './repositories/notification.repository';
import { OnboardingRequestRepository } from './repositories/onboarding-request.repository';
import { PluginUsageRepository } from './repositories/plugin-usage.repository';
import { RefreshTokenRepository } from './repositories/refresh-token.repository';
import { SubscriptionPlanRepository } from './repositories/subscription-plan.repository';
import { TemplateCustomizationRepository } from './repositories/template-customization.repository';
import { TemplateRepository } from './repositories/template.repository';
import { UsageLedgerRepository } from './repositories/usage-ledger.repository';
import { UserRepository } from './repositories/user.repository';
import { UserSubscriptionRepository } from './repositories/user-subscription.repository';
import { UserTemplatePreferenceRepository } from './repositories/user-template-preference.repository';
import { WebhookDeliveryRepository } from './repositories/webhook-delivery.repository';
import { WebhookSubscriptionRepository } from './repositories/webhook-subscription.repository';
import { WorkAdvancedPromptsRepository } from './repositories/work-advanced-prompts.repository';
import { WorkBudgetAlertStateRepository } from './repositories/work-budget-alert-state.repository';
import { WorkBudgetRepository } from './repositories/work-budget.repository';
import { WorkCustomDomainRepository } from './repositories/work-custom-domain.repository';
import { WorkDeploymentRepository } from './repositories/work-deployment.repository';
import { WorkGenerationHistoryRepository } from './repositories/work-generation-history.repository';
import { WorkInvitationRepository } from './repositories/work-invitation.repository';
import { WorkMemberRepository } from './repositories/work-member.repository';
import { WorkRepository } from './repositories/work.repository';
import { WorkScheduleRepository } from './repositories/work-schedule.repository';

export const REPOSITORY_PROVIDERS: ReadonlyArray<Type<unknown>> = [
    ActivityLogRepository,
    ApiKeyRepository,
    AuthAccountRepository,
    ConversationRepository,
    GitHubAppInstallationRepoRepository,
    GitHubAppInstallationRepository,
    GitHubAppUserLinkRepository,
    NotificationRepository,
    OnboardingRequestRepository,
    PluginUsageRepository,
    RefreshTokenRepository,
    SubscriptionPlanRepository,
    TemplateCustomizationRepository,
    TemplateRepository,
    UsageLedgerRepository,
    UserRepository,
    UserSubscriptionRepository,
    UserTemplatePreferenceRepository,
    WebhookDeliveryRepository,
    WebhookSubscriptionRepository,
    WorkAdvancedPromptsRepository,
    WorkBudgetAlertStateRepository,
    WorkBudgetRepository,
    WorkCustomDomainRepository,
    WorkDeploymentRepository,
    WorkGenerationHistoryRepository,
    WorkInvitationRepository,
    WorkMemberRepository,
    WorkRepository,
    WorkScheduleRepository,
] as const;
