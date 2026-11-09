import {
  AppDistribution,
  shopifyApp,
} from '@shopify/shopify-app-react-router/server';
import type {
  AdminContext,
  UnauthenticatedAdminContext,
  WebhookContext,
} from '@shopify/shopify-app-react-router/server';

import type {StaticOfflineStores} from './stores';

type ShopifyConfig = Parameters<typeof shopifyApp>[0];

export type StaticOfflineAppConfig = Omit<
  ShopifyConfig,
  | 'sessionStorage'
  | 'distribution'
  | 'useOnlineTokens'
  | 'future'
  | 'hooks'
  | 'billing'
  | 'webhooks'
  | 'adminApiAccessToken'
  | 'privateAppStorefrontAccessToken'
  | 'customShopDomains'
  | 'scopes'
> & {
  stores: StaticOfflineStores;
  scopes?: readonly string[];
  distribution?: AppDistribution.SingleMerchant;
  useOnlineTokens?: false;
  future?: {expiringOfflineAccessTokens?: false};
  sessionStorage?: never;
  hooks?: never;
  billing?: never;
  webhooks?: never;
  adminApiAccessToken?: never;
  privateAppStorefrontAccessToken?: never;
  customShopDomains?: never;
};

type EmbeddedContext = Extract<AdminContext, {sessionToken: unknown}>;
export type StaticOfflineAdminContext = Pick<
  EmbeddedContext,
  'admin' | 'session' | 'sessionToken' | 'cors' | 'redirect'
>;

export interface StaticOfflineShopifyApp {
  authenticate: {
    admin(request: Request): Promise<StaticOfflineAdminContext>;
    webhook(request: Request): Promise<WebhookContext>;
  };
  unauthenticated: {
    /** For trusted server code only; this does not authenticate an incoming request. */
    admin(shop: string): Promise<UnauthenticatedAdminContext>;
  };
  login: NonNullable<ReturnType<typeof shopifyApp>['login']>;
  addDocumentResponseHeaders: ReturnType<
    typeof shopifyApp
  >['addDocumentResponseHeaders'];
}
