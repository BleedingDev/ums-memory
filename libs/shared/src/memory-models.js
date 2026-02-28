import {
  createAntiPattern,
  createProceduralRule,
  createWorkingMemoryEntry,
  ProceduralEntryStatus,
  WorkingMemoryKind,
} from "./entities.js";
import { clamp, deterministicId, toIsoTimestamp } from "./utils.js";

function summarizeEpisodes(episodes) {
  return episodes
    .map((episode) => `[${episode.type}] ${episode.content}`.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 1200);
}

export class WorkingMemoryModel {
  buildDiary({ spaceId, episodes, now }) {
    const createdAt = toIsoTimestamp(now);
    const evidenceEpisodeIds = episodes.map((episode) => episode.id).sort();
    const content = summarizeEpisodes(episodes) || "No episodic data available.";

    return createWorkingMemoryEntry({
      id: deterministicId("wm_diary", {
        spaceId,
        evidenceEpisodeIds,
        createdAt,
      }),
      spaceId,
      kind: WorkingMemoryKind.DIARY,
      content,
      evidenceEpisodeIds,
      createdAt,
      metadata: {
        episodeCount: episodes.length,
      },
    });
  }

  buildDigest({ spaceId, episodes, now }) {
    const createdAt = toIsoTimestamp(now);
    const evidenceEpisodeIds = episodes.map((episode) => episode.id).sort();
    const uniqueTypes = Array.from(new Set(episodes.map((episode) => episode.type))).sort();
    const content = `Digest: ${episodes.length} episodes, types=${uniqueTypes.join(", ") || "none"}`;

    return createWorkingMemoryEntry({
      id: deterministicId("wm_digest", {
        spaceId,
        evidenceEpisodeIds,
        createdAt,
      }),
      spaceId,
      kind: WorkingMemoryKind.DIGEST,
      content,
      evidenceEpisodeIds,
      createdAt,
      metadata: {
        episodeCount: episodes.length,
        types: uniqueTypes,
      },
    });
  }
}

export class ProceduralMemoryModel {
  promoteCandidate(candidate, now) {
    return createProceduralRule({
      ...candidate,
      createdAt: candidate.createdAt ?? now,
      updatedAt: candidate.updatedAt ?? now,
      lastValidatedAt: candidate.lastValidatedAt ?? now,
      status: candidate.status ?? ProceduralEntryStatus.ACTIVE,
    });
  }

  reinforceRule(rule, { helpful = 0, harmful = 0, now }) {
    const delta = helpful * 0.08 - harmful * 0.18;
    const confidence = clamp(rule.confidence + delta, 0, 1);
    const nextStatus =
      confidence <= 0.05 ? ProceduralEntryStatus.TOMBSTONED : ProceduralEntryStatus.ACTIVE;

    return createProceduralRule({
      ...rule,
      confidence,
      status: nextStatus,
      updatedAt: now,
      lastValidatedAt: now,
    });
  }

  tombstoneRule(rule, { now, reason }) {
    return createProceduralRule({
      ...rule,
      status: ProceduralEntryStatus.TOMBSTONED,
      updatedAt: now,
      metadata: {
        ...(rule.metadata ?? {}),
        tombstoneReason: reason ?? "manual",
        tombstonedAt: toIsoTimestamp(now),
      },
    });
  }

  invertRuleToAntiPattern(rule, { now, reason }) {
    return createAntiPattern({
      id: deterministicId("anti", {
        sourceRuleId: rule.id,
        reason: reason ?? "harmful",
      }),
      spaceId: rule.spaceId,
      statement: `Avoid: ${rule.statement}`,
      confidence: clamp(rule.confidence, 0.2, 1),
      tags: rule.tags,
      evidenceEpisodeIds: rule.evidenceEpisodeIds,
      sourceRuleId: rule.id,
      createdAt: now,
      metadata: {
        reason: reason ?? "harmful",
      },
    });
  }
}
