export interface ContextEventRecord {
  readonly eventId: string;
  readonly type: string;
  readonly source: string;
  readonly content: string;
  readonly digest: string;
}

export interface ContextMatchRecord {
  readonly eventId: string;
  readonly usageId: string;
  readonly type: string;
  readonly source: string;
  readonly excerpt: string;
  readonly digest: string;
}

export interface MisconceptionChronologyRecord {
  readonly noteId: string;
  readonly misconceptionId: string | null;
  readonly misconceptionKey: string;
  readonly profileId: string | null;
  readonly timestamp: string;
  readonly changedFields: ReadonlyArray<string>;
  readonly previousDigest: string | null;
  readonly nextDigest: string | null;
  readonly confidence: number | null;
  readonly harmfulSignalCount: number | null;
  readonly evidenceEventIds: ReadonlyArray<string>;
}

export interface ContextPackInput {
  readonly query: string;
  readonly limit: number;
  readonly chronologyLimit: number;
  readonly events: ReadonlyArray<ContextEventRecord>;
  readonly chronologyHistory: ReadonlyArray<MisconceptionChronologyRecord>;
  readonly makeUsageId: (event: ContextEventRecord) => string;
}

export interface ContextPackOutput {
  readonly matches: ReadonlyArray<ContextMatchRecord>;
  readonly misconceptionChronology: {
    readonly bounded: boolean;
    readonly truncated: boolean;
    readonly deterministicFormatting: true;
    readonly prioritization:
      | "query_relevance_then_recency_then_noteId"
      | "severity_then_recency_then_noteId";
    readonly limit: number;
    readonly totalAvailable: number;
    readonly notes: ReadonlyArray<
      MisconceptionChronologyRecord & {
        readonly relevance: number;
      }
    >;
    readonly formatting: ReadonlyArray<string>;
  };
}

const compareStrings = (left: string, right: string) =>
  left.localeCompare(right);

const sortByTimestampAndId = <T extends Record<string, unknown>>(
  values: ReadonlyArray<T>,
  timestampField: keyof T,
  idField: keyof T
) =>
  [...values].sort((left, right) => {
    const timestampOrder = String(left[timestampField] ?? "").localeCompare(
      String(right[timestampField] ?? "")
    );
    if (timestampOrder !== 0) {
      return timestampOrder;
    }
    return compareStrings(
      String(left[idField] ?? ""),
      String(right[idField] ?? "")
    );
  });

const scoreChronologyEntry = (
  note: MisconceptionChronologyRecord,
  query: string
) => {
  const searchable =
    `${note.misconceptionKey} ${note.changedFields.join(" ")}`.toLowerCase();
  return (
    (query.length > 0 && searchable.includes(query) ? 60 : 0) +
    (note.changedFields.includes("harmfulSignalCount") ? 20 : 0) +
    (note.changedFields.includes("status") ? 15 : 0) +
    (note.changedFields.includes("confidence") ? 10 : 0)
  );
};

export const buildContextPack = ({
  query,
  limit,
  chronologyLimit,
  events,
  chronologyHistory,
  makeUsageId,
}: ContextPackInput): ContextPackOutput => {
  const normalizedQuery = query.toLowerCase();
  const matches = events
    .map((event) => {
      const searchable =
        `${event.type} ${event.source} ${event.content}`.toLowerCase();
      return {
        event,
        matchesQuery:
          normalizedQuery.length === 0 || searchable.includes(normalizedQuery),
      };
    })
    .filter((entry) => entry.matchesQuery)
    .slice(0, limit)
    .map(({ event }) => ({
      eventId: event.eventId,
      usageId: makeUsageId(event),
      type: event.type,
      source: event.source,
      excerpt: event.content.slice(0, 180),
      digest: event.digest,
    }));

  const prioritizedChronology = chronologyHistory
    .map((note) => ({
      ...note,
      relevance: scoreChronologyEntry(note, normalizedQuery),
    }))
    .sort((left, right) => {
      if (right.relevance !== left.relevance) {
        return right.relevance - left.relevance;
      }
      const recencyOrder = right.timestamp.localeCompare(left.timestamp);
      if (recencyOrder !== 0) {
        return recencyOrder;
      }
      return compareStrings(left.noteId, right.noteId);
    })
    .slice(0, chronologyLimit);

  const orderedChronology = sortByTimestampAndId(
    prioritizedChronology,
    "timestamp",
    "noteId"
  );

  return {
    matches,
    misconceptionChronology: {
      bounded: chronologyHistory.length <= chronologyLimit,
      truncated: chronologyHistory.length > chronologyLimit,
      deterministicFormatting: true,
      prioritization:
        normalizedQuery.length > 0
          ? "query_relevance_then_recency_then_noteId"
          : "severity_then_recency_then_noteId",
      limit: chronologyLimit,
      totalAvailable: chronologyHistory.length,
      notes: orderedChronology,
      formatting: orderedChronology.map(
        (note, index) =>
          `${index + 1}. ${note.timestamp} ${note.misconceptionKey} -> ${note.changedFields.join("|")}`
      ),
    },
  };
};
