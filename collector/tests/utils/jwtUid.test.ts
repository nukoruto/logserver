import { deriveUidFromAuthorization, mintTestToken } from '../../src/utils/jwtUid';

describe('deriveUidFromAuthorization', () => {
  const secretHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const now = Math.floor(Date.now() / 1000);

  const bearer = (
    payload: Record<string, unknown>,
    headerOverrides: Record<string, unknown> = {},
  ): string => `Bearer ${mintTestToken(payload, secretHex, headerOverrides)}`;

  it('returns uid for a valid bearer token', () => {
    const header = bearer({ sub: 'user-1', exp: now + 120, aud: 'logserver' });
    const uid = deriveUidFromAuthorization(header, { secretHex, now, requiredAudience: 'logserver' });
    expect(uid).toBeTruthy();
    expect(uid).toMatch(/^[0-9a-f]{64}$/);
  });

  it('appends kid when header includes kid claim', () => {
    const header = bearer({ sub: 'user-1', exp: now + 120 }, { kid: 'sid-key-01' });
    const uid = deriveUidFromAuthorization(header, { secretHex, now });
    expect(uid).toMatch(/^[0-9a-f]{64}:sid-key-01$/);
  });

  it('rejects expired tokens', () => {
    const header = bearer({ sub: 'user-1', exp: now - 5 });
    const uid = deriveUidFromAuthorization(header, { secretHex, now });
    expect(uid).toBeNull();
  });

  it('rejects tokens without matching audience', () => {
    const header = bearer({ sub: 'user-1', exp: now + 60, aud: 'other-service' });
    const uid = deriveUidFromAuthorization(header, { secretHex, now, requiredAudience: 'logserver' });
    expect(uid).toBeNull();
  });

  it('rejects malformed headers', () => {
    const uid = deriveUidFromAuthorization('Basic abc.def.ghi', { secretHex, now });
    expect(uid).toBeNull();
  });

  it('rejects invalid signatures', () => {
    const header = bearer({ sub: 'user-1', exp: now + 120 });
    const manipulated = `${header.slice(0, -1)}x`;
    const uid = deriveUidFromAuthorization(manipulated, { secretHex, now });
    expect(uid).toBeNull();
  });
});
