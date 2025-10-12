import { jwtToUid, parseKey } from './uid';

describe('jwtToUid', () => {
  it('computes deterministic uid for hex key', () => {
    const key = 'deadbeefdeadbeefdeadbeefdeadbeef';
    const uid = jwtToUid('abc', key);
    expect(uid).toBe('0388da064eb11c9f38117ebf3e3f3200e66532be8f1d987d5c21af66aeae5788');
  });

  it('computes deterministic uid for base64 key', () => {
    const key = '3q2+7wAAAAAAAAAAAAAAAAAAAA==';
    const uid = jwtToUid('token-123', key);
    expect(uid).toBe('7b971b22a84bbf381ea9b488ddb5c1ce3580d8bf9daebb09d6f894f1dcec5074');
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
