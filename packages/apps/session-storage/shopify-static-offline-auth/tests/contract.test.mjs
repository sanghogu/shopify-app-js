import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {beforeEach, test} from 'node:test';

// These exact contracts also run in an isolated consumer against npm releases.
const requests = [];
const responses = [];
globalThis.fetch = async (url, init) => {
  requests.push({url: String(url), init});
  assert.match(
    String(url),
    /^https:\/\/(alpha|beta)\.myshopify\.com\/admin\/api\/2026-(07|10)\/graphql\.json$/,
  );
  const response = responses.shift();
  assert.ok(
    response,
    'Unexpected network request (token exchange/refresh is forbidden)',
  );
  return response;
};

const {
  createStaticOfflineShopifyApp,
  StaticSessionStorage,
  parseStaticOfflineStores,
  StaticOfflineReadOnlyError,
  StaticOfflineShopNotConfiguredError,
  StaticOfflineTokenRejectedError,
} = await import('shopify-static-offline-auth');
const {ApiVersion, LogSeverity, GraphqlQueryError, HttpResponseError} =
  await import('@shopify/shopify-api');
const {AppDistribution, shopifyApp} =
  await import('@shopify/shopify-app-react-router/server');
const SHOP = 'alpha.myshopify.com';
const OTHER = 'beta.myshopify.com';
const UNKNOWN = 'unknown.myshopify.com';
const KEY = 'test-client-id';
const SECRET = 'test-client-secret';
const TOKEN = 'test-offline-token-alpha';
const APP_URL = 'https://app.example.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const logs = [];

function adapterApp(options = {}) {
  const scopes = ['read_products'];
  return shopifyApp({
    apiKey: KEY,
    apiSecretKey: SECRET,
    apiVersion: ApiVersion.July26,
    appUrl: APP_URL,
    authPathPrefix: '/auth',
    scopes,
    sessionStorage: new StaticSessionStorage({
      stores: parseStaticOfflineStores(
        JSON.stringify({
          [SHOP]: {accessToken: TOKEN},
          [OTHER]: {accessToken: 'test-offline-token-beta'},
        }),
      ),
      scopes,
    }),
    distribution: AppDistribution.SingleMerchant,
    useOnlineTokens: false,
    future: {expiringOfflineAccessTokens: false},
    logger: {level: LogSeverity.Error, log: () => {}},
    ...options,
  });
}

beforeEach(() => {
  requests.length = 0;
  responses.length = 0;
  logs.length = 0;
});

function app(overrides = {}) {
  return createStaticOfflineShopifyApp({
    apiKey: KEY,
    apiSecretKey: SECRET,
    apiVersion: ApiVersion.October26,
    appUrl: APP_URL,
    distribution: AppDistribution.SingleMerchant,
    scopes: ['read_products'],
    stores: {
      [SHOP]: {accessToken: TOKEN, scopes: ['read_products']},
      [OTHER]: {
        accessToken: 'test-offline-token-beta',
        scopes: ['read_products'],
      },
    },
    logger: {
      level: LogSeverity.Debug,
      httpRequests: true,
      log: (_level, message) => logs.push(message),
    },
    ...overrides,
  });
}

function jwt(claims = {}, secret = SECRET) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: `https://${SHOP}/admin`,
    dest: `https://${SHOP}`,
    aud: KEY,
    sub: '123',
    exp: now + 60,
    nbf: now - 1,
    iat: now - 1,
    jti: 'test-id',
    sid: 'test-session',
    ...claims,
  };
  const body = [
    JSON.stringify({alg: 'HS256', typ: 'JWT'}),
    JSON.stringify(payload),
  ]
    .map((value) => Buffer.from(value).toString('base64url'))
    .join('.');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

function request(token = jwt(), shop = SHOP) {
  return new Request(`${APP_URL}/app?shop=${shop}`, {
    headers: {Authorization: `Bearer ${token}`},
  });
}

function documentRequest(token = jwt()) {
  const host = Buffer.from(`${SHOP}/admin`).toString('base64');
  return new Request(
    `${APP_URL}/app?embedded=1&shop=${SHOP}&host=${host}&id_token=${token}`,
    {headers: {'User-Agent': USER_AGENT}},
  );
}

function webhook(shop = SHOP, topic = 'products/update', hmacSecret = SECRET) {
  const body = JSON.stringify({id: 123});
  return new Request(`${APP_URL}/webhooks`, {
    method: 'POST',
    body,
    headers: {
      'X-Shopify-Shop-Domain': shop,
      'X-Shopify-Topic': topic,
      'X-Shopify-API-Version': '2026-10',
      'X-Shopify-Webhook-Id': 'test-webhook-id',
      'X-Shopify-Hmac-Sha256': createHmac('sha256', hmacSecret)
        .update(body)
        .digest('base64'),
    },
  });
}

