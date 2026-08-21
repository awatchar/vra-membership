/**
 * A stand-in for Cloudflare Access, built from a real RSA key pair.
 *
 * The point is that nothing here is a mock of the verification: the tests mint
 * genuine RS256 JWTs and serve a genuine JWKS, so `createAccessVerifier` runs
 * its real signature check, real claim checks and real certificate fetch. A mock
 * that answered "authenticated" would leave the one control standing between
 * the internet and the manager's data untested.
 *
 * No request reaches Cloudflare: the certificate fetch is intercepted.
 */

export const TEST_TEAM_DOMAIN = 'vra-test';
export const TEST_AUDIENCE = 'test-only-access-audience-tag';
export const TEST_ISSUER = `https://${TEST_TEAM_DOMAIN}.cloudflareaccess.com`;
export const TEST_CERTS_URL = `${TEST_ISSUER}/cdn-cgi/access/certs`;

/** The public half as a certs endpoint publishes it. */
export interface AccessJwk {
  kty: string;
  n?: string | undefined;
  e?: string | undefined;
  alg: string;
  kid: string;
}

export interface AccessKeyPair {
  keyId: string;
  privateKey: CryptoKey;
  jwk: AccessJwk;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function encodeJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Generates a signing key and the public JWK a certs endpoint would publish. */
export async function createAccessKeyPair(keyId = 'test-key-1'): Promise<AccessKeyPair> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as {
    n?: string;
    e?: string;
  };
  return {
    keyId,
    privateKey: pair.privateKey,
    jwk: { kty: 'RSA', n: exported.n, e: exported.e, alg: 'RS256', kid: keyId },
  };
}

/** The body a Cloudflare Access certs endpoint returns. */
export function certsResponse(...pairs: AccessKeyPair[]): Response {
  return new Response(JSON.stringify({ keys: pairs.map((pair) => pair.jwk) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export interface TokenOptions {
  audience?: string | string[];
  issuer?: string;
  email?: string | null;
  subject?: string | null;
  /** Seconds from now. Negative for an already-expired token. */
  expiresInSeconds?: number;
  notBeforeSeconds?: number;
  issuedAtSeconds?: number;
  algorithm?: string;
  /** Signs with this key instead, to produce a signature that will not verify. */
  signWith?: AccessKeyPair;
}

/** Mints a token the real verifier will accept, unless told otherwise. */
export async function createAccessToken(
  pair: AccessKeyPair,
  options: TokenOptions = {},
): Promise<string> {
  const seconds = Math.floor(Date.now() / 1000);
  const signer = options.signWith ?? pair;

  const header = {
    alg: options.algorithm ?? 'RS256',
    kid: pair.keyId,
    typ: 'JWT',
  };

  const claims: Record<string, unknown> = {
    aud: options.audience ?? [TEST_AUDIENCE],
    iss: options.issuer ?? TEST_ISSUER,
    exp: seconds + (options.expiresInSeconds ?? 3600),
    iat: seconds + (options.issuedAtSeconds ?? 0),
    nbf: seconds + (options.notBeforeSeconds ?? 0),
  };
  if (options.email !== null) claims['email'] = options.email ?? 'manager@example.test';
  if (options.subject !== null) claims['sub'] = options.subject ?? 'access-subject-1';

  const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      signer.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  );

  return `${signingInput}.${base64Url(signature)}`;
}

/**
 * Intercepts the certificate fetch and nothing else.
 *
 * Any other URL falls through to the original `fetch`, so a test that
 * accidentally reaches a provider still fails loudly rather than being served a
 * certificate set.
 */
export function serveCerts(...pairs: AccessKeyPair[]): () => void {
  const original = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === TEST_CERTS_URL) return certsResponse(...pairs);
    return original(input, init);
  };

  return () => {
    globalThis.fetch = original;
  };
}
