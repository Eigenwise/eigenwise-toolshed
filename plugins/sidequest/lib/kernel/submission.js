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
var submission_exports = {};
__export(submission_exports, {
  validateSubmissionAdmission: () => validateSubmissionAdmission
});
module.exports = __toCommonJS(submission_exports);
function validateSubmissionAdmission(ports, input) {
  const ownership = ports.ownershipFailure(input.ticket, input.by, input.force === true);
  if (ownership) return ownership;
  const failures = [];
  const completion = ports.completionCheck(input.slug, input.ticket, String(input.base || "").trim() === input.commit);
  if (!completion.ok) failures.push({ reason: completion.reason, message: completion.message });
  for (const message of ports.verifyErrors(input.ticket, input.verify)) failures.push({ reason: "invalid_verify", message });
  const declared = ports.declaredVerify(input.ticket);
  if (declared && input.verify !== declared) failures.push({ reason: "executor_verify_mismatch", message: `submit: refused ${input.ticket.ref}; verification must match the declared executor verify command.` });
  return failures;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  validateSubmissionAdmission
});
