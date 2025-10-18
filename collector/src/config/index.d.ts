export interface AppConfig {
  env: string;
  simLogRoot: string;
  deltaEpsilon: number;
  timeAnomalyMode: 'auto' | 'propagate' | 'local';
}

declare const config: AppConfig;

export default config;
