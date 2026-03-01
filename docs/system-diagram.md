# UMS Architektonicky Diagram (as-is)

Cil: dat Jirkovi prehled struktury systemu, hranic zodpovednosti a mist, kde dava smysl navrhnout refaktor.

## 1) System Context (C4 L1)

```mermaid
flowchart TB
  A1["AI agenty a chat klienti (Codex, Claude)"]
  A2["JIRA/Ferndesk exporty"]
  A3["Operator a QA tooling"]

  subgraph UMS["UMS Memory System"]
    B1["Rozhrani CLI/API"]
    B2["Pametovy backend"]
    B3["Lokalni perzistence snapshotu"]
  end

  A1 --> B1
  A2 --> B1
  A3 --> B1
  B1 --> B2
  B2 --> B3
  B3 --> B2
```

## 2) Container Diagram (C4 L2, aktualni repo)

```mermaid
flowchart LR
  C1["Klienti (CLI call, HTTP call)"]
  C2["UMS wrapper apps/ums/src/index.mjs"]
  C3["CLI adapter apps/cli/src/index.mjs"]
  C4["API adapter apps/api/src/server.mjs"]
  C5["Shared-state facade apps/api/src/persistence.mjs"]
  C6["Operation engine apps/api/src/core.mjs"]
  C7["In-memory state stores -> profiles -> state buckets"]
  C8["State snapshot file .ums-state.json"]
  C9["Write lock file .ums-state.json.lock"]

  C1 --> C2
  C1 --> C3
  C1 --> C4

  C2 -->|operation mode| C3
  C2 -->|serve mode| C4

  C3 --> C5
  C4 --> C5
  C5 --> C6
  C6 --> C7
  C5 <-->|hydrate and export| C8
  C5 <-->|exclusive write lock| C9
```

## 3) Backend Component Diagram (C4 L3, core.mjs)

```mermaid
flowchart TB
  D1["Request normalization and validation"]
  D2["Operation dispatcher"]

  D3["Memory lifecycle ops: ingest, context, reflect, validate, curate"]
  D4["Learner and identity ops: learner_profile_update, identity_graph_update"]
  D5["Misconception and curriculum ops: misconception_update, pain/failure signals, curriculum ops"]
  D6["Review scheduling ops: review_schedule_update, review_schedule_clock, review_set_rebalance"]
  D7["Policy and safety ops: curate_guarded, recall_authorization, policy_decision_update, tutor_degraded, policy_audit_export"]
  D8["Diagnostics ops: feedback, outcome, audit, export, doctor"]

  D9["State management: getStoreProfiles, getProfileState, snapshot import/export"]

  D1 --> D2
  D2 --> D3
  D2 --> D4
  D2 --> D5
  D2 --> D6
  D2 --> D7
  D2 --> D8

  D3 --> D9
  D4 --> D9
  D5 --> D9
  D6 --> D9
  D7 --> D9
  D8 --> D9
```

## 4) Ingestion cesty: manualne vs automaticky

```mermaid
flowchart LR
  S1["Codex transcript files"]
  S2["Claude transcript files"]
  S3["Direct JSON payloads"]
  M1["Manual bulk command: npm run ingest:coding-history"]
  M2["Manual direct ingest: CLI or POST /v1/ingest"]
  A1["External scheduler: cron, launchd, systemd, CI"]
  I1["ingest operation in core.mjs"]
  P1["Shared-state persistence"]
  F1[".ums-state.json"]

  S1 --> M1
  S2 --> M1
  S3 --> M2
  A1 --> M1
  M1 --> I1
  M2 --> I1
  I1 --> P1
  P1 --> F1
```

### Manualni ingest

1. Bulk import lokalni historie agentu:
```bash
npm run ingest:coding-history
```

2. Varianta s explicitnim store/profile/state:
```bash
npm run ingest:coding-history -- --store-id coding-agent --profile agent-history --state-file .ums-state.json
```

3. Primy ingest jedne udalosti pres CLI:
```bash
npm run cli -- ingest --store-id coding-agent --input '{"profile":"agent-history","events":[{"type":"note","source":"codex-cli","content":"example insight"}]}'
```

4. Primy ingest pres HTTP API:
```bash
curl -sS -X POST http://127.0.0.1:8787/v1/ingest \
  -H 'content-type: application/json' \
  -d '{"storeId":"coding-agent","profile":"agent-history","events":[{"type":"note","source":"claude-code","content":"example memory"}]}'
```

### Automaticky ingest (aktualni stav)

1. V repu neni vestaveny daemon, periodic worker ani filesystem trigger pro ingest.
2. Automatizace je aktualne "external orchestration": scheduler spousti stejny prikaz `npm run ingest:coding-history`.
3. Prakticky priklad (cron kazdych 30 minut):
```bash
*/30 * * * * cd /Users/satan/Developer/ums-memory && npm run ingest:coding-history -- --store-id coding-agent --profile agent-history >> /tmp/ums-ingest.log 2>&1
```
4. Ingest je navrzen replay-safe a deduplikuje duplicity; periodicke spousteni nevede k nekontrolovanemu rustu stejnych zaznamu.

## Co je dobre pro architekt review s Jirkou

1. `core.mjs` je aktualne monolit (dispatcher + domena + serializace stavu). Kandidat na rozdeleni do service modulu po domenach.
2. `persistence.mjs` resi lock i I/O, ale zatim pouze file snapshot. Otazka: jestli zavest repository vrstvu s vice backendy.
3. API i CLI jsou tenke adaptery nad stejnym enginem, to je plus. Otazka: kde oddelit stabilni kontrakt od interniho modelu.
4. Existuje paralelni engine `apps/api/src/ums/engine.mjs` (hlavne test/benchmark cesta). Otazka: sloucit, nebo drzet vedle sebe vedome.
5. Ingest orchestrace je mimo aplikaci (scheduler outside). Otazka: zustat u external scheduleru, nebo pridat interni ingest worker service.
