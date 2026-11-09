# shopify-static-offline-auth

Pre-provisioned, non-expiring offline access tokens for **custom-distributed Shopify React Router apps**, without a session database.

This independent package wraps the official Shopify library. It preserves Shopify's embedded-app JWT validation and uses a server-side store allowlist to supply credentials. It is not an official Shopify package and does not bypass authentication.

## Requirements

- Node.js 22 or later.
- `@shopify/shopify-app-react-router` `^4.0.2`, `@shopify/shopify-api` `^15.1.1`, and `@shopify/shopify-app-session-storage` `^7.0.3`.
- An embedded app with Dev Dashboard **custom distribution** (`SingleMerchant`).
- An existing **non-expiring offline token for this same app and each configured store**. This package cannot inspect an opaque token to prove its type or expiration.

It does not support public App Store apps, legacy admin-created apps, online tokens, refresh tokens, Remix, Billing, dynamic scope requests, Flow, POS, app proxies, or Storefront clients.

Custom apps can currently use non-expiring tokens. Tokens can still be revoked, including by uninstalling the app or revoking its secret. See [Shopify access tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens).

## Install

```sh
npm install shopify-static-offline-auth @shopify/shopify-app-react-router@^4.0.2 @shopify/shopify-api@^15.1.1 @shopify/shopify-app-session-storage@^7.0.3
```

Keep your existing React Router/React dependencies and Shopify framework setup.

## Configure

Set the following **server-only** environment variable or secret. The values below are placeholders, not usable tokens:

```dotenv
SHOPIFY_STATIC_OFFLINE_STORES='{"example.myshopify.com":{"accessToken":"REPLACE_WITH_NON_EXPIRING_OFFLINE_TOKEN","scopes":["read_products"]}}'
```

In your application's `app/shopify.server.ts`:

```ts
import {ApiVersion} from '@shopify/shopify-app-react-router/server';
import {
  createStaticOfflineShopifyApp,
  parseStaticOfflineStores,
} from 'shopify-static-offline-auth';

const shopify = createStaticOfflineShopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET!,
  appUrl: process.env.SHOPIFY_APP_URL!,
  apiVersion: ApiVersion.October26,
  scopes: ['read_products'],
  stores: parseStaticOfflineStores(process.env.SHOPIFY_STATIC_OFFLINE_STORES!),
});

export default shopify;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
```

The package reads no environment variables. You can instead supply a `stores` object from your secret manager **before** constructing the app. Store keys must be exact lowercase `<shop>.myshopify.com` domains, with no protocol, path, port, wildcard, or custom storefront domain. At least one store is required. Each record must contain only `accessToken` and a `scopes` array; an empty scope array is valid only when the app requires no scopes.

The map is copied and frozen when the app is constructed. It is a credential snapshot, not a live secret subscription. Every session read creates a fresh `Session`; changing a returned session does not change the snapshot or another request's credentials.

