/** Invalid or unsupported static credential configuration. Never contains secrets. */
export class StaticOfflineConfigurationError extends Error {
  readonly code = 'STATIC_OFFLINE_CONFIGURATION';
  constructor(message: string) {
    super(message);
    this.name = 'StaticOfflineConfigurationError';
  }
}

/** A shop is outside this app instance's configured allowlist. */
export class StaticOfflineShopNotConfiguredError extends Error {
  readonly code = 'STATIC_OFFLINE_SHOP_NOT_CONFIGURED';
  constructor() {
    super('The shop is not configured for static offline access.');
    this.name = 'StaticOfflineShopNotConfiguredError';
  }
}

/** Runtime session writes cannot change server-side credentials. */
export class StaticOfflineReadOnlyError extends Error {
  readonly code = 'STATIC_OFFLINE_READ_ONLY';
  constructor() {
    super(
      'Static offline credentials are read-only. Update the server configuration and redeploy all instances.',
    );
    this.name = 'StaticOfflineReadOnlyError';
  }
}

/** Shopify rejected an access token. It must be replaced outside the request flow. */
export class StaticOfflineTokenRejectedError extends Error {
  readonly code = 'STATIC_OFFLINE_TOKEN_REJECTED';
  constructor() {
    super(
      'Shopify rejected the configured offline token. Replace it and redeploy all instances.',
    );
    this.name = 'StaticOfflineTokenRejectedError';
  }
}
