# Placeholder Contract Inventory (2026-03-04)

## Executive Summary

- File audited: `libs/shared/src/repositories.ts`
- Placeholder throw sites (`"not implemented"`): **36**
- Placeholder classes: **13**
- Concrete in-memory classes exist for all 13 contract types, but the placeholder base classes are still runtime-instantiable and will throw if used directly.

## Exact Placeholder Sites

### Repository contracts

1. `ProceduralRepositoryContract` (`line 378`)
   - `upsertRule` (`380`)
   - `getRuleById` (`384`)
   - `listRules` (`391`)
   - `upsertAntiPattern` (`395`)
   - `listAntiPatterns` (`402`)

2. `WorkingMemoryRepositoryContract` (`line 406`)
   - `upsertEntry` (`408`)
   - `getEntryById` (`412`)
   - `listEntries` (`419`)

3. `LearnerProfileRepositoryContract` (`line 433`)
   - `upsertProfile` (`435`)
   - `getProfileById` (`439`)
   - `listProfiles` (`446`)

4. `IdentityGraphRepositoryContract` (`line 450`)
   - `upsertEdge` (`452`)
   - `getEdgeById` (`456`)
   - `listEdges` (`463`)

5. `MisconceptionRepositoryContract` (`line 467`)
   - `upsertMisconception` (`469`)
   - `getMisconceptionById` (`476`)
   - `listMisconceptions` (`483`)

6. `CurriculumPlannerRepositoryContract` (`line 487`)
   - `upsertPlanItem` (`489`)
   - `getPlanItemById` (`496`)
   - `listPlanItems` (`503`)

7. `SpacedRepetitionRepositoryContract` (`line 507`)
   - `upsertScheduleEntry` (`509`)
   - `getScheduleEntryById` (`516`)
   - `listScheduleEntries` (`523`)

8. `PersonalizationPolicyRepositoryContract` (`line 527`)
   - `upsertPolicyDecision` (`531`)
   - `getPolicyDecisionById` (`538`)
   - `listPolicyDecisions` (`545`)

### Index contracts

9. `MemoryIndexContract` (`line 423`)
   - `upsert` (`425`)
   - `search` (`429`)

10. `MisconceptionIndexContract` (`line 549`)
    - `upsert` (`551`)
    - `search` (`557`)

11. `CurriculumPlannerIndexContract` (`line 561`)
    - `upsert` (`563`)
    - `listRecommendations` (`569`)

12. `SpacedRepetitionIndexContract` (`line 573`)
    - `upsert` (`575`)
    - `listDue` (`579`)

13. `PersonalizationPolicyIndexContract` (`line 583`)
    - `upsert` (`585`)
    - `search` (`589`)

## What Is Already Implemented

- In-memory concrete implementations exist and are non-placeholder:
  - `InMemoryProceduralRepository` (`line 734`)
  - `InMemoryWorkingMemoryRepository` (`line 837`)
  - `InMemoryLearnerProfileRepository` (`line 885`)
  - `InMemoryIdentityGraphRepository` (`line 955`)
  - `InMemoryMisconceptionRepository` (`line 1233`)
  - `InMemoryCurriculumPlannerRepository` (`line 1296`)
  - `InMemorySpacedRepetitionRepository` (`line 1360`)
  - `InMemoryPersonalizationPolicyRepository` (`line 1430`)
  - `InMemoryKeywordIndex` (`line 1538`)
  - `InMemoryMisconceptionIndex` (`line 1649`)
  - `InMemoryCurriculumPlannerIndex` (`line 1738`)
  - `InMemorySpacedRepetitionIndex` (`line 1811`)
  - `InMemoryPersonalizationPolicyIndex` (`line 1873`)

## Remaining Work

1. Convert placeholder base contracts to compile-time-only contracts.
   - Recommendation: replace throw-based base classes with `abstract class`/`interface` definitions.
   - Why: removes runtime footguns where direct instantiation compiles but crashes.

2. Align base contract declarations with assertion expectations.
   - `assert*Contract` currently requires `count*` methods (`lines 614, 628, 638, 652, 663, 677, 692`), but these are not declared in the placeholder base contract classes.
   - In-memory implementations provide these methods (`lines 880, 950, 1019, 1285, 1349, 1419, 1495`).

3. Add a guard test suite for contract shape drift.
   - Verify every declared contract method exists in each concrete implementation.
   - Fail CI when assertions and contract definitions diverge.

4. Decide whether non-memory concrete implementations should adopt these same contracts directly.
   - If yes: formalize shared interfaces and adapter conformance tests.
   - If no: isolate this file as in-memory-only and remove ambiguous generic contract naming.
