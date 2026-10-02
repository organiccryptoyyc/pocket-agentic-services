// TCS-6: Crypto Treasury Capital Score — a Pocket Network service.
//
// Two paid REST routes over a precomputed cache:
//   POST /v1/tcs6/score     {"entity_id": "aave"}  -> full TCS-6 report
//   POST /v1/tcs6/entities  {} | {"peer_cohort"}   -> registry listing
// plus GET /v1/version and /v1/health. The relay path never computes a
// score: pipeline/run.js does that on a schedule (12h) and this server only
// reads its validated output, so every relay answers in milliseconds.
//
// A second, private listener (lib/ingest.js) accepts evidence bundles from
// the Raspberry Pi collector. It binds its own port, is never the
// RelayMiner's backend_url, and is disabled unless TCS6_INGEST_TOKEN is set.
"use strict";

const { createServer, ClientError } = require("./lib/http");
const { insufficientReport, stampEntitlement } = require("./lib/report");
const { startIngest } = require("./lib/ingest");
const store = require("./lib/store");
const S = require("./lib/scoring");

const SERVICE = "treasury-capital-score";
const VERSION = "1.0.0";
const PORT = Number(process.env.PORT || 8080);

function findEntity(body) {
  const id = body && body.entity_id;
  if (typeof id !== "string" || !store.ENTITY_ID_RE.test(id.trim().toLowerCase())) {
    throw new ClientError(400, "invalid_input", "field 'entity_id' is required: a registry id such as \"aave\"; list ids with POST /v1/tcs6/entities");
  }
  const entity = store.loadRegistry().find((e) => e.entity_id === id.trim().toLowerCase());
  if (!entity) throw new ClientError(400, "unknown_entity", `'${id}' is not in the TCS-6 registry; list ids with POST /v1/tcs6/entities`);
  return entity;
}

async function handleScore(body) {
  const entity = findEntity(body);
  const now = new Date().toISOString();
  const cached = entity.scoreable ? store.readJsonCached(store.paths.report(entity.entity_id)) : null;
  if (!cached) {
    const reason = entity.scoreable ? "No validated report has been produced for this entity yet." : `Entity registry eligibility is '${entity.eligibility}'.`;
    return stampEntitlement(insufficientReport(entity, reason, now), now);
  }
  return stampEntitlement(cached, now);
}

async function handleEntities(body) {
  const cohort = body && typeof body.peer_cohort === "string" ? body.peer_cohort : null;
  const entities = store.loadRegistry()
    .filter((e) => !cohort || e.peer_cohort === cohort)
    .map((e) => {
      const r = e.scoreable ? store.readJsonCached(store.paths.report(e.entity_id)) : null;
      return {
        entity_id: e.entity_id,
        name: e.name,
        entity_type: e.entity_type,
        peer_cohort: e.peer_cohort,
        registry_status: e.registry_status,
        eligibility: e.eligibility,
        scoreable: !!e.scoreable,
        report: r ? { analysis_status: r.analysis_status, as_of: r.as_of, overall_score: r.overall_score.score, decision_band: r.overall_score.decision_band } : null,
      };
    });
  return {
    service: SERVICE,
    method_version: S.METHOD_VERSION,
    count: entities.length,
    entities,
    note: "Call POST /v1/tcs6/score with an entity_id for the full report. Only scoreable entities can carry a report; others are listed for transparency.",
  };
}

function health() {
  const st = store.readJson(store.paths.state());
  return {
    network: process.env.TCS6_NETWORK || "local",
    last_pipeline_run: st ? st.finished_at : null,
    reports_scored_last_run: st ? st.scored.length : 0,
    reports_failed_last_run: st ? st.failed.length : 0,
  };
}

if (require.main === module) {
  store.ensureDirs();
  const server = createServer({
    service: SERVICE,
    version: VERSION,
    versionPath: "/v1/version",
    healthPath: "/v1/health",
    health,
    routes: new Map([
      ["POST /v1/tcs6/score", handleScore],
      ["POST /v1/tcs6/entities", handleEntities],
    ]),
  });
  server.listen(PORT, () => console.log(JSON.stringify({ service: SERVICE, version: VERSION, port: PORT, data_dir: store.DATA_DIR })));
  startIngest();
}

module.exports = { handleScore, handleEntities, SERVICE, VERSION };
