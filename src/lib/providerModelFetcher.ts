/**
 * Provider Model Fetcher
 *
 * Queries provider APIs' /models endpoints to derive context lengths and max output tokens
 * when not available from other sources. Used as a fallback in the model capability
 * resolution chain.
 *
 * Supported formats:
 * - OpenAI-compatible: GET {baseUrl}/models (or provider.modelsUrl)
 *   Response: { data: [{ id, context_length?, max_output_tokens?, ... }] }
 * - Anthropic-compatible: GET {baseUrl}/models
 *   Response: { data: [{ id, display_name?, ... }] }
 *
 * Results are cached in-memory with a TTL to avoid excessive API calls.
 */

import { REGISTRY } from "@omniroute/open-sse/config/providerRegistry.ts";
import { getDbInstance } from "@/lib/db/core";

interface ModelSpecInfo {
  contextLength?: number;
  maxOutputTokens?: number;
}

interface FetchCacheEntry {
  specs: Map<string, ModelSpecInfo>;
  timestamp: number;
}

// In-memory cache with 15-minute TTL
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache: Map<string, FetchCacheEntry> = new Map();

/**
 * Get the API key for a provider from the database
 */
function getProviderApiKey(providerId: string): string | null {
  try {
    const db = getDbInstance();
    // Look up provider_connections table for an apikey connection matching this provider
    const row = db
      .prepare(
        "SELECT provider_specific_data FROM provider_connections WHERE provider = ? AND auth_type = 'apikey' LIMIT 1"
      )
      .get(providerId) as { provider_specific_data: string } | undefined;
    if (row?.provider_specific_data) {
      try {
        const data = JSON.parse(row.provider_specific_data);
        return typeof data.apiKey === "string" && data.apiKey.length > 0 ? data.apiKey : null;
      } catch {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build the models endpoint URL for a provider
 */
function getModelsUrl(providerId: string): string | null {
  const entry = REGISTRY[providerId];
  if (!entry) return null;

  // Use explicit modelsUrl if set
  if (entry.modelsUrl) return entry.modelsUrl;

  // Otherwise construct from baseUrl for OpenAI-compatible providers
  if (
    entry.baseUrl &&
    ["openai", "openrouter", "opencode", "cursor", "windsurf", "groq", "claude", "kiro"].includes(
      entry.format
    )
  ) {
    return entry.baseUrl.replace(/\/chat\/completions\/?$/, "/models");
  }

  return null;
}

/**
 * Build auth headers for a provider's models endpoint
 */
function getAuthHeaders(providerId: string): Record<string, string> {
  const entry = REGISTRY[providerId];
  if (!entry) return {};

  const headers: Record<string, string> = {
    ...((entry.headers as Record<string, string>) || {}),
  };

  const apiKey = getProviderApiKey(providerId);
  if (apiKey && entry.authType === "apikey") {
    const prefix = entry.authPrefix ?? "Bearer ";
    const header = entry.authHeader ?? "Authorization";
    headers[header] = `${prefix}${apiKey}`;
  }

  return headers;
}

/**
 * Extract model info from an OpenAI-compatible /models response
 */
function parseOpenAIModelsResponse(json: Record<string, unknown>): Map<string, ModelSpecInfo> {
  const result = new Map<string, ModelSpecInfo>();
  const data = json.data;
  if (!Array.isArray(data)) return result;

  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const model = entry as Record<string, unknown>;
    const id = typeof model.id === "string" && model.id.trim().length > 0 ? model.id.trim() : null;
    if (!id) continue;

    const specs: ModelSpecInfo = {};
    if (typeof model.context_length === "number" && model.context_length > 0) {
      specs.contextLength = model.context_length;
    }
    // Various possible field names for max output tokens
    const maxOutput =
      typeof model.max_output_tokens === "number" && model.max_output_tokens > 0
        ? model.max_output_tokens
        : typeof model.max_tokens === "number" && model.max_tokens > 0
          ? model.max_tokens
          : typeof model.max_completion_tokens === "number" && model.max_completion_tokens > 0
            ? model.max_completion_tokens
            : undefined;
    if (maxOutput) {
      specs.maxOutputTokens = maxOutput;
    }

    if (specs.contextLength || specs.maxOutputTokens) {
      result.set(id, specs);
    }
  }

  return result;
}

/**
 * Fetch model specs from a provider's /models endpoint.
 * Returns a Map of model ID → { contextLength?, maxOutputTokens? },
 * or null on error/no data.
 */
export async function fetchModelSpecs(
  providerId: string
): Promise<Map<string, ModelSpecInfo> | null> {
  // Check in-memory cache first
  const cached = cache.get(providerId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.specs;
  }

  const modelsUrl = getModelsUrl(providerId);
  if (!modelsUrl) {
    return null;
  }

  const headers = getAuthHeaders(providerId);

  try {
    const signal = AbortSignal.timeout(10000);
    const response = await fetch(modelsUrl, {
      method: "GET",
      headers,
      signal,
    });

    if (!response.ok) {
      return null;
    }

    const body = await response.text();
    if (!body.trim()) return null;

    const json = JSON.parse(body) as Record<string, unknown>;

    // Parse based on format
    const entry = REGISTRY[providerId];
    const format = entry?.format ?? "openai";

    let specs: Map<string, ModelSpecInfo>;
    if (
      ["openai", "openrouter", "opencode", "cursor", "windsurf", "groq", "glm", "kiro"].includes(
        format
      )
    ) {
      specs = parseOpenAIModelsResponse(json);
    } else if (format === "claude") {
      // Anthropic format: { data: [{ id, display_name, ... }] }
      specs = parseOpenAIModelsResponse(json); // Same structure
    } else {
      // Try generic parsing
      specs = parseOpenAIModelsResponse(json);
    }

    // Cache the result
    cache.set(providerId, { specs, timestamp: Date.now() });

    return specs.size > 0 ? specs : null;
  } catch {
    return null;
  }
}

/**
 * Get a specific model's spec info from the provider API.
 * Returns null if not found or error.
 */
export async function getModelSpecFromProvider(
  providerId: string,
  modelId: string
): Promise<ModelSpecInfo | null> {
  const specs = await fetchModelSpecs(providerId);
  if (!specs) return null;
  return specs.get(modelId) ?? null;
}

/**
 * Get a model's spec info from the in-memory cache synchronously.
 * Returns null if not cached or expired. Use fetchModelSpecs() to populate.
 */
export function getCachedModelSpec(providerId: string, modelId: string): ModelSpecInfo | null {
  const cached = cache.get(providerId);
  if (!cached || Date.now() - cached.timestamp >= CACHE_TTL_MS) return null;
  return cached.specs.get(modelId) ?? null;
}

/**
 * Get provider-level default from the in-memory cache synchronously.
 * Returns the first model's context/maxOutput as a provider approximation,
 * or null if nothing cached.
 */
export function getCachedProviderSpec(providerId: string): ModelSpecInfo | null {
  const cached = cache.get(providerId);
  if (!cached || Date.now() - cached.timestamp >= CACHE_TTL_MS) return null;
  // Return specs for first model as a rough provider default
  const firstEntry = cached.specs.values().next().value;
  return firstEntry ?? null;
}

/**
 * Pre-warm the cache for a provider by fetching its model specs.
 * Silently ignores errors — meant for startup/background pre-fetching.
 */
export async function prewarmSpecCache(providerId: string): Promise<void> {
  try {
    await fetchModelSpecs(providerId);
  } catch {
    // Silent; cache will be populated on next fetchModelSpecs call
  }
}

/**
 * Pre-warm caches for all providers that have model URLs configured.
 */
export async function prewarmAllSpecCaches(): Promise<void> {
  const providers = Object.keys(REGISTRY);
  const promises = providers.map((providerId) => prewarmSpecCache(providerId));
  await Promise.allSettled(promises);
}

/**
 * Clear the in-memory cache for testing or forced refresh
 */
export function clearSpecCache(providerId?: string): void {
  if (providerId) {
    cache.delete(providerId);
  } else {
    cache.clear();
  }
}
