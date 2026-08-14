"use strict";
function createProjectBoardWatch(project, environment = process.env, dependencies) {
  const { store, createBoardWatch, createGitHubCiRunsProvider } = dependencies || {
    store: require("../store"),
    ...require("./pulse")
  };
  const watchingSession = environment.CLAUDE_CODE_SESSION_ID || environment.CLAUDE_SESSION_ID || "";
  const watchingActor = environment.SIDEQUEST_AGENT || watchingSession;
  return createBoardWatch({
    board: project.slug,
    changesPayload: (board, since) => {
      if (board !== project.slug) throw new Error("watch attempted to read a board other than its registered identity.");
      return { project: project.slug, ...store.changesPayload(project.slug, since) };
    },
    ciRunsProvider: createGitHubCiRunsProvider(project.meta?.path),
    watchingAuthor: watchingActor,
    watchingSession,
    watchingOrigin: { sessionId: watchingSession, actor: watchingActor, operation: "comment" }
  });
}
module.exports = { createProjectBoardWatch };
