"use strict";
function createProjectBoardWatch(project, environment = process.env, dependencies) {
  const pulse = require("./pulse");
  const {
    store = require("../store"),
    createBoardWatch = pulse.createBoardWatch,
    createGitHubCiRunsProvider = pulse.createGitHubCiRunsProvider,
    includeAllTickets = false
  } = dependencies || {};
  const watchingSession = environment.CLAUDE_CODE_SESSION_ID || environment.CLAUDE_SESSION_ID || "";
  const watchingActor = environment.SIDEQUEST_AGENT || watchingSession;
  return createBoardWatch({
    board: project.slug,
    changesPayload: (board, since) => {
      if (board !== project.slug) throw new Error("watch attempted to read a board other than its registered identity.");
      return { project: project.slug, ...store.changesPayload(project.slug, since, { includeDispatchOwner: true }) };
    },
    ciRunsProvider: createGitHubCiRunsProvider(project.meta?.path),
    includeAllTickets,
    watchingAuthor: watchingActor,
    watchingSession,
    watchingOrigin: { sessionId: watchingSession, actor: watchingActor, operation: "comment" }
  });
}
module.exports = { createProjectBoardWatch };
