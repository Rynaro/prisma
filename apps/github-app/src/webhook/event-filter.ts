/**
 * Accepted-event filter per docs/api-contracts.md § Webhook ingress contract
 * (Accepted events — closed list for MVP).
 *
 * The filter accepts only `pull_request` deliveries with action ∈
 * { 'opened', 'synchronize', 'reopened' }. Any other input — including
 * missing event name or missing action — is rejected. Rejected deliveries
 * still receive a 2xx at the HTTP layer; the route emits the
 * `webhook.event_ignored` audit event when this returns false.
 */

const ACCEPTED_EVENT_NAME = 'pull_request';
const ACCEPTED_ACTIONS: ReadonlySet<string> = new Set(['opened', 'synchronize', 'reopened']);

export const isAcceptedEvent = (
  eventName: string | undefined,
  action: string | undefined,
): boolean => {
  if (eventName !== ACCEPTED_EVENT_NAME) {
    return false;
  }
  if (action === undefined) {
    return false;
  }
  return ACCEPTED_ACTIONS.has(action);
};
