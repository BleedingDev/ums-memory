import { createEpisode, type EntityInput } from "./entities.ts";
import { ConflictError, ContractViolationError } from "./errors.ts";
import { deepClone, deepFreeze, toIsoTimestamp } from "./utils.ts";

type Episode = ReturnType<typeof createEpisode>;

interface EpisodicStoreListOptions {
  since?: unknown;
  limit?: unknown;
  order?: unknown;
}

function compareChronologicalAsc(left: Episode, right: Episode): number {
  const createdDiff = left.createdAt.localeCompare(right.createdAt);
  if (createdDiff !== 0) {
    return createdDiff;
  }
  return left.id.localeCompare(right.id);
}

export class EpisodicStoreContract {
  append(_rawEpisode: unknown): Episode {
    throw new Error("append() not implemented");
  }

  getById(_episodeId: string): Episode | null {
    throw new Error("getById() not implemented");
  }

  listBySpace(
    _spaceId: string,
    _options: EpisodicStoreListOptions = {}
  ): Episode[] {
    throw new Error("listBySpace() not implemented");
  }

  listByIds(_episodeIds: unknown = []): Episode[] {
    throw new Error("listByIds() not implemented");
  }

  countBySpace(_spaceId: string): number {
    throw new Error("countBySpace() not implemented");
  }
}

export function assertEpisodicStoreContract(store: unknown): void {
  const candidate = store as Record<string, unknown> | null;
  const methods = [
    "append",
    "getById",
    "listBySpace",
    "listByIds",
    "countBySpace",
  ];
  for (const method of methods) {
    if (!candidate || typeof candidate[method] !== "function") {
      throw new ContractViolationError("episodic store contract violation", {
        missingMethod: method,
      });
    }
  }
}

export class InMemoryEpisodicStore extends EpisodicStoreContract {
  #episodesById = new Map<string, Episode>();
  #episodesBySpace = new Map<string, Episode[]>();

  override append(rawEpisode: unknown): Episode {
    const episode = createEpisode(rawEpisode as EntityInput);
    if (this.#episodesById.has(episode.id)) {
      throw new ConflictError(
        "episode id already exists in append-only store",
        {
          episodeId: episode.id,
          spaceId: episode.spaceId,
        }
      );
    }

    const storedEpisode = deepFreeze(deepClone(episode));
    this.#episodesById.set(storedEpisode.id, storedEpisode);

    const spaceEpisodes =
      this.#episodesBySpace.get(storedEpisode.spaceId) ?? [];
    spaceEpisodes.push(storedEpisode);
    spaceEpisodes.sort(compareChronologicalAsc);
    this.#episodesBySpace.set(storedEpisode.spaceId, spaceEpisodes);

    return deepClone(storedEpisode);
  }

  override getById(episodeId: string): Episode | null {
    const episode = this.#episodesById.get(episodeId);
    return episode ? deepClone(episode) : null;
  }

  override listByIds(episodeIds: unknown = []): Episode[] {
    if (!Array.isArray(episodeIds)) {
      return [];
    }
    const result: Episode[] = [];
    for (const episodeId of episodeIds) {
      const episode =
        typeof episodeId === "string"
          ? this.#episodesById.get(episodeId)
          : undefined;
      if (episode) {
        result.push(deepClone(episode));
      }
    }
    return result;
  }

  override listBySpace(
    spaceId: string,
    options: EpisodicStoreListOptions = {}
  ): Episode[] {
    const since = options.since ? toIsoTimestamp(options.since) : null;
    const parsedLimit = Number(options.limit);
    const limit = Number.isFinite(parsedLimit)
      ? Math.max(0, Math.floor(parsedLimit))
      : 100;
    const order = options.order === "desc" ? "desc" : "asc";

    const episodes = this.#episodesBySpace.get(spaceId) ?? [];
    const filtered = since
      ? episodes.filter((episode) => episode.createdAt >= since)
      : episodes;
    const ordered = order === "desc" ? [...filtered].reverse() : filtered;
    return ordered.slice(0, limit).map((episode) => deepClone(episode));
  }

  override countBySpace(spaceId: string): number {
    return (this.#episodesBySpace.get(spaceId) ?? []).length;
  }
}
