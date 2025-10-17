export interface AppConfig {
  env: string;
  simLogRoot: string;
}

declare const config: AppConfig;

export default config;