function respond(status = 200, body = {data: {shop: {name: 'Test shop'}}}) {
  responses.push(
    new Response(JSON.stringify(body), {
      status,
      headers: {'Content-Type': 'application/json'},
    }),
  );
}

async function rejectedResponse(action, status) {
  try {
    await action();
    assert.fail('Expected a thrown Response');
  } catch (error) {
    assert.ok(
      error instanceof Response,
      `Expected Response, got ${error?.constructor?.name}: ${error?.message}`,
    );
    assert.equal(error.status, status);
    return error;
  }
}

test('header JWT selects its store even when the query shop names another allowed store', async () => {
  const instance = app();
  const context = await instance.authenticate.admin(request(jwt(), OTHER));
  assert.equal(context.session.shop, SHOP);
  assert.equal(context.session.accessToken, TOKEN);
  assert.equal(context.session.isOnline, false);
  assert.equal(context.session.expires, undefined);
  assert.deepEqual(Object.keys(context).sort(), [
    'admin',
    'cors',
    'redirect',
    'session',
    'sessionToken',
  ]);
  assert.equal(requests.length, 0);
  respond();
  const result = await context.admin.graphql('{ shop { name } }');
  assert.deepEqual((await result.json()).data, {shop: {name: 'Test shop'}});
  assert.equal(
    new Headers(requests[0].init.headers).get('X-Shopify-Access-Token'),
    TOKEN,
  );
});

test('document id_token flow and initial App Bridge bootstrap remain available', async () => {
  const instance = app();
  const context = await instance.authenticate.admin(documentRequest());
  assert.equal(context.session.shop, SHOP);
  const noToken = new URL(documentRequest().url);
  noToken.searchParams.delete('id_token');
  const bounce = await rejectedResponse(
    () =>
      instance.authenticate.admin(
        new Request(noToken, {headers: {'User-Agent': USER_AGENT}}),
      ),
    302,
  );
  assert.ok(bounce.headers.get('location').includes('/auth/session-token'));
  assert.equal(requests.length, 0);
});

for (const [name, claims, secret] of [
  ['signature', {}, 'wrong-secret'],
  ['expiration', {exp: 1}],
  ['not-before', {nbf: 4102444800}],
  ['audience', {aud: 'wrong-client'}],
  ['issuer', {iss: `https://${OTHER}/admin`}],
  [
    'non-HTTPS destination',
    {dest: `http://${SHOP}`, iss: `http://${SHOP}/admin`},
  ],
  ['destination path', {dest: `https://${SHOP}/path`}],
  ['invalid destination', {dest: 'not-a-url'}],
]) {
  test(`rejects invalid JWT ${name}`, async () => {
    await rejectedResponse(
      () => app().authenticate.admin(request(jwt(claims, secret))),
      401,
    );
    assert.equal(requests.length, 0);
  });
  test(`direct adapter: rejects invalid JWT ${name} with official shopifyApp`, async () => {
    await rejectedResponse(
      () => adapterApp().authenticate.admin(request(jwt(claims, secret))),
      401,
    );
    assert.equal(requests.length, 0);
  });
}

test('rejects unconfigured signed destinations without token exchange', async () => {
  await rejectedResponse(
    () =>
      app().authenticate.admin(
        request(
          jwt({dest: `https://${UNKNOWN}`, iss: `https://${UNKNOWN}/admin`}),
          SHOP,
        ),
      ),
    403,
  );
  assert.equal(requests.length, 0);
});

test('malformed JWT never authenticates and is not echoed to the client', async () => {
  const response = await rejectedResponse(
    () => app().authenticate.admin(request('invalid-token')),
    401,
  );
  assert.ok(!(await response.text()).includes('invalid-token'));
});

for (const kind of ['header', 'document', 'webhook']) {
  test(`${kind} API token rejection becomes 503 without redirect, secrets or token exchange`, async () => {
    const instance = app();
    const context =
      kind === 'webhook'
        ? await instance.authenticate.webhook(webhook())
        : await instance.authenticate.admin(
            kind === 'document' ? documentRequest() : request(),
          );
    respond(401, {errors: TOKEN});
    const response = await rejectedResponse(
      () => context.admin.graphql('{ shop { name } }'),
      503,
    );
    assert.equal(response.headers.get('location'), null);
    assert.equal(
      response.headers.get('X-Shopify-Retry-Invalid-Session-Request'),
      null,
    );
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(
      (await response.json()).error,
      'STATIC_OFFLINE_TOKEN_REJECTED',
    );
    await rejectedResponse(
      () => context.admin.graphql('{ shop { name } }'),
      503,
    );
    assert.equal(requests.length, 1);
    // A new request reconstructs from configuration, never an in-memory invalidation.
    assert.equal(
      (await instance.authenticate.admin(request())).session.accessToken,
      TOKEN,
    );
  });
}

