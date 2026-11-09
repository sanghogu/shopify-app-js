import {ApiVersion, LogSeverity} from '@shopify/shopify-api';

import {redactedLogger} from '../logger';

it('redacts configured secrets and JWTs with whitespace in their JSON header', () => {
  const log = jest.fn();
  const logger = redactedLogger({
    apiKey: 'client-id',
    apiSecretKey: 'example-secret',
    appUrl: 'https://app.example.com',
    apiVersion: ApiVersion.October26,
    stores: {
      'example.myshopify.com': {accessToken: 'example-token', scopes: []},
    },
    logger: {log},
  });
  const token = `${Buffer.from(' {"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"sub":"123"}').toString('base64url')}.${'a'.repeat(43)}`;
  logger.log(
    LogSeverity.Debug,
    `example.myshopify.com example-secret example-token ${token}`,
  );
  const output = log.mock.calls[0][1];
  expect(output).toContain('example.myshopify.com');
  expect(output).not.toContain('example-secret');
  expect(output).not.toContain('example-token');
  expect(output).not.toContain(token);
});
