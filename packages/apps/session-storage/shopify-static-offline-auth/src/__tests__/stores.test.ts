import {
  createStaticOfflineShopifyApp,
  parseStaticOfflineStores,
  StaticOfflineConfigurationError,
} from '..';
import type {StaticOfflineAppConfig} from '..';
import {ApiVersion} from '@shopify/shopify-api';

const shop = 'example.myshopify.com';
const credential = {accessToken: 'test-token', scopes: ['read_products']};
const config: StaticOfflineAppConfig = {
  apiKey: 'test-client-id',
  apiSecretKey: 'test-client-secret',
  appUrl: 'https://app.example.com',
  apiVersion: ApiVersion.October26,
  scopes: ['read_products'],
  stores: {[shop]: credential},
  logger: {log: jest.fn()},
};

it('parses, copies and freezes credentials, including scopes', () => {
  const stores = parseStaticOfflineStores(JSON.stringify({[shop]: credential}));
  expect(stores[shop]).toEqual(credential);
  expect(Object.isFrozen(stores)).toBe(true);
  expect(Object.isFrozen(stores[shop])).toBe(true);
  expect(Object.isFrozen(stores[shop].scopes)).toBe(true);
});

it('accepts token-only store records without inventing granted scopes', () => {
  const stores = parseStaticOfflineStores(
    JSON.stringify({[shop]: {accessToken: 'test-token'}}),
  );
  expect(stores[shop]).toEqual({accessToken: 'test-token'});
  expect(Object.isFrozen(stores[shop])).toBe(true);
});

it('uses app-level scopes as the optional wrapper common default', async () => {
  const app = createStaticOfflineShopifyApp({
    ...config,
    stores: {[shop]: {accessToken: 'test-token'}},
  });
  expect((await app.unauthenticated.admin(shop)).session.scope).toBe(
    'read_products',
  );
});

it.each(['', '{"secret-token":', 'null', '[]', '{}', '42'])(
  'rejects invalid JSON/configuration without leaking input (%s)',
  (json) => {
    expect(() => parseStaticOfflineStores(json)).toThrow(
      StaticOfflineConfigurationError,
    );
    try {
      parseStaticOfflineStores(json);
    } catch (error) {
      expect(String(error)).not.toContain('secret-token');
    }
  },
);

it.each([
  'Example.myshopify.com',
  'https://example.myshopify.com',
  'example.myshopify.com/',
  'example.myshopify.com:443',
  'example.myshopify.com.evil.test',
  '-example.myshopify.com',
  'example-.myshopify.com',
  '__proto__',
  'example.com',
])('rejects noncanonical store keys: %s', (key) => {
  expect(() =>
    parseStaticOfflineStores(JSON.stringify({[key]: credential})),
  ).toThrow(StaticOfflineConfigurationError);
});

it.each([
  {...credential, accessToken: ''},
  {...credential, accessToken: ' token'},
  {...credential, accessToken: 'token\r\nx-header: value'},
  {...credential, accessToken: 42},
  {...credential, scopes: 'read_products'},
  {...credential, scopes: ['']},
  {...credential, scopes: ['read_products,write_products']},
  {...credential, expires: '2026-12-01'},
  {...credential, refreshToken: 'refresh'},
  {...credential, isOnline: true},
])('rejects invalid token records (%j)', (value) => {
  expect(() =>
    parseStaticOfflineStores(JSON.stringify({[shop]: value})),
  ).toThrow(StaticOfflineConfigurationError);
});

it.each([
  {sessionStorage: undefined},
  {hooks: {afterAuth() {}}},
  {billing: {}},
  {webhooks: {}},
  {adminApiAccessToken: 'token'},
  {privateAppStorefrontAccessToken: 'token'},
  {customShopDomains: ['example.com']},
  {distribution: 'app_store'},
  {distribution: 'shopify_admin'},
  {useOnlineTokens: true},
  {future: {expiringOfflineAccessTokens: true}},
  {future: {unknownFlag: true}},
  {future: null},
])('fails on conflicting options at startup (%j)', (override) => {
  expect(() =>
    createStaticOfflineShopifyApp({
      ...config,
      ...override,
    } as StaticOfflineAppConfig),
  ).toThrow(StaticOfflineConfigurationError);
});

it('checks required scopes using Shopify implied write-to-read scopes', () => {
  expect(() =>
    createStaticOfflineShopifyApp({...config, scopes: ['write_products']}),
  ).toThrow(StaticOfflineConfigurationError);
  expect(() =>
    createStaticOfflineShopifyApp({
      ...config,
      stores: {[shop]: {...credential, scopes: ['write_products']}},
    }),
  ).not.toThrow();
});

it('exports only the supported app surfaces', () => {
  const app = createStaticOfflineShopifyApp(config);
  expect(Object.keys(app).sort()).toEqual([
    'addDocumentResponseHeaders',
    'authenticate',
    'login',
    'unauthenticated',
  ]);
  expect(Object.keys(app.authenticate).sort()).toEqual(['admin', 'webhook']);
  expect(Object.keys(app.unauthenticated)).toEqual(['admin']);
});

it('keeps the consumer config intact', () => {
  const frozen = Object.freeze({
    ...config,
    appUrl: 'https://app.example.com/path',
  });
  createStaticOfflineShopifyApp(frozen);
  expect(frozen.appUrl).toBe('https://app.example.com/path');
});
