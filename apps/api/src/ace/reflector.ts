export interface ReflectorEvent {
  readonly eventId: string;
  readonly type: string;
  readonly source: string;
  readonly content: string;
  readonly timestamp?: string;
}

export interface ReflectedCandidate {
  readonly candidateId: string;
  readonly ruleId: string;
  readonly statement: string;
  readonly sourceEventId: string;
  readonly sourceEventIds: ReadonlyArray<string>;
  readonly evidenceEventIds: ReadonlyArray<string>;
  readonly contradictionEventIds: ReadonlyArray<string>;
  readonly scope: string;
  readonly confidence: number;
}

export interface ReflectorInput {
  readonly events: ReadonlyArray<ReflectorEvent>;
  readonly maxCandidates: number;
  readonly normalizeRuleCandidate: (
    candidate: Record<string, unknown>
  ) => ReflectedCandidate;
}

const MAX_REFLECTED_CANDIDATES = 32;

const compareStrings = (left: string, right: string) =>
  left.localeCompare(right);

export const buildReflectedCandidates = ({
  events,
  maxCandidates,
  normalizeRuleCandidate,
}: ReflectorInput): ReadonlyArray<ReflectedCandidate> => {
  const boundedMax = Math.min(
    Math.max(maxCandidates, 1),
    MAX_REFLECTED_CANDIDATES
  );
  const seenConflictKeys = new Set<string>();
  const candidates: Array<{
    readonly index: number;
    readonly candidate: ReflectedCandidate;
  }> = [];

  const prioritizedEvents = [...events]
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      if (right.index !== left.index) {
        return right.index - left.index;
      }
      const timestampOrder = String(right.event.timestamp ?? "").localeCompare(
        String(left.event.timestamp ?? "")
      );
      if (timestampOrder !== 0) {
        return timestampOrder;
      }
      return compareStrings(left.event.eventId, right.event.eventId);
    });

  for (const { event, index } of prioritizedEvents) {
    const candidate = normalizeRuleCandidate({
      statement: `Prefer source=${event.source} for type=${event.type}`,
      sourceEventId: event.eventId,
      sourceEventIds: [event.eventId],
      evidenceEventIds: [event.eventId],
      contradictionEventIds: [],
      scope: "global",
      confidence: 0.6,
    });
    const conflictKey = `${candidate.scope}::${candidate.statement}`;
    if (seenConflictKeys.has(conflictKey)) {
      continue;
    }
    seenConflictKeys.add(conflictKey);
    candidates.push({ index, candidate });
    if (candidates.length >= boundedMax) {
      break;
    }
  }

  return candidates
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.candidate);
};
