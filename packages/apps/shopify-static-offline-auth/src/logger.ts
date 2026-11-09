import type {StaticOfflineAppConfig} from './types';

/** Shopify debug logs can include JWTs. Redact them at the final log sink. */
export function redactedLogger(config: StaticOfflineAppConfig) {
  const secrets = [
    config.apiSecretKey,
    ...Object.values(config.stores).map((store) => store.accessToken),
  ]
    .filter(
      (secret): secret is string =>
        typeof secret === 'string' && secret.length > 0,
    )
    .sort((a, b) => b.length - a.length);
  const sink =
    config.logger?.log ?? ((_severity, message) => console.log(message));
  return {
    ...config.logger,
    log(severity: Parameters<typeof sink>[0], message: string) {
      let redacted = message.replace(
        /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        (match) =>
          match.startsWith('eyJ') || match.split('.')[2].length >= 20
            ? '[REDACTED JWT]'
            : match,
      );
      for (const secret of secrets)
        redacted = redacted.split(secret).join('[REDACTED]');
      sink(severity, redacted);
    },
  };
}
