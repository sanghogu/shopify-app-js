import {Session} from '@shopify/shopify-api';

import {StaticSessionStorage} from '..';
import {
  StaticOfflineReadOnlyError,
  StaticOfflineShopNotConfiguredError,
  StaticOfflineTokenRejectedError,
} from '../errors';

const shop = 'example.myshopify.com';
const id = `offline_${shop}`;
const stores = () => ({
  [shop]: {accessToken: 'test-token', scopes: ['read_products']},
});

it('makes a fresh active offline session for every read, with no expiration or refresh token', async () => {
  const storage = new StaticSessionStorage({stores: stores()});
  const first = await storage.loadSession(id);
  expect(first).toBeInstanceOf(Session);
  expect(first.isActive(['read_products'])).toBe(true);
  expect(first.isOnline).toBe(false);
  expect(first.expires).toBeUndefined();
  expect(first.refreshToken).toBeUndefined();
  first.accessToken = 'changed';
  first.shop = 'attacker.myshopify.com';
  const second = await storage.loadSession(id);
  expect(second).not.toBe(first);
  expect(second.accessToken).toBe('test-token');
  expect(second.shop).toBe(shop);
});

it('snapshots input and remains consistent across fresh instances', async () => {
  const source = stores();
  const first = new StaticSessionStorage({stores: source});
  const second = new StaticSessionStorage({stores: source});
  source[shop].accessToken = 'changed';
  source[shop].scopes.push('write_products');
  const a = await first.loadSession(id);
  const b = await second.loadSession(id);
  expect(a.toPropertyArray()).toEqual(b.toPropertyArray());
  expect(a.accessToken).toBe('test-token');
  expect(a.scope).toBe('read_products');
});

it.each([
  'offline_unknown.myshopify.com',
  `${shop}_123`,
  '',
  'offline___proto__',
  `offline_${shop}.evil.test`,
])(
  'throws on missing/online ids instead of allowing token exchange: %s',
  async (sessionId) => {
    await expect(
      new StaticSessionStorage({stores: stores()}).loadSession(sessionId),
    ).rejects.toBeInstanceOf(StaticOfflineShopNotConfiguredError);
  },
);

it('returns fresh search results and an empty array for unknown shops', async () => {
  const storage = new StaticSessionStorage({stores: stores()});
  const sessions = await storage.findSessionsByShop(shop);
  sessions[0].accessToken = 'changed';
  expect((await storage.findSessionsByShop(shop))[0].accessToken).toBe(
    'test-token',
  );
  await expect(
    storage.findSessionsByShop('unknown.myshopify.com'),
  ).resolves.toEqual([]);
});

it('rejects all writes and deletes, including empty batches, without modifying configuration', async () => {
  const storage = new StaticSessionStorage({stores: stores()});
  await expect(
    storage.storeSession(await storage.loadSession(id)),
  ).rejects.toBeInstanceOf(StaticOfflineReadOnlyError);
  await expect(storage.deleteSession(id)).rejects.toBeInstanceOf(
    StaticOfflineReadOnlyError,
  );
  await expect(storage.deleteSessions([id])).rejects.toBeInstanceOf(
    StaticOfflineReadOnlyError,
  );
  await expect(storage.deleteSessions([])).rejects.toBeInstanceOf(
    StaticOfflineReadOnlyError,
  );
  expect((await storage.loadSession(id)).accessToken).toBe('test-token');
});

it('turns upstream invalidation into a token rejection without persisting it', async () => {
  const storage = new StaticSessionStorage({stores: stores()});
  const session = await storage.loadSession(id);
  session.accessToken = undefined;
  await expect(storage.storeSession(session)).rejects.toBeInstanceOf(
    StaticOfflineTokenRejectedError,
  );
  expect((await storage.loadSession(id)).accessToken).toBe('test-token');
});

it('uses a shared scopes array for token-only store records and snapshots it', async () => {
  const scopes = ['read_products'];
  const storage = new StaticSessionStorage({
    stores: {
      [shop]: {accessToken: 'test-token'},
      'second.myshopify.com': {accessToken: 'second-token'},
    },
    scopes,
  });
  scopes.push('write_products');
  expect((await storage.loadSession(id)).scope).toBe('read_products');
  expect(
    (await storage.loadSession('offline_second.myshopify.com')).scope,
  ).toBe('read_products');
});

it('keeps scope metadata undefined when no common or per-store scopes are provided', async () => {
  const storage = new StaticSessionStorage({
    stores: {[shop]: {accessToken: 'test-token'}},
  });
  const session = await storage.loadSession(id);
  expect(session.scope).toBeUndefined();
  expect(session.isActive(undefined)).toBe(true);
});

it('preserves an explicit per-store scope override, including an empty grant', async () => {
  const storage = new StaticSessionStorage({
    stores: {[shop]: {accessToken: 'test-token', scopes: []}},
    scopes: ['read_products'],
  });
  expect((await storage.loadSession(id)).scope).toBe('');
});
