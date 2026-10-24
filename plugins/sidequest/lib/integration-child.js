"use strict";
var import_integration_tests = require("./integration-tests.js");
const { integrateInProcess } = require("./mcp-lifecycle.js");
function sendToServer(type, value) {
  return new Promise((resolve) => {
    if (!process.send || !process.connected) return resolve();
    try {
      process.send({ type, value }, void 0, {}, () => resolve());
    } catch {
      resolve();
    }
  });
}
function requestedArguments(message) {
  return typeof message === "object" && message !== null && "args" in message ? message.args : {};
}
async function deliver(message) {
  (0, import_integration_tests.onIntegrationProgress)((progress) => {
    void sendToServer("progress", (0, import_integration_tests.integrationProgressSummary)(progress));
  });
  try {
    await sendToServer("result", await integrateInProcess(requestedArguments(message)));
  } catch (error) {
    await sendToServer("error", error instanceof Error ? error.message : String(error));
  }
  process.exit(0);
}
process.once("message", (message) => {
  void deliver(message);
});
