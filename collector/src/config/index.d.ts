export type Rotation = 'daily' | 'hourly';

export interface SecurityConfig {
  jwtHmacKey: string;
  kid: string;
}

export interface AuthConfig {
  required: boolean;
  audience?: string;
  issuer?: string;
}

export interface CorsConfig {
  allowedOrigins: string[];
}

export interface PaginationConfig {
  defaultLimit: number;
  maxLimit: number;
}

export interface AppConfig {
  env: string;
  port: number;
  requestLimit: string;
  sqlitePath: string;
  csvRoot: string;
  simLogRoot: string;
  csvRotation: Rotation;
  jwtSecret: string;
  security: SecurityConfig;
  auth: AuthConfig;
  cors: CorsConfig;
  pagination: PaginationConfig;
}

declare const config: AppConfig;

export default config;
