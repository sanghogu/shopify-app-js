# shopify-static-offline-auth

Read-only session storage for pre-provisioned, non-expiring offline tokens. Use `StaticSessionStorage` with the official Shopify `shopifyApp()` function in custom-distributed React Router apps, without a session database.

This independent package is not an official Shopify package. Shopify still validates incoming JWTs and webhook HMACs; the adapter supplies credentials only for configured stores. The optional `createStaticOfflineShopifyApp()` wrapper remains available for applications using the 0.1.x API.

## Requirements

- Node.js 22 or later.
- `@shopify/shopify-app-react-router` `^4.0.2`, `@shopify/shopify-api` `^15.1.1`, and `@shopify/shopify-app-session-storage` `^7.0.3`.
- An embedded app with Dev Dashboard **custom distribution** (`SingleMerchant`).
- An existing **non-expiring offline token for this same app and each configured store**. An opaque token cannot be inspected locally to prove its type, lifetime, or granted scopes.

Public App Store apps, legacy admin-created apps, online tokens, refresh tokens, and automatic token provisioning are outside this package's supported use case. Integration tests cover React Router Admin authentication, webhooks, and background Admin calls. Other framework integrations are not certified.

Custom apps can currently use non-expiring tokens. Tokens can still be revoked, including when the app is uninstalled or its secret is revoked. See [Shopify access tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens).

## Install

```sh
npm install shopify-static-offline-auth @shopify/shopify-app-react-router@^4.0.2 @shopify/shopify-api@^15.1.1 @shopify/shopify-app-session-storage@^7.0.3
```

## Use with the official shopifyApp

Set a **server-only** JSON environment variable or secret. Scopes are not required on each store record:

```dotenv
SCOPES=read_products
SHOPIFY_STATIC_OFFLINE_STORES='{"example.myshopify.com":{"accessToken":"REPLACE_WITH_NON_EXPIRING_OFFLINE_TOKEN"}}'
```

In your application's `app/shopify.server.ts`:

```ts
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from '@shopify/shopify-app-react-router/server';
import {
  StaticSessionStorage,
  parseStaticOfflineStores,
} from 'shopify-static-offline-auth';

const scopes = process.env.SCOPES?.split(',') ?? [];

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET!,
  apiVersion: ApiVersion.July26,
  scopes,
  appUrl: process.env.SHOPIFY_APP_URL!,
  authPathPrefix: '/auth',
  sessionStorage: new StaticSessionStorage({
    stores: parseStaticOfflineStores(
      process.env.SHOPIFY_STATIC_OFFLINE_STORES!,
    ),
    scopes,
  }),
  distribution: AppDistribution.SingleMerchant,
  useOnlineTokens: false,
  future: {expiringOfflineAccessTokens: false},
});

export default shopify;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
```

Keep the official template's App Bridge/AppProvider, auth catch-all route, `boundary` imports, headers, and route-level `authenticate.admin(request)` calls. The `shopify` object remains the official SDK object. The storage adapter does not replace it or remove its methods.

The template's `distribution: AppStore` and `expiringOfflineAccessTokens: true` settings must be adjusted for this custom, non-expiring-token use case as shown above. A storage adapter cannot inspect or change its parent `shopifyApp()` configuration. `customShopDomains` also does not expand the static credential allowlist: credential keys remain canonical `.myshopify.com` domains.

### Common scopes and granted permissions

`shopifyApp({scopes})` is the common list of permissions requested by your application. `StaticSessionStorage({scopes})` is optional metadata used to populate `Session.scope`. Reuse one array, as above; no per-store scope duplication is required. The adapter cannot automatically read the enclosing `shopifyApp` configuration.

A store record may optionally specify `scopes` when its already-granted permissions differ from the common list. An explicit per-store list, including `[]`, takes precedence. Existing 0.1.x records containing scopes still work. When neither a common list nor a per-store list is supplied, `Session.scope` is `undefined`; the adapter does not invent a grant or fetch one from Shopify. Admin JWT authentication still works with the supported SDK version.

