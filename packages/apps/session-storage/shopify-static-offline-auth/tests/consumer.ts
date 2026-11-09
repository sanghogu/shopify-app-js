import {
  ApiVersion,
  AppDistribution,
  boundary,
  shopifyApp,
} from '@shopify/shopify-app-react-router/server';
import {
  createStaticOfflineShopifyApp,
  parseStaticOfflineStores,
  StaticOfflineTokenRejectedError,
  StaticSessionStorage,
} from 'shopify-static-offline-auth';

const app = createStaticOfflineShopifyApp({
  apiKey: 'example-client-id',
  apiSecretKey: 'example-client-secret',
  appUrl: 'https://app.example.com',
  apiVersion: ApiVersion.October26,
  scopes: ['read_products'],
  stores: parseStaticOfflineStores(
    '{"example.myshopify.com":{"accessToken":"example-token","scopes":["read_products"]}}',
  ),
});

const scopes = ['read_products'];
const direct = shopifyApp({
  apiKey: 'example-client-id',
  apiSecretKey: 'example-client-secret',
  appUrl: 'https://app.example.com',
  apiVersion: ApiVersion.July26,
  scopes,
  sessionStorage: new StaticSessionStorage({
    stores: parseStaticOfflineStores(
      '{"example.myshopify.com":{"accessToken":"example-token"}}',
    ),
    scopes,
  }),
  distribution: AppDistribution.SingleMerchant,
  future: {expiringOfflineAccessTokens: false},
});

async function directLoader(request: Request) {
  const {admin, session} = await direct.authenticate.admin(request);
  const stored = await direct.sessionStorage.loadSession(session.id);
  const response = await admin.graphql('{ shop { name } }');
  return {shop: stored.shop, result: await response.json()};
}

async function loader(request: Request) {
  const {admin, session, sessionToken, cors, redirect} =
    await app.authenticate.admin(request);
  const response = await admin.graphql('{ shop { name } }');
  const payload = await response.json();
  if (!sessionToken.sub || !session.shop) return redirect('/app');
  return cors(Response.json(payload));
}

async function webhook(request: Request) {
  const {session, admin} = await app.authenticate.webhook(request);
  if (session && admin) await admin.graphql('{ shop { name } }');
  return new Response();
}

async function background() {
  try {
    await app.unauthenticated.admin('example.myshopify.com');
  } catch (error) {
    if (error instanceof StaticOfflineTokenRejectedError)
      console.error(error.code);
  }
}

// @ts-expect-error Mutable session storage is not exposed.
void app.sessionStorage;
// @ts-expect-error Unsupported authentication surfaces are not exposed.
void app.authenticate.public;

void [loader, webhook, background, boundary, directLoader];
