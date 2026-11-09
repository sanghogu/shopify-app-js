import {StaticOfflineConfigurationError} from './errors';

export interface StaticOfflineCredential {
  readonly accessToken: string;
  /** Actual granted scopes, not a request for additional permissions. */
  readonly scopes: readonly string[];
}

export type StaticOfflineStores = Readonly<
  Record<string, StaticOfflineCredential>
>;

export function isShopDomain(shop: unknown): shop is string {
  return (
    typeof shop === 'string' &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(shop)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateScopes(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (scope) => typeof scope !== 'string' || !/^[a-z][a-z0-9_]*$/.test(scope),
    )
  ) {
    throw new StaticOfflineConfigurationError(
      'Scopes must be an array of nonempty Shopify scope names.',
    );
  }
  return [...new Set(value as string[])];
}

/** Validate and copy configuration so callers cannot mutate the credential snapshot. */
export function validateStores(value: unknown): StaticOfflineStores {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new StaticOfflineConfigurationError(
      'Configure at least one store with an accessToken and scopes array.',
    );
  }
  const stores: Record<string, StaticOfflineCredential> = Object.create(null);
  for (const [shop, credential] of Object.entries(value)) {
    if (!isShopDomain(shop)) {
      throw new StaticOfflineConfigurationError(
        'Store keys must be lowercase <shop>.myshopify.com domains without a URL, path or port.',
      );
    }
    if (
      !isRecord(credential) ||
      Object.keys(credential).some(
        (key) => key !== 'accessToken' && key !== 'scopes',
      )
    ) {
      throw new StaticOfflineConfigurationError(
        'Each store must contain only accessToken and scopes; expiring or online token records are unsupported.',
      );
    }
    if (
      typeof credential.accessToken !== 'string' ||
      !credential.accessToken ||
      /\s/.test(credential.accessToken)
    ) {
      throw new StaticOfflineConfigurationError(
        'Each accessToken must be a nonempty string without whitespace.',
      );
    }
    stores[shop] = Object.freeze({
      accessToken: credential.accessToken,
      scopes: Object.freeze(validateScopes(credential.scopes)),
    });
  }
  return Object.freeze(stores);
}

/** Parse a server-side JSON secret. Parse errors never echo the input. */
export function parseStaticOfflineStores(json: string): StaticOfflineStores {
  let value: unknown;
  try {
    if (typeof json !== 'string') throw new Error();
    value = JSON.parse(json);
  } catch {
    throw new StaticOfflineConfigurationError(
      'Static offline stores must be valid JSON.',
    );
  }
  return validateStores(value);
}