These values do **not** grant API permissions or verify a token's actual grant. Shopify enforces the real granted permissions on every API call. Verify permissions when provisioning the token. Changing local scope metadata cannot broaden a grant or turn an expiring token into a permanent token.

### Credential snapshot

The package reads no environment variables itself. You may supply the `stores` object directly from a secret manager. Keys must be exact lowercase `<shop>.myshopify.com` domains without a protocol, path, port, wildcard, or custom storefront domain. At least one store is required. Records accept `accessToken` and optional `scopes` only.

The adapter copies and freezes its credential snapshot and returns a fresh `Session` for every read. Changing the original input or a returned session does not change another request's credentials. Restart/redeploy all instances to apply token rotation or store removal.

## Read-only adapter behavior

This adapter intentionally cannot satisfy the writable CRUD semantics of a database adapter:

| Method / condition                                          | Behavior                                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `loadSession('offline_<configured shop>')`                  | Returns a fresh offline session with no expiration or refresh token.                                                 |
| Unknown or online session ID                                | Throws `StaticOfflineShopNotConfiguredError` rather than returning `undefined`, preventing automatic token exchange. |
| `findSessionsByShop(shop)`                                  | Returns one fresh session for a configured shop, or `[]`.                                                            |
| `storeSession`, `deleteSession`, `deleteSessions`           | Throws `StaticOfflineReadOnlyError`; never reports a write or deletion as successful.                                |
| Official Admin client's attempt to persist a rejected token | Throws `StaticOfflineTokenRejectedError` before Shopify redirects into reauthentication.                             |

The adapter itself does not authenticate an HTTP request, run `afterAuth`, handle login routing, translate exceptions into HTTP status codes, redact the official SDK's logs, or distinguish webhook topics. The official SDK still validates JWTs and HMACs before looking up sessions. Never expose `unauthenticated.admin` through a public route without your own authorization, and never return a session or token map to a browser.

Admin token rejection from `authenticate.admin(...).admin.graphql(...)` is a typed error with this adapter. Webhook and background API clients retain their upstream SDK error behavior (for example, a background `401` is an `HttpResponseError`). Applications can map these errors at their route/job boundary. The optional wrapper below supplies consistent HTTP responses and background token-rejection errors.

### Webhooks and uninstall

Use app-specific TOML webhook subscriptions, and remove template code that writes/deletes session rows. An adapter has no request/topic context: on an `APP_UNINSTALLED` webhook, the official SDK can still return a session from the static snapshot. **Do not use that session for API work.** Handle the uninstall topic first, perform application cleanup, and remove the configured credential through your operational process.

For valid deliveries from a store already removed from configuration, acknowledge the lookup error in the webhook route after the official HMAC check:

```ts
import type {ActionFunctionArgs} from 'react-router';
import {StaticOfflineShopNotConfiguredError} from 'shopify-static-offline-auth';
import {authenticate} from '../shopify.server';

export async function action({request}: ActionFunctionArgs) {
  let context;
  try {
    context = await authenticate.webhook(request);
  } catch (error) {
    if (error instanceof StaticOfflineShopNotConfiguredError) {
      return new Response(null, {status: 200});
    }
    throw error;
  }

  if (context.topic === 'APP_UNINSTALLED') {
    // Perform application cleanup; remove the configured token and redeploy.
    // Do not call sessionStorage.deleteSession/deleteSessions or the Admin API.
    return new Response(null, {status: 200});
  }

  // Process the normal webhook here.
  return new Response(null, {status: 200});
}
```

There is no shared uninstall tombstone or invalidation cache. Shopify rejects revoked credentials on subsequent API calls until the configuration is changed.

## Optional React Router wrapper

