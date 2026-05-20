import {
  getSyncedAvailableModelsForConnection,
  replaceSyncedAvailableModelsForConnection,
  type SyncedAvailableModel,
} from "@/lib/db/models";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function isAutoFetchModelsEnabled(providerSpecificData: unknown): boolean {
  return asRecord(providerSpecificData).autoFetchModels !== false;
}

export function normalizeDiscoveredModels(models: unknown): SyncedAvailableModel[] {
  const items = Array.isArray(models) ? models : [];
  const deduped = new Map<string, SyncedAvailableModel>();

  for (const item of items) {
    const record = asRecord(item);
    const id =
      toNonEmptyString(record.id) ||
      toNonEmptyString(record.name) ||
      toNonEmptyString(record.model);
    if (!id) continue;

    const name =
      toNonEmptyString(record.name) ||
      toNonEmptyString(record.displayName) ||
      toNonEmptyString(record.model) ||
      id;
    const supportedEndpoints = Array.isArray(record.supportedEndpoints)
      ? Array.from(
          new Set(
            record.supportedEndpoints
              .map((endpoint) => toNonEmptyString(endpoint))
              .filter((endpoint): endpoint is string => Boolean(endpoint))
          )
        ).sort()
      : undefined;

    const modalities = Array.isArray(record.modalities)
      ? record.modalities
      : (asRecord(record.modalities).input as string[]) || [];

    const hasVision =
      record.supportsVision === true ||
      record.vision === true ||
      modalities.some((m: string) => String(m).includes("image")) ||
      id.includes("vision") ||
      id.includes("-v1") ||
      id.includes("-v2") ||
      id.includes("-v3") ||
      id.includes("gpt-4o") ||
      id.includes("claude-3") ||
      id.includes("gemini");

    const hasAudio =
      record.supportsAudio === true ||
      record.audio === true ||
      modalities.some((m: string) => String(m).includes("audio"));

    const hasVideo =
      record.supportsVideo === true ||
      record.video === true ||
      modalities.some((m: string) => String(m).includes("video"));

    const hasThinking = record.supportsThinking === true || record.reasoning === true;

    deduped.set(id, {
      id,
      name,
      source: "imported",
      ...(toNonEmptyString(record.apiFormat)
        ? { apiFormat: toNonEmptyString(record.apiFormat)! }
        : {}),
      ...(supportedEndpoints && supportedEndpoints.length > 0 ? { supportedEndpoints } : {}),
      ...(typeof record.inputTokenLimit === "number"
        ? { inputTokenLimit: record.inputTokenLimit }
        : {}),
      ...(typeof record.outputTokenLimit === "number"
        ? { outputTokenLimit: record.outputTokenLimit }
        : {}),
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      ...(hasThinking ? { supportsThinking: true } : {}),
      ...(hasVision ? { supportsVision: true } : {}),
      ...(hasAudio ? { supportsAudio: true } : {}),
      ...(hasVideo ? { supportsVideo: true } : {}),
    });
  }

  return Array.from(deduped.values());
}

export async function getCachedDiscoveredModels(
  providerId: string,
  connectionId: string
): Promise<SyncedAvailableModel[]> {
  return getSyncedAvailableModelsForConnection(providerId, connectionId);
}

export async function persistDiscoveredModels(
  providerId: string,
  connectionId: string,
  models: unknown
): Promise<SyncedAvailableModel[]> {
  const normalized = normalizeDiscoveredModels(models);
  await replaceSyncedAvailableModelsForConnection(providerId, connectionId, normalized);
  return normalized;
}
