export interface SimulationEventMetadata extends Record<string, unknown> {
  auth?: Record<string, unknown>;
  anomaly?: string;
}

export interface SimulationEvent extends Record<string, unknown> {
  session_id?: string;
  user_id?: string;
  event?: string;
  method?: string;
  path?: string;
  status?: number;
  latency_ms?: number;
  delta_t?: number;
  timestamp?: string;
  timestamp_utc?: string;
  deltaSeconds?: number | null;
  anomaly?: boolean;
  anomaly_type?: string;
  anomalyLabel?: number;
  metadata?: SimulationEventMetadata;
  _anomalyType?: string;
  _anomalyDetails?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SimulationSummary {
  events: number;
  sessions: number;
  anomalies: Record<string, number>;
}

export interface SimulationFiles {
  csvPath: string;
  manifestPath: string;
  hash: string;
}

export interface GenerateScenarioOptions extends Record<string, unknown> {
  seed?: string | number | null;
  count?: number;
  maxSteps?: number;
  anomalyRate?: number;
  anomalyCount?: number | null;
  anomalyStrategies?: Iterable<string> | string | null;
  persist?: boolean;
  runId?: string | null;
  outputDir?: string;
  csvFileName?: string;
  manifestFileName?: string;
  sessionSpacingSeconds?: number;
}

export interface SimulationParameters extends Record<string, unknown> {
  seed: string;
}

export interface SimulationResult {
  scenarioId: string;
  generated_at: string;
  params: SimulationParameters;
  events: SimulationEvent[];
  summary: SimulationSummary;
  files?: SimulationFiles;
  manifest?: Record<string, unknown>;
}

export type NormalizedAnomalyList = Set<string>;

export function generateScenario(options?: GenerateScenarioOptions): Promise<SimulationResult>;
export function normalizeAnomalyList(input: unknown): NormalizedAnomalyList;

declare const simulationService: {
  generateScenario: typeof generateScenario;
  normalizeAnomalyList: typeof normalizeAnomalyList;
};

export { generateScenario, normalizeAnomalyList };
export default simulationService;