Existing `createStaticOfflineShopifyApp()` consumers continue to work. Per-store scopes are now optional here too: the wrapper uses its app-level scopes as the common default.

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
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(',') ?? [],
  stores: parseStaticOfflineStores(process.env.SHOPIFY_STATIC_OFFLINE_STORES!),
});
```

The wrapper exposes `authenticate.admin`, `authenticate.webhook`, `unauthenticated.admin`, `login`, and `addDocumentResponseHeaders`. Its Admin context exposes `admin`, `session`, `sessionToken`, `cors`, and `redirect`.

| Behavior                                                           | Adapter with official `shopifyApp`                              | Optional wrapper                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------ |
| Unknown authenticated Admin store                                  | Typed lookup error for the application to handle                | `403` response                                         |
| Valid webhook for an unconfigured store                            | Typed lookup error for the webhook route to acknowledge         | Empty `200` response; processing stops                 |
| Uninstall webhook                                                  | Application handles the topic before using the returned session | Context has no session or Admin client                 |
| Admin token rejected with `401`                                    | Typed invalidation error; no reauthentication redirect          | Secret-free `503` with `STATIC_OFFLINE_TOKEN_REJECTED` |
| Background token rejected with `401`                               | Upstream `HttpResponseError`                                    | `StaticOfflineTokenRejectedError`                      |
| Scope defaults                                                     | Pass the common array to the adapter if metadata is needed      | App-level scopes are used automatically                |
| Startup configuration checks, login allowlist, debug-log redaction | Application / SDK responsibility                                | Supplied by the wrapper                                |

The wrapper enforces `SingleMerchant`, offline mode, and non-expiring tokens, and rejects conflicting configuration, separate session storage, `hooks`, `billing`, code-based `webhooks`, custom domains, and global token overrides. Use TOML subscriptions instead. Permission, GraphQL, throttling, and network errors remain SDK errors. Token rejection responses have `Cache-Control: no-store` and contain no upstream body or credentials.

## Migrating and operating

1. Provision and verify a non-expiring offline token for the same app on each allowed store. This package does not acquire tokens; use Shopify's supported [token exchange](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/token-exchange) or authorization-code flow separately.
2. Keep `shopifyApp()` and replace `new PrismaSessionStorage(prisma)` with `new StaticSessionStorage({stores, scopes})`. Use the custom/offline settings shown above. Existing wrapper consumers may keep their current factory instead.
3. Move `afterAuth` initialization into an explicit provisioning/deployment step. Pre-provisioned sessions already exist, so the official SDK does not run that hook on first use.
4. Remove session writes/deletions from uninstall and scope-update webhooks. Acknowledge unknown-store webhooks appropriately and map Admin lookup/token errors in your routes, or use the optional wrapper.
5. Remove Prisma/database dependencies only if no other application data uses them. Do not delete unrelated database data or migrations.
6. Rotate tokens and update declared scopes outside the request flow, then redeploy/restart **every** instance. Old processes retain their original snapshot until replaced.
7. Test authenticated requests and API calls before rollout. Keep the previous deployment/database available for rollback until verification completes.

Authentication success means the JWT is valid and its shop is configured. Token validity is checked by Shopify on API calls, not by an extra probe on every authentication request. Actual scope changes can require reauthorization; local scope metadata is not authorization.

## Development and release

This package lives with the other adapters under `packages/apps/session-storage/`. The existing session-storage CI build/test filters include it.

From the monorepo root:

```sh
pnpm install --ignore-scripts
pnpm exec turbo run build --filter='shopify-static-offline-auth...'
pnpm --filter shopify-static-offline-auth typecheck
pnpm --filter shopify-static-offline-auth test
pnpm --filter shopify-static-offline-auth test:package
```

`test` runs unit tests and native Node integration contracts for both the public adapter and optional wrapper. HTTP is mocked; unexpected token exchange, refresh, and network calls fail the tests. `test:package` packs the package, checks its file allowlist, installs it in an isolated consumer with npm registry releases (React Router 4.0.2 / API 15.1.1), reruns the contracts, and checks ESM, CommonJS, and TypeScript. No real stores are called.

Only `dist`, `README.md`, `LICENSE.md`, and package metadata are published. Do not use the monorepo-wide release command for this independent package. After validation, inspect `npm pack --dry-run` in this package directory and publish only this package using an authorized npm account:

```sh
npm publish --access public
```

Building or packing does not publish a version. Verify the published version, metadata, and integrity on the npm registry afterward.
