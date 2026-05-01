export interface AuditEvent {
  readonly ts: string;
  readonly event: string;
  readonly payload: Readonly<Record<string, unknown>>;
}
