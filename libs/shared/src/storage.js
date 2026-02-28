import { createEpisode } from "./entities.js";
import { ConflictError, ContractViolationError } from "./errors.js";
import { deepClone, deepFreeze, toIsoTimestamp } from "./utils.js";

function compareChronologicalAsc(left, right) {
  const createdDiff = left.createdAt.localeCompare(right.createdAt);
  if (createdDiff !== 0) {
    return createdDiff;
  }
  return left.id.localeCompare(right.id);
}

export class EpisodicStoreContract {
  append() {
    throw new Error("append() not implemented");
  }

  getById() {
    throw new Error("getById() not implemented");
  }

  listBySpace() {
    throw new Error("listBySpace() not implemented");
  }

  listByIds() {
    throw new Error("listByIds() not implemented");
  }

  countBySpace() {
    throw new Error("countBySpace() not implemented");
  }
}

export function assertEpisodicStoreContract(store) {
  const methods = ["append", "getById", "listBySpace", "listByIds", "countBySpace"];
  for (const method of methods) {
    if (typeof store?.[method] !== "function") {
      throw new ContractViolationError("episodic store contract violation", {
        missingMethod: method,
      });
    }
  }
}

export class InMemoryEpisodicStore extends EpisodicStoreContract {
  #episodesById = new Map();
  #episodesBySpace = new Map();

  append(rawEpisode) {
    const episode = createEpisode(rawEpisode);
    if (this.#episodesById.has(episode.id)) {
      throw new ConflictError("episode id already exists in append-only store", {
        episodeId: episode.id,
        spaceId: episode.spaceId,
      });
    }

    const storedEpisode = deepFreeze(deepClone(episode));
    this.#episodesById.set(storedEpisode.id, storedEpisode);

    const spaceEpisodes = this.#episodesBySpace.get(storedEpisode.spaceId) ?? [];
    spaceEpisodes.push(storedEpisode);
    spaceEpisodes.sort(compareChronologicalAsc);
    this.#episodesBySpace.set(storedEpisode.spaceId, spaceEpisodes);

    return deepClone(storedEpisode);
  }

  getById(episodeId) {
    const episode = this.#episodesById.get(episodeId);
    return episode ? deepClone(episode) : null;
  }

  listByIds(episodeIds = []) {
    if (!Array.isArray(episodeIds)) {
      return [];
    }
    const result = [];
    for (const episodeId of episodeIds) {
      const episode = this.#episodesById.get(episodeId);
      if (episode) {
        result.push(deepClone(episode));
      }
    }
    return result;
  }

  listBySpace(spaceId, options = {}) {
    const since = options.since ? toIsoTimestamp(options.since) : null;
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 100;
    const order = options.order === "desc" ? "desc" : "asc";

    const episodes = this.#episodesBySpace.get(spaceId) ?? [];
    const filtered = since ? episodes.filter((episode) => episode.createdAt >= since) : episodes;
    const ordered = order === "desc" ? [...filtered].reverse() : filtered;
    return ordered.slice(0, limit).map((episode) => deepClone(episode));
  }

  countBySpace(spaceId) {
    return (this.#episodesBySpace.get(spaceId) ?? []).length;
  }
}
