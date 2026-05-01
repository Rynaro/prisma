/**
 * Publisher barrel — re-exports the planner (pure) and effects (HTTP) layers.
 */

export const PUBLISHER_MODULE = 'publisher';

export type {
  PriorDedupeState,
  PublicationPlan,
  PublicationPlanDropEntry,
  PublicationPlanSummaryEntry,
  PublisherDropReason,
} from './planner.js';
export { planPublication } from './planner.js';

export type { PublishContext, PublisherDeps } from './effects.js';
export { publish } from './effects.js';
