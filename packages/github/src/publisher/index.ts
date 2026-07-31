/**
 * Publisher barrel — re-exports the planner (pure) and effects (HTTP) layers.
 */

export const PUBLISHER_MODULE = 'publisher';

export type {
  PriorDedupeState,
  PublicationCleanApproval,
  PublicationExtras,
  PublicationPlan,
  PublicationPlanDropEntry,
  PublicationPlanSummaryEntry,
  PublisherDropReason,
} from './planner.js';
export { CLEAN_APPROVAL_MESSAGE, planPublication } from './planner.js';

export type { PublishContext, PublisherDeps } from './effects.js';
export { STALE_APPROVAL_DISMISS_MESSAGE, harvestPriorRound, publish } from './effects.js';
