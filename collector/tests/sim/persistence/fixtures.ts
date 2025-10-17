export interface SimulationTestEvent extends Record<string, unknown> {
  session_id: string;
  timestamp: string;
  timestamp_utc?: string;
  deltaSeconds: number | null;
  metadata?: Record<string, unknown>;
}

export const CLIPPING_EVENTS: SimulationTestEvent[] = [
  {
    session_id: 'sess-clip',
    timestamp: '2024-01-01T00:00:00.000Z',
    timestamp_utc: '2024-01-01T00:00:00.000Z',
    deltaSeconds: null,
  },
  {
    session_id: 'sess-clip',
    timestamp: '2024-01-01T00:00:05.000Z',
    timestamp_utc: '2024-01-01T00:00:05.000Z',
    deltaSeconds: 5,
  },
  {
    session_id: 'sess-clip',
    timestamp: '2024-01-01T00:04:05.000Z',
    timestamp_utc: '2024-01-01T00:04:05.000Z',
    deltaSeconds: 240,
  },
  {
    session_id: 'sess-clip',
    timestamp: '2024-01-01T00:09:05.000Z',
    timestamp_utc: '2024-01-01T00:09:05.000Z',
    deltaSeconds: 300,
  },
  {
    session_id: 'sess-clip',
    timestamp: '2024-01-01T01:09:05.000Z',
    timestamp_utc: '2024-01-01T01:09:05.000Z',
    deltaSeconds: 3600,
  },
  {
    session_id: 'sess-clip',
    timestamp: '2024-01-01T01:19:05.000Z',
    timestamp_utc: '2024-01-01T01:19:05.000Z',
    deltaSeconds: 600,
  },
];

export const makeEventCopies = <T extends SimulationTestEvent>(events: readonly T[]): T[] =>
  events.map((event) => ({ ...event }));