`scopes` on a store record describes permissions **already granted** to its token. Required app scopes must be included (including Shopify's implied write-to-read permissions). This is a local consistency check, not a remote grant verification. Editing scopes or omitting an expiration field cannot grant permissions or turn an expiring token into a permanent token.

`SingleMerchant`, `useOnlineTokens: false`, and `expiringOfflineAccessTokens: false` are enforced. An explicitly conflicting option fails at startup. `sessionStorage`, `hooks`, `billing`, code-based `webhooks`, custom shop domains, and global access-token overrides are rejected. Configure webhooks in TOML instead.

## Supported interfaces

### Authenticated Admin requests

```ts
const {admin, session, sessionToken, cors, redirect} =
  await authenticate.admin(request);
const response = await admin.graphql('{ shop { name } }');
return cors(Response.json(await response.json()));
```

Keep the template's App Bridge/AppProvider, auth catch-all route, `boundary` imports, and document-response-header integration from `@shopify/shopify-app-react-router`. Header JWTs and document `id_token` requests continue through the official authentication flow. Initial App Bridge redirects to obtain a JWT are normal; the wrapper does not exchange it for another access token.

The JWT's validated destination selects the credential. A query-string `shop` cannot select another store's token. An unconfigured destination produces a `403` response without token exchange. JWT failures retain Shopify's normal responses and bootstrap behavior.

The context exposes only `admin`, `session`, `sessionToken`, `cors`, and `redirect`. Offline requests use the app installation's permissions; they do not acquire staff-specific online tokens. Never return a `session`, token map, or server configuration to the browser.

### Webhooks

Define app-specific webhook subscriptions in your existing `shopify.app.toml`:

```toml
[webhooks]
api_version = "2026-10"

[[webhooks.subscriptions]]
topics = ["app/uninstalled"]
uri = "/webhooks/app/uninstalled"
```

```ts
const {topic, shop, session, admin, payload} =
  await authenticate.webhook(request);

if (topic === 'APP_UNINSTALLED') {
  // Perform your application-specific cleanup or operator notification.
  // Remove this shop's configured credential and redeploy all instances.
  return new Response(null, {status: 200});
}

// Normal webhook context is available here. Check session/admin before use.
return new Response(null, {status: 200});
```

The official library verifies the raw-body HMAC first. Valid deliveries for an unconfigured shop throw an empty `200` Response, which the route must allow React Router to handle; business logic after authentication does not run. Invalid HMACs are still rejected. `APP_UNINSTALLED` deliveries expose their metadata and payload but no `session` or `admin`.

The wrapper does **not** persist an uninstall tombstone. An installed credential remains in the snapshot until an operator removes it. Shopify's revoked token will be rejected on subsequent API calls. Do not add calls to `deleteSession` or Prisma session cleanup to this webhook.

### Background jobs

```ts
import {StaticOfflineTokenRejectedError} from 'shopify-static-offline-auth';

try {
  const {admin} = await unauthenticated.admin('example.myshopify.com');
  await admin.graphql('{ shop { name } }');
} catch (error) {
  if (error instanceof StaticOfflineTokenRejectedError) {
    // Stop the job and notify an operator using your own reporting system.
  }
  throw error;
}
```

`unauthenticated.admin` is for **trusted server code**. It applies the allowlist but does not authenticate a caller. Do not expose it through a public route without your own request authorization.

### Login and document headers

`login(request)` preserves the official login form and redirects only configured shops. Short names such as `example` are accepted on the login form. `addDocumentResponseHeaders(request, headers)` delegates to Shopify. No session storage or additional authentication surfaces are exposed.

## Errors and token lifecycle

| Condition                                         | Request-based API                                    | Background API                        |
| ------------------------------------------------- | ---------------------------------------------------- | ------------------------------------- |
| Unconfigured store                                | Admin: `403`; valid webhook: ignored with `200`      | `StaticOfflineShopNotConfiguredError` |
| Shopify rejects the token with HTTP `401`         | `503` JSON with `STATIC_OFFLINE_TOKEN_REJECTED`      | `StaticOfflineTokenRejectedError`     |
| Invalid configuration                             | `StaticOfflineConfigurationError` during startup     | Same                                  |
| Attempted session mutation                        | Internal adapter throws `StaticOfflineReadOnlyError` | Same                                  |
| Permission, GraphQL, throttling, or network error | Preserved from Shopify                               | Preserved from Shopify                |

Token rejection responses use `Cache-Control: no-store`, contain no token or upstream response body, and do not request reauthentication or token refresh. The internal adapter also converts Shopify's attempt to persist an invalidated token into a token-rejection error. It never claims that a write or deletion succeeded. Debug logs passed through the wrapper redact configured secrets and JWTs.

Authentication success means the JWT is valid and its shop is configured. No remote token probe is added to each authentication call. Revocation or incorrect grants can therefore be discovered on the first API call. Repeated requests continue to fail until credentials are replaced; there is no shared invalidation cache.

To provision or rotate a token:

1. Install/authorize the same custom-distributed app on the intended store and obtain a non-expiring offline token using Shopify's supported [token exchange](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/token-exchange) or authorization-code flow. This package does not implement a provisioning flow.
2. Confirm the token's actual granted scopes and read-test it against the intended store. Keep the app's client ID and secret paired with that installation.
3. Replace the server-side credential and granted-scope metadata.
4. Redeploy/restart **all** instances. Old processes retain their original snapshot until replaced.
5. Verify an authenticated request and an Admin API call. Remove revoked or uninstalled stores from configuration.

Changes to app-required scopes may require reauthorization and new credentials before the app can start.

## Migrating from Prisma/session storage

1. Provision and verify tokens for every allowed store before changing the app.
2. Replace `shopifyApp` with this factory and remove `sessionStorage` and the Prisma session-storage adapter import.
3. Preserve route-level `authenticate.admin`, App Bridge, headers, and framework `boundary` usage. Remove unsupported `sessionStorage`/`registerWebhooks` exports.
4. Move `afterAuth` work into an explicit provisioning/deployment step. Use TOML subscriptions for webhooks. This wrapper does not run `afterAuth` on first use or on every request.
5. Remove session delete/update code from uninstall and scope-update webhooks. Handle configuration changes through your operational process instead; return successful webhook acknowledgements after any application cleanup.
6. Remove Prisma/database dependencies only if no other application data uses them. Do not delete unrelated database data or migrations.
7. Test before rollout. Keep the previous deployment and its database available for rollback until verification completes.

## Development and release

From the monorepo root:

```sh
pnpm install --ignore-scripts
pnpm exec turbo run build --filter='shopify-static-offline-auth...'
pnpm --filter shopify-static-offline-auth typecheck
pnpm --filter shopify-static-offline-auth test
pnpm --filter shopify-static-offline-auth test:package
```

`test` runs unit tests plus native Node integration contracts. HTTP is mocked; the contracts fail on token-exchange, refresh, or unexpected network calls. `test:package` packs the built package, inspects its file allowlist, installs it in a temporary consumer with **npm registry releases** (React Router 4.0.2 / API 15.1.1), reruns the same contracts, and checks ESM, CommonJS, private-subpath blocking, and TypeScript declarations. It needs network access to install dependencies, but calls no real stores. The temporary consumer is removed afterward.

Only `dist`, `README.md`, `LICENSE.md`, and package metadata are published. Source tests, local secrets, adapters' dependencies, and workspace configuration are not bundled. Do not use the monorepo-wide release command to publish this independent package.

After checks pass, inspect `npm pack --dry-run` from this package directory, then publish only this package with an authorized npm account:

```sh
npm publish --access public
```

Building or packing does not publish a version. Verify the published version and its integrity on the npm registry after publication.
