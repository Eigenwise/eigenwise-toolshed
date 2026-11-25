export function formatAuditTable(report) {
  const lines = [`Rules in ${report.rulesDirectory}`, ""];
  if (report.rules.length === 0) lines.push("No rule files found.");
  else lines.push(...formatRuleRows(report.rules), "", ...formatFindings(report.rules));
  if (report.skippedCodebaseMapFiles > 0) lines.push("", formatSkippedCodebaseMap(report));
  lines.push("", formatTotals(report));
  return lines.join("\n");
}

function formatRuleRows(rules) {
  const fileWidth = Math.max(4, ...rules.map((rule) => rule.file.length));
  const header = `${"FILE".padEnd(fileWidth)}  ${"SCOPE".padEnd(10)}  ${"BYTES".padStart(6)}  FINDINGS`;
  const rows = rules.map(
    (rule) => `${rule.file.padEnd(fileWidth)}  ${rule.scope.padEnd(10)}  ${String(rule.bodyBytes).padStart(6)}  ${rule.findings.length}`,
  );
  return [header, ...rows];
}

function formatFindings(rules) {
  return rules.flatMap((rule) =>
    rule.findings.flatMap((finding) => [`${finding.severity.toUpperCase()} ${rule.file}: ${finding.message}`, `  fix: ${finding.fix}`]),
  );
}

function formatTotals(report) {
  const globNote = report.globCheck === "skipped" ? " Glob matching was skipped." : "";
  return (
    `Always loaded: ${report.alwaysLoadedRuleCount} rules, ${report.alwaysLoadedBytes} bytes. ` +
    `${report.errorCount} errors, ${report.warningCount} warnings.${globNote}`
  );
}

function formatSkippedCodebaseMap(report) {
  const indexNote = report.codebaseMapIndexBytes > 0 ? `; the index's ${report.codebaseMapIndexBytes} bytes are in the always-loaded total` : "";
  return `Skipped ${report.skippedCodebaseMapFiles} codebase map files (codebase-map.md and map/): this is the codebase map, checked by the map's own status check${indexNote}.`;
}
