import type { IncomingMessage, ServerResponse } from 'http';

/**
 * A proxy plugin intercepts requests matching specific URL path prefixes
 * and handles them independently of the core credential proxy routing.
 *
 * Plugins self-register at import time (like channels).
 * If a plugin's factory returns null, it is not active (e.g. missing credentials).
 */
export interface ProxyPlugin {
  /** Human-readable name for logging */
  name: string;
  /** URL path prefixes this plugin handles (e.g. ['/uplynk/']) */
  pathPrefixes: string[];
  /**
   * Handle an incoming request.
   * @returns true if handled (response sent), false to pass through to default routing.
   */
  handle(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<boolean>;
}

export type ProxyPluginFactory = () => ProxyPlugin | null;

const registry = new Map<string, ProxyPluginFactory>();

export function registerProxyPlugin(name: string, factory: ProxyPluginFactory): void {
  registry.set(name, factory);
}

/**
 * Instantiate all registered plugins. Factories that return null are excluded.
 * Called once at proxy startup.
 */
export function createProxyPlugins(): ProxyPlugin[] {
  return [...registry.values()]
    .map(factory => factory())
    .filter((p): p is ProxyPlugin => p !== null);
}