test('background API rejection is a typed error and unknown shops fail closed', async () => {
  const instance = app();
  await assert.rejects(
    instance.unauthenticated.admin(UNKNOWN),
    StaticOfflineShopNotConfiguredError,
  );
  const context = await instance.unauthenticated.admin(SHOP);
  respond(401, {errors: TOKEN});
  await assert.rejects(
    context.admin.graphql('{ shop { name } }'),
    StaticOfflineTokenRejectedError,
  );
  await assert.rejects(
    context.admin.graphql('{ shop { name } }'),
    StaticOfflineTokenRejectedError,
  );
  assert.equal(requests.length, 1);
});

test('API permission and GraphQL errors are not misclassified as token rejection', async () => {
  const context = await app().authenticate.admin(request());
  respond(403, {errors: 'Forbidden'});
  await rejectedResponse(() => context.admin.graphql('{ shop { name } }'), 403);
  respond(200, {
    errors: [{message: 'Access denied', extensions: {code: 'ACCESS_DENIED'}}],
  });
  await assert.rejects(
    context.admin.graphql('{ shop { name } }'),
    GraphqlQueryError,
  );
});

test('webhook HMAC is checked before ignoring unconfigured shops', async () => {
  const instance = app();
  await rejectedResponse(
    () =>
      instance.authenticate.webhook(
        webhook(UNKNOWN, 'products/update', 'wrong-secret'),
      ),
    401,
  );
  await rejectedResponse(
    () => instance.authenticate.webhook(webhook(UNKNOWN)),
    200,
  );
  const context = await instance.authenticate.webhook(webhook());
  assert.equal(context.shop, SHOP);
  assert.equal(context.session.accessToken, TOKEN);
  assert.deepEqual(context.payload, {id: 123});
  assert.equal(requests.length, 0);
});

test('uninstall delivers metadata without a session or admin client and has no mutable tombstone', async () => {
  const instance = app();
  const context = await instance.authenticate.webhook(
    webhook(SHOP, 'app/uninstalled'),
  );
  assert.equal(context.topic, 'APP_UNINSTALLED');
  assert.equal(context.session, undefined);
  assert.equal(context.admin, undefined);
  assert.equal(
    (await instance.unauthenticated.admin(SHOP)).session.accessToken,
    TOKEN,
  );
});

test('login only redirects configured shops, and helpers are preserved', async () => {
  const instance = app();
  assert.deepEqual(
    await instance.login(new Request(`${APP_URL}/auth/login`)),
    {},
  );
  await rejectedResponse(
    () => instance.login(new Request(`${APP_URL}/auth/login?shop=${UNKNOWN}`)),
    403,
  );
  await rejectedResponse(
    () =>
      instance.login(
        new Request(`${APP_URL}/auth/login`, {
          method: 'POST',
          body: new URLSearchParams({shop: UNKNOWN}),
        }),
      ),
    403,
  );
  const response = await rejectedResponse(
    () => instance.login(new Request(`${APP_URL}/auth/login?shop=alpha`)),
    302,
  );
  assert.ok(response.headers.get('location').includes('oauth/install'));
  const headers = new Headers();
  instance.addDocumentResponseHeaders(documentRequest(), headers);
  assert.ok(headers.has('Content-Security-Policy'));
});

test('multiple instances and mutated sessions cannot modify the input snapshot', async () => {
  const stores = {[SHOP]: {accessToken: TOKEN, scopes: ['read_products']}};
  const first = app({stores});
  const second = app({stores});
  stores[SHOP].accessToken = 'modified';
  stores[SHOP].scopes.length = 0;
  (await first.authenticate.admin(request())).session.accessToken =
    'another-modification';
  assert.equal(
    (await first.authenticate.admin(request())).session.accessToken,
    TOKEN,
  );
  assert.equal(
    (await second.authenticate.admin(request())).session.accessToken,
    TOKEN,
  );
});

test('debug logging redacts JWTs and access tokens, including upstream rejection bodies', async () => {
  const token = jwt();
  const context = await app().authenticate.admin(request(token));
  respond(401, {errors: `${TOKEN} ${SECRET}`});
  await rejectedResponse(() => context.admin.graphql('{ shop { name } }'), 503);
  const output = logs.join('\n');
  assert.ok(!output.includes(token));
  assert.ok(!output.includes(TOKEN));
  assert.ok(!output.includes(SECRET));
});

