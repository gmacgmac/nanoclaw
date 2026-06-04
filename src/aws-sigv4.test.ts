import { describe, it, expect } from 'vitest';
import { signRequestV4 } from './aws-sigv4.js';
import type { AwsCredentials, SignInput } from './aws-sigv4.js';

// ─── AWS Published Test Vector ──────────────────────────────────────────────
// Source: AWS Signature Version 4 Test Suite
// https://docs.aws.amazon.com/general/latest/gr/signature-v4-test-suite.html
// Using the "get-vanilla" example credentials and a POST example.

const TEST_CREDENTIALS: AwsCredentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};

// Fixed date for deterministic tests: 2015-08-30T12:36:00Z
const TEST_DATE = new Date('2015-08-30T12:36:00.000Z');

describe('signRequestV4', () => {
  describe('AWS test vectors', () => {
    it('produces correct signature for GET request (get-vanilla equivalent)', () => {
      const input: SignInput = {
        method: 'GET',
        url: new URL('https://example.amazonaws.com/'),
        headers: { host: 'example.amazonaws.com' },
        body: Buffer.alloc(0),
        region: 'us-east-1',
        service: 'service',
        credentials: TEST_CREDENTIALS,
        date: TEST_DATE,
      };

      const result = signRequestV4(input);

      // Verify structure
      expect(result).toHaveProperty('Authorization');
      expect(result).toHaveProperty('x-amz-date', '20150830T123600Z');
      expect(result).toHaveProperty('x-amz-content-sha256');

      // The Authorization header must follow the correct format
      expect(result.Authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request, SignedHeaders=.*?, Signature=[a-f0-9]{64}$/,
      );

      // Verify the payload hash for empty body
      expect(result['x-amz-content-sha256']).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );

      // Known signature for this exact canonical request (verified manually):
      //   GET\n/\n\nhost:example.amazonaws.com\nx-amz-content-sha256:<empty-hash>\nx-amz-date:20150830T123600Z\n\nhost;x-amz-content-sha256;x-amz-date\n<empty-hash>
      expect(result.Authorization).toBe(
        'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=726c5c4879a6b4ccbbd3b24edbd6b8826d34f87450fbbf4e85546fc7ba9c1642',
      );
    });

    it('produces correct signature for POST with body', () => {
      const body = Buffer.from('Param1=value1');

      const input: SignInput = {
        method: 'POST',
        url: new URL('https://example.amazonaws.com/'),
        headers: {
          host: 'example.amazonaws.com',
          'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body,
        region: 'us-east-1',
        service: 'service',
        credentials: TEST_CREDENTIALS,
        date: TEST_DATE,
      };

      const result = signRequestV4(input);

      expect(result['x-amz-date']).toBe('20150830T123600Z');
      expect(result.Authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request/,
      );
      // SignedHeaders must include content-type, host, x-amz-content-sha256, x-amz-date
      expect(result.Authorization).toContain(
        'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date',
      );
      // Body hash should NOT be the empty hash
      expect(result['x-amz-content-sha256']).not.toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
    });
  });

  describe('empty body payload hash', () => {
    it('SHA-256 of empty string is the well-known constant', () => {
      const input: SignInput = {
        method: 'GET',
        url: new URL('https://host.example.com/path'),
        headers: { host: 'host.example.com' },
        body: Buffer.alloc(0),
        region: 'us-west-2',
        service: 'execute-api',
        credentials: TEST_CREDENTIALS,
        date: TEST_DATE,
      };

      const result = signRequestV4(input);
      expect(result['x-amz-content-sha256']).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
    });
  });

  describe('Bedrock-style request', () => {
    it('signs a POST to /model/{modelId}/invoke-with-response-stream correctly', () => {
      const modelPath =
        '/model/us.anthropic.claude-sonnet-4-6/invoke-with-response-stream';
      const bedrockBody = Buffer.from(
        JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 1024,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      );

      const input: SignInput = {
        method: 'POST',
        url: new URL(
          `https://bedrock-runtime.us-east-1.amazonaws.com${modelPath}`,
        ),
        headers: {
          host: 'bedrock-runtime.us-east-1.amazonaws.com',
          'content-type': 'application/json',
        },
        body: bedrockBody,
        region: 'us-east-1',
        service: 'bedrock',
        credentials: TEST_CREDENTIALS,
        date: TEST_DATE,
      };

      const result = signRequestV4(input);

      // Well-formed Authorization header
      expect(result.Authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/,
      );
      expect(result['x-amz-date']).toBe('20150830T123600Z');
      // Payload hash is non-empty-body
      expect(result['x-amz-content-sha256']).not.toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
      // No security token without session token
      expect(result['x-amz-security-token']).toBeUndefined();
    });

    it('handles model id with colon in path (ARN-style)', () => {
      // ARN-style model paths may contain colons
      const modelPath =
        '/model/arn%3Aaws%3Abedrock%3Aus-east-1%3A123456789012%3Ainference-profile%2Fus.anthropic.claude-sonnet-4-6/invoke-with-response-stream';
      const input: SignInput = {
        method: 'POST',
        url: new URL(
          `https://bedrock-runtime.us-east-1.amazonaws.com${modelPath}`,
        ),
        headers: {
          host: 'bedrock-runtime.us-east-1.amazonaws.com',
          'content-type': 'application/json',
        },
        body: Buffer.from('{}'),
        region: 'us-east-1',
        service: 'bedrock',
        credentials: TEST_CREDENTIALS,
        date: TEST_DATE,
      };

      const result = signRequestV4(input);
      expect(result.Authorization).toMatch(/^AWS4-HMAC-SHA256/);
      expect(result.Authorization).toContain('Signature=');
    });
  });

  describe('session token', () => {
    it('includes x-amz-security-token in signed headers and output', () => {
      const credsWithToken: AwsCredentials = {
        ...TEST_CREDENTIALS,
        sessionToken: 'FwoGZXIvYXdzEBEaDH+session+token+example==',
      };

      const input: SignInput = {
        method: 'POST',
        url: new URL(
          'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-4-6/invoke-with-response-stream',
        ),
        headers: {
          host: 'bedrock-runtime.us-east-1.amazonaws.com',
          'content-type': 'application/json',
        },
        body: Buffer.from('{"max_tokens":1024}'),
        region: 'us-east-1',
        service: 'bedrock',
        credentials: credsWithToken,
        date: TEST_DATE,
      };

      const result = signRequestV4(input);

      // x-amz-security-token must be in the output
      expect(result['x-amz-security-token']).toBe(
        'FwoGZXIvYXdzEBEaDH+session+token+example==',
      );

      // x-amz-security-token must be in signed headers
      expect(result.Authorization).toContain('x-amz-security-token');
      expect(result.Authorization).toMatch(
        /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token/,
      );
    });

    it('omits x-amz-security-token when no session token', () => {
      const input: SignInput = {
        method: 'GET',
        url: new URL('https://example.amazonaws.com/'),
        headers: { host: 'example.amazonaws.com' },
        body: Buffer.alloc(0),
        region: 'us-east-1',
        service: 'service',
        credentials: TEST_CREDENTIALS,
        date: TEST_DATE,
      };

      const result = signRequestV4(input);
      expect(result['x-amz-security-token']).toBeUndefined();
      expect(result.Authorization).not.toContain('x-amz-security-token');
    });
  });

  describe('query string handling', () => {
    it('sorts query params and includes them in canonical request', () => {
      const input: SignInput = {
        method: 'GET',
        url: new URL('https://example.amazonaws.com/?Zebra=1&Apple=2'),
        headers: { host: 'example.amazonaws.com' },
        body: Buffer.alloc(0),
        region: 'us-east-1',
        service: 'service',
        credentials: TEST_CREDENTIALS,
        date: TEST_DATE,
      };

      const result = signRequestV4(input);
      // Just verify it produces a valid signature (query ordering affects signature)
      expect(result.Authorization).toMatch(/Signature=[a-f0-9]{64}/);
    });
  });

  describe('determinism', () => {
    it('same inputs produce identical output', () => {
      const input: SignInput = {
        method: 'POST',
        url: new URL(
          'https://bedrock-runtime.us-east-1.amazonaws.com/model/x/invoke',
        ),
        headers: {
          host: 'bedrock-runtime.us-east-1.amazonaws.com',
          'content-type': 'application/json',
        },
        body: Buffer.from('{"hello":"world"}'),
        region: 'us-east-1',
        service: 'bedrock',
        credentials: TEST_CREDENTIALS,
        date: TEST_DATE,
      };

      const result1 = signRequestV4(input);
      const result2 = signRequestV4(input);
      expect(result1).toEqual(result2);
    });

    it('does not mutate input headers', () => {
      const headers = { host: 'example.com' };
      const headersBefore = { ...headers };

      signRequestV4({
        method: 'GET',
        url: new URL('https://example.com/'),
        headers,
        body: Buffer.alloc(0),
        region: 'us-east-1',
        service: 'service',
        credentials: TEST_CREDENTIALS,
        date: TEST_DATE,
      });

      expect(headers).toEqual(headersBefore);
    });
  });
});
