import {Session} from '@shopify/shopify-api';
import type {SessionStorage} from '@shopify/shopify-app-session-storage';

import {
  StaticOfflineReadOnlyError,
  StaticOfflineShopNotConfiguredError,
  StaticOfflineTokenRejectedError,
} from './errors';
import {isShopDomain, validateStores, type StaticOfflineStores} from './stores';

/** Internal bridge only: intentionally does not implement mutable storage semantics. */
export class StaticOfflineSessionStorage implements SessionStorage {
  readonly #stores: StaticOfflineStores;

  constructor(stores: StaticOfflineStores) {
    this.#stores = validateStores(stores);
  }

  hasShop(shop: string): boolean {
    return isShopDomain(shop) && Object.hasOwn(this.#stores, shop);
  }

  async loadSession(id: string): Promise<Session> {
    if (
      !id.startsWith('offline_') ||
      !this.hasShop(id.slice('offline_'.length))
    ) {
      // Returning undefined would trigger Shopify's token exchange strategy.
      throw new StaticOfflineShopNotConfiguredError();
    }
    const shop = id.slice('offline_'.length);
    const credential = this.#stores[shop];
    return new Session({
      id,
      shop,
      state: '',
      isOnline: false,
      accessToken: credential.accessToken,
      scope: credential.scopes.join(','),
    });
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    return this.hasShop(shop)
      ? [await this.loadSession(`offline_${shop}`)]
      : [];
  }

  async storeSession(session: Session): Promise<boolean> {
    // The official admin strategy clears a rejected token and tries to persist it.
    // Throw before its reauthentication redirect; never mutate the source credentials.
    if (
      session.id === `offline_${session.shop}` &&
      this.hasShop(session.shop) &&
      !session.accessToken
    ) {
      throw new StaticOfflineTokenRejectedError();
    }
    throw new StaticOfflineReadOnlyError();
  }

  async deleteSession(_id: string): Promise<boolean> {
    throw new StaticOfflineReadOnlyError();
  }

  async deleteSessions(_ids: string[]): Promise<boolean> {
    throw new StaticOfflineReadOnlyError();
  }
}
