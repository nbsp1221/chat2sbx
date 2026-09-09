import type { AppConfig } from '../config.js';

export function gatewayUrl(config: Pick<AppConfig, 'host' | 'port'>, pathname: string): string {
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  return `http://${host}:${config.port}${pathname}`;
}
