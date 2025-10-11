import { jwtToUid, parseKey } from './uid';

describe('jwtToUid', () => {
  it('computes deterministic uid for hex key', () => {
    const key = 'deadbeefdeadbeefdeadbeefdeadbeef';
    const uid = jwtToUid('abc', key);
    expect(uid).toBe('81d319de67b6af314dfdbeb1cbbff6208e0e49ae1f95b96218f35fa9677d028b');
  });

  it('computes deterministic uid for base64 key', () => {
    const key = '3q2+7wAAAAAAAAAAAAAAAAAAAA==';
    const uid = jwtToUid('token-123', key);
    expect(uid).toBe('849390323a6dc84ff29a6d416d90aa305368789be234466cecd177d94e64a88b');
  });

  it('rejects empty jwt', () => {
    expect(() => jwtToUid('  ', 'deadbeef')).toThrow('JWT cannot be empty');
  });
});

describe('parseKey', () => {
  it('parses base64 encoded keys', () => {
    const base64 = 'c2VjcmV0X2tleQ==';
    const buffer = parseKey(base64);
    expect(buffer.equals(Buffer.from('secret_key', 'utf8'))).toBe(true);
  });

  it('parses hex encoded keys', () => {
    const hex = '00112233445566778899aabbccddeeff';
    const buffer = parseKey(hex);
    expect(buffer.equals(Buffer.from(hex, 'hex'))).toBe(true);
  });

  it('throws on invalid encoding', () => {
    expect(() => parseKey('*invalid*')).toThrow('Invalid base64 key');
  });
});
