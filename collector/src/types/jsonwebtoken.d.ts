declare module 'jsonwebtoken' {
  export interface JwtPayload {
    [key: string]: unknown;
  }

  export interface VerifyOptions {
    audience?: string | string[];
    issuer?: string | string[];
  }

  export function verify(
    token: string,
    secretOrPublicKey: string,
    options?: VerifyOptions
  ): string | JwtPayload;

  interface JsonWebTokenStatic {
    verify(
      token: string,
      secretOrPublicKey: string,
      options?: VerifyOptions
    ): string | JwtPayload;
  }

  const jwt: JsonWebTokenStatic;
  export default jwt;
}