test('direct adapter: official shopifyApp uses shared scopes and the verified JWT shop', async () => {
  const instance = adapterApp();
  const context = await instance.authenticate.admin(request(jwt(), OTHER));
  assert.ok(instance.sessionStorage instanceof StaticSessionStorage);
  assert.equal(context.session.shop, SHOP);
  assert.equal(context.session.scope, 'read_products');
  assert.equal(context.session.accessToken, TOKEN);
  assert.ok(context.billing && context.scopes);
  assert.equal(requests.length, 0);
  respond();
  await context.admin.graphql('{ shop { name } }');
  assert.match(requests[0].url, /2026-07\/graphql\.json$/);
  assert.equal(
    new Headers(requests[0].init.headers).get('X-Shopify-Access-Token'),
    TOKEN,
  );
});

test('direct adapter: document JWTs work without a factory wrapper', async () => {
  const context = await adapterApp().authenticate.admin(documentRequest());
  assert.equal(context.session.shop, SHOP);
  assert.equal(requests.length, 0);
});

test('direct adapter: a signed unconfigured destination throws before token exchange', async () => {
  const instance = adapterApp();
  await assert.rejects(
    instance.authenticate.admin(
      request(
        jwt({dest: `https://${UNKNOWN}`, iss: `https://${UNKNOWN}/admin`}),
        SHOP,
      ),
    ),
    StaticOfflineShopNotConfiguredError,
  );
  await assert.rejects(
    instance.unauthenticated.admin(UNKNOWN),
    StaticOfflineShopNotConfiguredError,
  );
  assert.equal(requests.length, 0);
});

test('direct adapter: a rejected admin token throws a typed error before reauthentication', async () => {
  const instance = adapterApp();
  const context = await instance.authenticate.admin(request());
  respond(401, {errors: 'Invalid token'});
  await assert.rejects(
    context.admin.graphql('{ shop { name } }'),
    StaticOfflineTokenRejectedError,
  );
  assert.equal(requests.length, 1);
  assert.equal(
    (await instance.sessionStorage.loadSession(`offline_${SHOP}`)).accessToken,
    TOKEN,
  );
});

test('direct adapter: background API errors retain the upstream error contract', async () => {
  const {admin} = await adapterApp().unauthenticated.admin(SHOP);
  respond(401, {errors: 'Invalid token'});
  await assert.rejects(
    admin.graphql('{ shop { name } }'),
    (error) =>
      error instanceof HttpResponseError && error.response.code === 401,
  );
  assert.equal(requests.length, 1);
});

test('direct adapter: webhook HMAC is validated before any credential lookup', async () => {
  const instance = adapterApp();
  await rejectedResponse(
    () =>
      instance.authenticate.webhook(
        webhook(UNKNOWN, 'products/update', 'wrong-secret'),
      ),
    401,
  );
  await assert.rejects(
    instance.authenticate.webhook(webhook(UNKNOWN)),
    StaticOfflineShopNotConfiguredError,
  );
  const context = await instance.authenticate.webhook(webhook());
  assert.equal(context.session.accessToken, TOKEN);
  // Storage has no request/topic context. Applications handle uninstall cleanup.
  const uninstall = await instance.authenticate.webhook(
    webhook(SHOP, 'app/uninstalled'),
  );
  assert.equal(uninstall.session.accessToken, TOKEN);
  assert.equal(uninstall.topic, 'APP_UNINSTALLED');
  assert.equal(requests.length, 0);
});

test('direct adapter: credential deletion and writes never claim success', async () => {
  const {sessionStorage} = adapterApp();
  const session = await sessionStorage.loadSession(`offline_${SHOP}`);
  await assert.rejects(
    sessionStorage.storeSession(session),
    StaticOfflineReadOnlyError,
  );
  await assert.rejects(
    sessionStorage.deleteSession(session.id),
    StaticOfflineReadOnlyError,
  );
  await assert.rejects(
    sessionStorage.deleteSessions([session.id]),
    StaticOfflineReadOnlyError,
  );
  assert.equal(
    (await sessionStorage.loadSession(session.id)).accessToken,
    TOKEN,
  );
});

test('direct adapter: existing sessions do not trigger afterAuth initialization', async () => {
  let afterAuthCalls = 0;
  const instance = adapterApp({
    hooks: {
      afterAuth: async () => {
        afterAuthCalls += 1;
      },
    },
  });
  await instance.authenticate.admin(request());
  assert.equal(afterAuthCalls, 0);
  assert.equal(requests.length, 0);
});

test('direct adapter: app scopes alone do not become claimed grant metadata', async () => {
  const instance = adapterApp({
    sessionStorage: new StaticSessionStorage({
      stores: {[SHOP]: {accessToken: TOKEN}},
    }),
  });
  const {session, admin} = await instance.authenticate.admin(request());
  assert.equal(session.scope, undefined);
  respond();
  await admin.graphql('{ shop { name } }');
  assert.equal(requests.length, 1);
});
