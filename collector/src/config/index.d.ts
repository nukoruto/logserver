type Rotation = 'daily' | 'hourly';

type SecurityConfig = {
  jwtHmacKey: string;
  kid: string;
};

type AuthConfig = {
  required: boolean;
  audience?: string;
  issuer?: string;
};

type CorsConfig = {
  allowedOrigins: string[];
};

type PaginationConfig = {
  defaultLimit: number;
  maxLimit: number;
};

type AppConfig = {
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
};

declare const config: AppConfig;

export type { AppConfig, AuthConfig, CorsConfig, PaginationConfig, Rotation, SecurityConfig };
export = config;
