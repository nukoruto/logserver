export interface EventRecord {
  timestamp: string;
  session_id: string;
  user_id: string;
  event: string;
  method?: string;
  path?: string;
  status?: number;
  latency_ms?: number;
  metadata?: unknown;
}

export interface StoredEvent extends EventRecord {
  id: number;
  received_at: string;
  delta_t: number;
}

export interface EventFilters {
  sessionId?: string;
  userId?: string;
  event?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
}

export interface PaginationOptions {
  limit?: number;
  offset?: number;
}

export function createSchema(): Promise<void>;
export function insertEvent(event: EventRecord): Promise<StoredEvent>;
export function insertEventsBulk(events: EventRecord[]): Promise<StoredEvent[]>;
export function getEvents(
  filters?: EventFilters,
  pagination?: PaginationOptions
): Promise<StoredEvent[]>;
export function countEvents(filters?: EventFilters): Promise<number>;
