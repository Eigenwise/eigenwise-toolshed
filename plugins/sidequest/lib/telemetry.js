"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var telemetry_exports = {};
__export(telemetry_exports, {
  emitTicket: () => emitTicket,
  setTestSink: () => setTestSink,
  ticketObservation: () => ticketObservation
});
module.exports = __toCommonJS(telemetry_exports);
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_http = __toESM(require("node:http"));
const OBSERVER_URL = "http://127.0.0.1:14319/v1/observations";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const EFFORTS = /* @__PURE__ */ new Set(["low", "medium", "high", "xhigh", "max"]);
const TIMEOUT_MS = 250;
let testSink = null;
function isRecord(value) {
  return value !== null && typeof value === "object";
}
function identifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : null;
}
function effort(value) {
  return typeof value === "string" && EFFORTS.has(value) ? value : null;
}
function assign(target, key, value) {
  if (value !== null && value !== void 0) target[key] = value;
}
function stableId(value) {
  return `sidequest_${import_node_crypto.default.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
function categoryId(ticket) {
  if (ticket.category == null) return null;
  const category = ticket.category;
  const categoryValue = isRecord(category) ? category.id : category;
  return identifier(ticket.categoryId || categoryValue);
}
function configuredRoute(ticket) {
  const category = ticket.category;
  const route = isRecord(category) ? category.route : null;
  return isRecord(route) ? route : {};
}
function directLinks(ticket, dispatch) {
  const links = [];
  const add = (relation, toKind, toId) => {
    const id = identifier(toId);
    if (id) links.push({ relation, to_kind: toKind, to_id: id, method: "direct_id", quality: "exact" });
  };
  const claim = isRecord(ticket.claim) ? ticket.claim : {};
  add("routes_via", "route", dispatch.id || ticket.dispatchId);
  add("belongs_to", "task", dispatch.taskId || ticket.taskId);
  add("belongs_to", "session", dispatch.sessionId || claim.sessionId);
  add("attributed_to", "agent", dispatch.agentId);
  return links;
}
function projectIdentity(project) {
  const projectRecord = isRecord(project) ? project : {};
  const slug = identifier(typeof project === "string" ? project : projectRecord.slug);
  const projectPath = projectRecord.path;
  const projectId = typeof projectPath === "string" && projectPath.length > 0 ? import_node_crypto.default.createHash("sha256").update(projectPath).digest("hex") : null;
  return { slug, projectId };
}
function ticketObservation(project, ticketValue) {
  if (!isRecord(ticketValue)) return null;
  const ticket = ticketValue;
  const { slug: projectSlug, projectId } = projectIdentity(project);
  const ticketRef = identifier(ticket.ref);
  const observedAt = ticket.updatedAt || ticket.createdAt;
  if (!ticketRef || typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) return null;
  const dispatch = isRecord(ticket.dispatch) ? ticket.dispatch : {};
  const route = configuredRoute(ticket);
  const exec = isRecord(ticket.exec) ? ticket.exec : {};
  const claim = isRecord(ticket.claim) ? ticket.claim : {};
  const submission = isRecord(ticket.submission) ? ticket.submission : null;
  const attributes = {};
  assign(attributes, "category", categoryId(ticket));
  assign(attributes, "configured_model", identifier(route.model));
  assign(attributes, "configured_effort", effort(route.effort));
  assign(attributes, "configured_backend", identifier(route.backend || exec.backend));
  assign(attributes, "resolved_model", identifier(ticket.model || exec.runsModel));
  assign(attributes, "resolved_effort", effort(ticket.effort));
  assign(attributes, "resolved_backend", identifier(exec.backend));
  assign(attributes, "executor", identifier(dispatch.executor || ticket.dispatchExecutor || exec.agent));
  assign(attributes, "dispatch_id", identifier(dispatch.id || ticket.dispatchId));
  assign(attributes, "claim_worker_id", identifier(claim.by));
  assign(attributes, "claim_session_id", identifier(dispatch.sessionId || claim.sessionId));
  assign(attributes, "task_status", identifier(submission && !submission.integratedAt ? "submitted" : ticket.status));
  const taskId = identifier(dispatch.taskId || ticket.taskId);
  const routeId = identifier(dispatch.id || ticket.dispatchId);
  const sessionId = identifier(dispatch.sessionId || claim.sessionId);
  const agentId = identifier(dispatch.agentId);
  const eventKey = {
    projectSlug: identifier(projectSlug),
    ticketRef,
    observedAt: new Date(observedAt).toISOString(),
    status: attributes.task_status || null,
    dispatchId: routeId,
    taskId,
    agentId,
    claimWorker: attributes.claim_worker_id || null
  };
  const observation = {
    source: "sidequest",
    source_event_id: stableId(eventKey),
    source_schema: "native-v1",
    observed_at: eventKey.observedAt,
    event_name: "sidequest.ticket",
    ticket_ref: ticketRef,
    attributes
  };
  assign(observation, "project_id", projectId);
  assign(observation, "task_id", taskId);
  assign(observation, "route_id", routeId);
  assign(observation, "session_id", sessionId);
  assign(observation, "agent_id", agentId);
  const links = directLinks(ticket, dispatch);
  if (links.length) observation.links = links;
  return observation;
}
function send(observation) {
  if (testSink) {
    try {
      testSink(observation);
    } catch {
      return;
    }
    return;
  }
  const body = JSON.stringify([observation]);
  const request = import_node_http.default.request(OBSERVER_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    timeout: TIMEOUT_MS
  }, (response) => response.resume());
  request.on("timeout", () => request.destroy());
  request.on("error", () => {
  });
  request.end(body);
}
function emitTicket(project, ticket) {
  const observation = ticketObservation(project, ticket);
  if (observation) send(observation);
}
function setTestSink(sink) {
  testSink = typeof sink === "function" ? sink : null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  emitTicket,
  setTestSink,
  ticketObservation
});
