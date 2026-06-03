/**
 * Transform registry — maps transform names to factories.
 *
 * Transforms reshape request/response bodies between the Anthropic Messages API
 * (what Claude Code speaks) and an upstream vendor API (e.g. OpenAI ChatCompletions).
 * They are pure-function modules with no HTTP or env dependencies.
 *
 * Mirrors the proxy plugin registry pattern (src/proxy-plugins/registry.ts).
 */

/**
 * A bidirectional inference transform.
 * Stateless for request/response; streaming is stateful per-request via factory.
 */
export interface InferenceTransform {
  /** Registry name (e.g. 'openai') */
  name: string;

  /**
   * Anthropic Messages request body → upstream vendor request body.
   * Returns the reshaped body, target path, and optional content-type override.
   */
  transformRequest(body: Buffer): {
    body: Buffer;
    path: string;
    contentType?: string;
  };

  /**
   * Non-streaming upstream response body → Anthropic Messages response body.
   */
  transformResponse(body: Buffer): Buffer;

  /**
   * Create a stateful stream transformer for a single SSE request.
   * Each invocation of the returned function maps one upstream chunk
   * to zero-or-more Anthropic SSE bytes.
   */
  createStreamTransformer(): (chunk: Buffer) => Buffer;
}

export type InferenceTransformFactory = () => InferenceTransform;

const registry = new Map<string, InferenceTransformFactory>();

export function registerTransform(
  name: string,
  factory: InferenceTransformFactory,
): void {
  registry.set(name, factory);
}

/**
 * Look up a transform by name. Returns undefined if not registered.
 */
export function getTransform(name: string): InferenceTransform | undefined {
  const factory = registry.get(name);
  return factory ? factory() : undefined;
}
