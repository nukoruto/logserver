export type StoredEvent = Record<string, unknown>;

export interface ListEventsQuery extends Record<string, unknown> {
  limit?: number | string;
  offset?: number | string;
  session_id?: string;
  user_id?: string;
  event?: string;
  from?: string;
  to?: string;
}

export interface ListEventsResult {
  items: StoredEvent[];
  total: number;
  limit: number;
  offset: number;
}

export function ingestEvent(payload: unknown): Promise<StoredEvent>;
export function ingestBatch(payloads: readonly unknown[]): Promise<StoredEvent[]>;
export function listEvents(query?: ListEventsQuery): Promise<ListEventsResult>;

declare const logService: {
  ingestEvent: typeof ingestEvent;
  ingestBatch: typeof ingestBatch;
  listEvents: typeof listEvents;
};

export { ingestBatch, ingestEvent, listEvents };
export default logService;
