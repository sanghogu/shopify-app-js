import {AuthScopes, HttpResponseError} from '@shopify/shopify-api';
import {
  AppDistribution,
  LoginErrorType,
  shopifyApp,
} from '@shopify/shopify-app-react-router/server';
import type {
  AdminApiContext,
  UnauthenticatedAdminContext,
} from '@shopify/shopify-app-react-router/server';

import {
  StaticOfflineConfigurationError,
  StaticOfflineShopNotConfiguredError,
  StaticOfflineTokenRejectedError,
} from './errors';
import {redactedLogger} from './logger';
import {StaticSessionStorage} from './storage';
import {isShopDomain, validateScopes, validateStores} from './stores';
import type {StaticOfflineAppConfig, StaticOfflineShopifyApp} from './types';

function forbidden(): Response {
  return Response.json(
    {error: 'STATIC_OFFLINE_SHOP_NOT_CONFIGURED'},
    {status: 403, headers: {'Cache-Control': 'no-store'}},
  );
}

function tokenRejectedResponse(): Response {
  return Response.json(
    {
      error: 'STATIC_OFFLINE_TOKEN_REJECTED',
      message: 'Configured Shopify credentials require operator attention.',
    },
    {status: 503, headers: {'Cache-Control': 'no-store'}},
  );
}

function wrapAdmin(
  admin: AdminApiContext,
  onRejected: () => never,
): AdminApiContext {
  // Shopify clears this context's session on a 401. Preserve the error category
  // for later calls on the same client, without changing another request's state.
  let rejected = false;
  const graphql: AdminApiContext['graphql'] = async (operation, options) => {
    if (rejected) return onRejected();
    try {
      return await admin.graphql(operation, options);
    } catch (error) {
      if (
        error instanceof StaticOfflineTokenRejectedError ||
        (error instanceof HttpResponseError && error.response.code === 401) ||
        (error instanceof Response && error.status === 401)
      ) {
        rejected = true;
        return onRejected();
      }
      throw error;
    }
  };
  return {graphql};
}

function validateConfig(config: StaticOfflineAppConfig): void {
  if (!config || typeof config !== 'object')
    throw new StaticOfflineConfigurationError(
      'An app configuration is required.',
    );
  for (const key of [
    'sessionStorage',
    'hooks',
    'billing',
    'webhooks',
    'adminApiAccessToken',
    'privateAppStorefrontAccessToken',
    'customShopDomains',
    'isCustomStoreApp',
    'isEmbeddedApp',
  ]) {
    if (key in config)
      throw new StaticOfflineConfigurationError(
        `The ${key} option is unsupported in static offline mode.`,
      );
  }
  if (
    (config.distribution !== undefined &&
      config.distribution !== AppDistribution.SingleMerchant) ||
    (config.useOnlineTokens !== undefined && config.useOnlineTokens !== false)
  ) {
    throw new StaticOfflineConfigurationError(
      'Static offline mode requires SingleMerchant distribution and useOnlineTokens: false.',
    );
  }
  if (
    config.future !== undefined &&
    (!config.future ||
      typeof config.future !== 'object' ||
      Array.isArray(config.future) ||
      Object.keys(config.future).some(
        (key) => key !== 'expiringOfflineAccessTokens',
      ) ||
      (config.future.expiringOfflineAccessTokens !== undefined &&
        config.future.expiringOfflineAccessTokens !== false))
  ) {
    throw new StaticOfflineConfigurationError(
      'Only expiringOfflineAccessTokens: false is supported.',
    );
  }
}

export function createStaticOfflineShopifyApp(
  config: StaticOfflineAppConfig,
): StaticOfflineShopifyApp {
  validateConfig(config);
  const scopes = validateScopes(config.scopes ?? []);
  const stores = validateStores(config.stores, scopes);
  for (const credential of Object.values(stores)) {
    if (!new AuthScopes([...(credential.scopes ?? [])]).has(scopes))
      throw new StaticOfflineConfigurationError(
        'A configured store is missing required app scopes. Update the grant and provision its token before starting.',
      );
  }
  const {stores: _stores, ...appConfig} = config;
  const storage = new StaticSessionStorage({stores, scopes});
  const app = shopifyApp({
    ...appConfig,
    scopes,
    logger: redactedLogger({...config, stores}),
    distribution: AppDistribution.SingleMerchant,
    useOnlineTokens: false,
    future: {expiringOfflineAccessTokens: false},
    sessionStorage: storage,
  });

  return {
    authenticate: {
      async admin(request) {
        try {
          const context = await app.authenticate.admin(request);
          const {session, sessionToken, cors, redirect} = context;
          return {
            session,
            sessionToken,
            cors,
            redirect,
            admin: wrapAdmin(context.admin, () => {
              throw cors(tokenRejectedResponse());
            }),
          };
        } catch (error) {
          if (error instanceof StaticOfflineShopNotConfiguredError)
            throw forbidden();
          throw error;
        }
      },
      async webhook(request) {
        try {
          // Shopify verifies the raw body HMAC before looking up the session.
          const context = await app.authenticate.webhook(request);
          if (context.topic === 'APP_UNINSTALLED')
            return {...context, session: undefined, admin: undefined};
          if (!context.admin) return context;
          return {
            ...context,
            admin: wrapAdmin(context.admin, () => {
              throw tokenRejectedResponse();
            }),
          };
        } catch (error) {
          if (error instanceof StaticOfflineShopNotConfiguredError)
            throw new Response(null, {status: 200});
          throw error;
        }
      },
    },
    unauthenticated: {
      async admin(shop): Promise<UnauthenticatedAdminContext> {
        if (!storage.hasShop(shop))
          throw new StaticOfflineShopNotConfiguredError();
        const context = await app.unauthenticated.admin(shop);
        return {
          ...context,
          admin: wrapAdmin(context.admin, () => {
            throw new StaticOfflineTokenRejectedError();
          }),
        };
      },
    },
    async login(request) {
      const url = new URL(request.url);
      let shop: unknown = url.searchParams.get('shop');
      if (!shop && request.method === 'GET') return {};
      if (!shop) shop = (await request.clone().formData()).get('shop');
      if (!shop) return {shop: LoginErrorType.MissingShop};
      if (typeof shop !== 'string') return {shop: LoginErrorType.InvalidShop};
      // Match the official login form's short-name/URL convenience, then allowlist.
      shop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (typeof shop === 'string' && !shop.includes('.'))
        shop = `${shop}.myshopify.com`;
      if (!isShopDomain(shop)) return {shop: LoginErrorType.InvalidShop};
      if (!storage.hasShop(shop)) throw forbidden();
      return app.login(request);
    },
    addDocumentResponseHeaders: app.addDocumentResponseHeaders,
  };
}
