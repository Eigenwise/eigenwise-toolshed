"use strict";
const {
  store,
  resolveProject,
  sessionOf,
  requireBy,
  PROJECT_PROP,
  mutationAck,
  requiredFinalReport
} = require("./mcp-shared");
const tools = [
  {
    name: "done",
    description: "Finish claimed non-repo or active artifact work; repo work submits, released work uses control-plane grooming. body carries the final report. Stamp actual model and effort.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        by: { type: "string" },
        model: { type: "string", description: "Concrete runtime model that actually worked this ticket (provenance)." },
        effort: { type: "string", enum: store.VALID_EFFORTS },
        body: { type: "string", description: "Final report stored as the completion comment." },
        session: { type: "string" }
      },
      required: ["ref", "by", "body"]
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const by = requireBy(args, "done");
      const body = requiredFinalReport(args, "done");
      const opts = { source: "mcp", model: args.model, effort: args.effort, body, sessionId: sessionOf(args) };
      return mutationAck(slug, store.completeTicket(slug, args.ref, by, opts));
    }
  },
  {
    name: "groomClose",
    description: "Close a ticket through grooming with an evidence reason, for work that is stale, obsolete, or already handled elsewhere. Use done for work you actually finished.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        by: { type: "string" },
        reason: { type: "string" }
      },
      required: ["ref", "by", "reason"]
    },
    handler(args) {
      const { slug } = resolveProject(args.project);
      const by = requireBy(args, "groomClose");
      const reason = String(args.reason || "").trim();
      if (!reason) throw new Error("groomClose: reason is required.");
      return mutationAck(slug, store.closeTicketForGrooming(slug, args.ref, { by, reason, source: "mcp" }));
    }
  }
];
module.exports = { tools };
