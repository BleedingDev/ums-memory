export interface ValidatorEvent {
  readonly eventId: string;
  readonly timestamp?: string;
}

export interface ValidatorCandidate {
  readonly candidateId: string;
  readonly statement: string;
  readonly sourceEventId: string;
  readonly sourceEventIds: ReadonlyArray<string>;
  readonly evidenceEventIds: ReadonlyArray<string>;
  readonly contradictionEventIds: ReadonlyArray<string>;
}

export interface CandidateValidation {
  readonly candidateId: string;
  readonly valid: boolean;
  readonly evidenceEventId: string | null;
  readonly evidenceEventIds: ReadonlyArray<string>;
  readonly evidenceDepth: number;
  readonly contradictionCount: number;
  readonly freshnessDays: number | null;
  readonly reasonCodes: ReadonlyArray<string>;
}

export interface ValidatorInput {
  readonly candidates: ReadonlyArray<ValidatorCandidate>;
  readonly events: ReadonlyArray<ValidatorEvent>;
  readonly evaluatedAt: string;
  readonly freshnessWarningDays: number;
  readonly minEvidenceDepth: number;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const compareStrings = (left: string, right: string) =>
  left.localeCompare(right);

const differenceInDays = (evaluatedAt: string, evidenceTimestamp?: string) => {
  if (!evidenceTimestamp) {
    return null;
  }
  const evaluatedAtMs = Date.parse(evaluatedAt);
  const evidenceMs = Date.parse(evidenceTimestamp);
  if (Number.isNaN(evaluatedAtMs) || Number.isNaN(evidenceMs)) {
    return null;
  }
  return Math.max(
    0,
    Math.floor((evaluatedAtMs - evidenceMs) / MILLISECONDS_PER_DAY)
  );
};

const sortEventIds = (eventIds: ReadonlyArray<string>) =>
  [...eventIds].sort(compareStrings);

export const buildCandidateValidations = ({
  candidates,
  events,
  evaluatedAt,
  freshnessWarningDays,
  minEvidenceDepth,
}: ValidatorInput): ReadonlyArray<CandidateValidation> => {
  const eventById = new Map(events.map((event) => [event.eventId, event]));

  return candidates.map((candidate) => {
    const evidenceIds = sortEventIds(
      Array.from(
        new Set([
          candidate.sourceEventId,
          ...candidate.sourceEventIds,
          ...candidate.evidenceEventIds,
        ])
      ).filter((eventId) => eventId.length > 0)
    );
    const contradictionIds = sortEventIds(
      Array.from(new Set(candidate.contradictionEventIds)).filter(
        (eventId) => eventId.length > 0
      )
    );
    const evidenceEvents = evidenceIds
      .map((eventId) => eventById.get(eventId))
      .filter((event): event is ValidatorEvent => Boolean(event));
    const contradictionEvents = contradictionIds
      .map((eventId) => eventById.get(eventId))
      .filter((event): event is ValidatorEvent => Boolean(event));
    const latestEvidenceTimestamp = evidenceEvents
      .map((event) => event.timestamp)
      .filter((timestamp): timestamp is string => Boolean(timestamp))
      .sort((left, right) => right.localeCompare(left))[0];
    const freshnessDays = differenceInDays(
      evaluatedAt,
      latestEvidenceTimestamp
    );

    const reasonCodes: string[] = [];
    if (candidate.statement.length === 0) {
      reasonCodes.push("empty_statement");
    }
    if (evidenceEvents.length < minEvidenceDepth) {
      reasonCodes.push("insufficient_evidence_depth");
    }
    if (contradictionEvents.length > 0) {
      reasonCodes.push("contradicting_evidence");
    }
    if (freshnessDays !== null && freshnessDays > freshnessWarningDays) {
      reasonCodes.push("stale_evidence");
    }
    if (reasonCodes.length === 0) {
      reasonCodes.push("accepted");
    }

    return {
      candidateId: candidate.candidateId,
      valid: reasonCodes.length === 1 && reasonCodes[0] === "accepted",
      evidenceEventId: evidenceIds[0] ?? null,
      evidenceEventIds: evidenceIds,
      evidenceDepth: evidenceEvents.length,
      contradictionCount: contradictionEvents.length,
      freshnessDays,
      reasonCodes,
    };
  });
};
