export interface CuratableCandidate {
  readonly candidateId: string;
  readonly ruleId: string;
  readonly statement: string;
  readonly scope?: string;
  readonly confidence: number;
}

export interface CandidateValidationSummary {
  readonly candidateId: string;
  readonly valid: boolean;
  readonly evidenceDepth?: number;
  readonly contradictionCount?: number;
  readonly freshnessDays?: number | null;
}

export interface ExistingCuratedRule {
  readonly ruleId: string;
  readonly statement?: string;
  readonly scope?: string;
  readonly selectedCandidateId?: string | null;
}

export interface CurationSelectionInput {
  readonly candidates: ReadonlyArray<CuratableCandidate>;
  readonly validations: ReadonlyArray<CandidateValidationSummary>;
  readonly existingRules: ReadonlyArray<ExistingCuratedRule>;
}

export interface CurationSelectionOutput {
  readonly winners: ReadonlyArray<CuratableCandidate>;
  readonly rejected: ReadonlyArray<{
    readonly candidateId: string;
    readonly ruleId: string;
    readonly winnerCandidateId: string;
    readonly reason: "conflict_lost_tie_break";
  }>;
}

const compareStrings = (left: string, right: string) =>
  left.localeCompare(right);

const defaultFreshness = Number.POSITIVE_INFINITY;
const defaultEvidenceDepth = 0;
const defaultContradictionCount = Number.POSITIVE_INFINITY;
const conflictKeyForCandidate = (candidate: CuratableCandidate) =>
  `${candidate.scope ?? "global"}::${candidate.statement}`;
const conflictKeyForRule = (rule: ExistingCuratedRule) =>
  `${rule.scope ?? "global"}::${rule.statement ?? rule.ruleId}`;

export const selectCurationCandidates = ({
  candidates,
  validations,
  existingRules,
}: CurationSelectionInput): CurationSelectionOutput => {
  const validationByCandidateId = new Map(
    validations.map((validation) => [validation.candidateId, validation])
  );
  const incumbentByConflictKey = new Map(
    existingRules.map((rule) => [
      conflictKeyForRule(rule),
      rule.selectedCandidateId ?? null,
    ])
  );
  const groupedCandidates = new Map<string, Array<CuratableCandidate>>();

  for (const candidate of candidates) {
    const conflictKey = conflictKeyForCandidate(candidate);
    const existingGroup = groupedCandidates.get(conflictKey) ?? [];
    existingGroup.push(candidate);
    groupedCandidates.set(conflictKey, existingGroup);
  }

  const winners: CuratableCandidate[] = [];
  const rejected: Array<{
    readonly candidateId: string;
    readonly ruleId: string;
    readonly winnerCandidateId: string;
    readonly reason: "conflict_lost_tie_break";
  }> = [];

  for (const conflictKey of [...groupedCandidates.keys()].sort(
    compareStrings
  )) {
    const incumbentCandidateId =
      incumbentByConflictKey.get(conflictKey) ?? null;
    const orderedCandidates = [
      ...(groupedCandidates.get(conflictKey) ?? []),
    ].sort((left, right) => {
      const leftValidation = validationByCandidateId.get(left.candidateId);
      const rightValidation = validationByCandidateId.get(right.candidateId);
      if (
        Number(rightValidation?.valid ?? 0) !==
        Number(leftValidation?.valid ?? 0)
      ) {
        return (
          Number(rightValidation?.valid ?? 0) -
          Number(leftValidation?.valid ?? 0)
        );
      }
      if (
        (rightValidation?.evidenceDepth ?? defaultEvidenceDepth) !==
        (leftValidation?.evidenceDepth ?? defaultEvidenceDepth)
      ) {
        return (
          (rightValidation?.evidenceDepth ?? defaultEvidenceDepth) -
          (leftValidation?.evidenceDepth ?? defaultEvidenceDepth)
        );
      }
      if (
        (leftValidation?.contradictionCount ?? defaultContradictionCount) !==
        (rightValidation?.contradictionCount ?? defaultContradictionCount)
      ) {
        return (
          (leftValidation?.contradictionCount ?? defaultContradictionCount) -
          (rightValidation?.contradictionCount ?? defaultContradictionCount)
        );
      }
      if (
        (leftValidation?.freshnessDays ?? defaultFreshness) !==
        (rightValidation?.freshnessDays ?? defaultFreshness)
      ) {
        return (
          (leftValidation?.freshnessDays ?? defaultFreshness) -
          (rightValidation?.freshnessDays ?? defaultFreshness)
        );
      }
      if (right.confidence !== left.confidence) {
        return right.confidence - left.confidence;
      }
      if (incumbentCandidateId) {
        const leftIncumbent = left.candidateId === incumbentCandidateId ? 1 : 0;
        const rightIncumbent =
          right.candidateId === incumbentCandidateId ? 1 : 0;
        if (rightIncumbent !== leftIncumbent) {
          return rightIncumbent - leftIncumbent;
        }
      }
      return compareStrings(left.candidateId, right.candidateId);
    });
    const winner = orderedCandidates[0];
    if (!winner) {
      continue;
    }
    winners.push(winner);
    for (const loser of orderedCandidates.slice(1)) {
      rejected.push({
        candidateId: loser.candidateId,
        ruleId: loser.ruleId,
        winnerCandidateId: winner.candidateId,
        reason: "conflict_lost_tie_break",
      });
    }
  }

  return {
    winners,
    rejected,
  };
};
