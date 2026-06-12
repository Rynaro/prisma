/**
 * Accepted-event filter per docs/api-contracts.md § Webhook ingress contract
 * (Accepted events — closed list).
 *
 * The filter accepts only the event/action pairs in the allowlist below.
 * Any other input — including missing event name or missing action — is
 * rejected. Rejected deliveries still receive a 2xx at the HTTP layer;
 * the route emits the `webhook.event_ignored` audit event when this returns
 * false.
 */

const ACCEPTED_EVENTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['pull_request', new Set(['opened', 'synchronize', 'reopened'])],
  ['issue_comment', new Set(['created'])],
  ['check_run', new Set(['rerequested'])],
]);

export const isAcceptedEvent = (
  eventName: string | undefined,
  action: string | undefined,
): boolean => {
  if (eventName === undefined || action === undefined) {
    return false;
  }
  const acceptedActions = ACCEPTED_EVENTS.get(eventName);
  if (acceptedActions === undefined) {
    return false;
  }
  return acceptedActions.has(action);
};
