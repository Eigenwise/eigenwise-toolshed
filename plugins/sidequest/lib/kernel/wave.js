"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var wave_exports = {};
__export(wave_exports, {
  assembleWave: () => assembleWave,
  dependentReleaseDecision: () => dependentReleaseDecision,
  openWave: () => openWave,
  recordAssembledWaveGate: () => recordAssembledWaveGate,
  recordWaveDelivery: () => recordWaveDelivery
});
module.exports = __toCommonJS(wave_exports);
var import_scope_match = require("../scope-match.js");
var import_verification = require("./verification.js");
function diagnostic(code, message) {
  return Object.freeze({ code, message, actionable: true });
}
function normalizedSurfaces(surfaces) {
  return Object.freeze(Array.from(new Set(
    surfaces.map((surface) => String(surface || "").trim().replace(/\\/g, "/").replace(/^\.\//, "")).filter(Boolean)
  )));
}
function sameRevision(left, right) {
  return left.source === right.source && left.value === right.value;
}
function sameBaseline(left, right) {
  return sameRevision(left.revision, right.revision);
}
function overlaps(left, right) {
  for (const leftSurface of left) {
    for (const rightSurface of right) {
      if ((0, import_scope_match.isInScope)(leftSurface, right) || (0, import_scope_match.isInScope)(rightSurface, left)) {
        return `${leftSurface} overlaps ${rightSurface}`;
      }
    }
  }
  return null;
}
function participantFor(wave, ref) {
  return wave.participants.find((participant) => participant.ref === ref) || null;
}
function invalidation(ref, reason, message) {
  return Object.freeze({ ref, state: "invalidated", reason, refreshRoute: "refresh_and_reverify", message });
}
function openWave(input) {
  const participantRefs = /* @__PURE__ */ new Set();
  const surfaces = [];
  for (const participant of input.participants) {
    const ref = String(participant.ref || "").trim();
    if (!ref || participantRefs.has(ref)) return diagnostic("invalid_wave_participant", "A wave requires unique non-empty participant refs.");
    participantRefs.add(ref);
    for (const dependency of participant.dependencies) {
      if (dependency === ref || !participantRefs.has(dependency) && !input.participants.some((candidate) => candidate.ref === dependency)) {
        return diagnostic("invalid_wave_dependency", `Wave participant ${ref} names an unavailable dependency ${dependency}.`);
      }
    }
    surfaces.push(...normalizedSurfaces(participant.declaredSurfaces));
  }
  if (!input.participants.length) return diagnostic("empty_wave", "A wave requires at least one participant.");
  return Object.freeze({
    baseline: Object.freeze({ revision: Object.freeze({ ...input.baseline.revision }), purpose: "wave" }),
    participants: Object.freeze(input.participants.map((participant) => Object.freeze({
      ref: String(participant.ref).trim(),
      dependencies: normalizedSurfaces(participant.dependencies),
      declaredSurfaces: normalizedSurfaces(participant.declaredSurfaces)
    }))),
    declaredSurfaces: normalizedSurfaces(surfaces)
  });
}
function assembleWave(wave, candidates) {
  const invalidated = [];
  const byRef = new Map(candidates.map((candidate) => [candidate.ref, candidate]));
  for (const participant of wave.participants) {
    const candidate = byRef.get(participant.ref);
    if (!candidate) {
      invalidated.push(invalidation(participant.ref, "participant_missing", `${participant.ref} is not ready for the opened wave.`));
      continue;
    }
    if (!sameBaseline(wave.baseline, candidate.baseline)) {
      invalidated.push(invalidation(candidate.ref, "baseline_moved", `${candidate.ref} was verified against ${candidate.baseline.revision.source}:${candidate.baseline.revision.value}, but this wave is pinned to ${wave.baseline.revision.source}:${wave.baseline.revision.value}.`));
      continue;
    }
    if (!(0, import_verification.verificationAccepted)(candidate.verification)) {
      invalidated.push(invalidation(candidate.ref, "verification_required", `${candidate.ref} has no accepted verifier evidence for the opened wave.`));
      continue;
    }
    if (candidate.surfaces.some((surface) => !(0, import_scope_match.isInScope)(surface, participant.declaredSurfaces))) {
      invalidated.push(invalidation(candidate.ref, "surface_overlap", `${candidate.ref} changed surfaces outside its wave-declared surfaces.`));
    }
  }
  const admitted = candidates.filter((candidate) => wave.participants.some((participant) => participant.ref === candidate.ref));
  for (let index = 0; index < admitted.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < admitted.length; otherIndex += 1) {
      const conflict = overlaps(admitted[index].surfaces, admitted[otherIndex].surfaces);
      if (!conflict) continue;
      invalidated.push(invalidation(admitted[index].ref, "surface_overlap", `Wave assembly refused ${conflict}.`));
      invalidated.push(invalidation(admitted[otherIndex].ref, "surface_overlap", `Wave assembly refused ${conflict}.`));
    }
  }
  if (invalidated.length) {
    const unique = new Map(invalidated.map((entry) => [entry.ref, entry]));
    return Object.freeze({ ok: false, invalidated: Object.freeze(Array.from(unique.values()).sort((left, right) => left.ref.localeCompare(right.ref))) });
  }
  return Object.freeze({
    ok: true,
    assembly: Object.freeze({ wave, candidates: Object.freeze(admitted), state: "assembled" })
  });
}
function recordAssembledWaveGate(assembly, verification) {
  return Object.freeze({
    assembly,
    verification,
    state: (0, import_verification.verificationAccepted)(verification) ? "gate_passed" : "gate_failed"
  });
}
function recordWaveDelivery(gate, revision, verification) {
  if (gate.state !== "gate_passed") {
    return diagnostic("assembled_wave_gate_required", "Delivery requires a passing assembled-wave gate. Refresh the wave and reverify its candidates after fixing the gate.");
  }
  return Object.freeze({
    gate,
    revision: Object.freeze({ ...revision }),
    verification,
    state: (0, import_verification.verificationAccepted)(verification) ? "delivered" : "delivery_failed"
  });
}
function dependentReleaseDecision(delivery, participant) {
  if (delivery.state !== "delivered") {
    return diagnostic("delivery_verification_required", `Dependent work for ${participant.ref} remains blocked until delivery verification passes.`);
  }
  return null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  assembleWave,
  dependentReleaseDecision,
  openWave,
  recordAssembledWaveGate,
  recordWaveDelivery
});
