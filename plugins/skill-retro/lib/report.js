'use strict';

const KIND_LABELS = {
  'hazard-private-data': 'HAZARD',
  'hazard-untracked': 'HAZARD',
  'rewritten-script': 'rewritten script',
  'repeated-command': 'repeated command',
  'fail-then-fix': 'fail then fix',
  'ephemeral-artifact': 'ephemeral artifact',
  'rediscovery-tax': 'rediscovery tax',
  'user-correction': 'correction',
  'permission-denial': 'permission denial',
};

function indent(text, prefix = '  ') {
  return String(text ?? '')
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function actorSummary(finding) {
  const actors = finding.actors ?? [];
  if (!actors.length) return 'unattributed';
  const shown = actors.slice(0, 4).map((actor) => `${actor.label} x${actor.count ?? 1}`).join(', ');
  return actors.length > 4 ? `${shown}, +${actors.length - 4} more` : shown;
}

function formatFinding(finding) {
  const lines = [];
  lines.push(`### ${finding.id} [${KIND_LABELS[finding.kind] ?? finding.kind}] ${finding.title}`);
  lines.push('');
  lines.push(`- **Route:** ${finding.routeLabel} — ${finding.routeWhy}`);
  if (finding.routeAlternatives?.length) lines.push(`- **Or:** ${finding.routeAlternatives.join('; ')}`);
  lines.push(`- **Who:** ${actorSummary(finding)}`);
  lines.push(`- **Spread:** ${finding.occurrences} occurrence(s) across ${finding.sessions} session(s), severity ${finding.severity}, score ${finding.score}`);
  if (finding.arguments?.length) {
    const args = finding.arguments
      .map((argument) => `arg ${argument.position} (${argument.token}, ${argument.distinct} distinct): ${argument.values.slice(0, 3).join(' | ')}`)
      .join('\n');
    lines.push('- **Would become CLI arguments:**');
    lines.push(indent(args, '    '));
  }
  if (finding.variants?.length) {
    lines.push('- **Merged variants of the same chore:**');
    lines.push(indent(finding.variants.map((variant) => `${variant.count}x  ${variant.shape}`).join('\n'), '    '));
  }
  if (finding.salvageId) {
    lines.push(`- **Salvage:** \`salvage/${finding.salvageId}-${finding.basename}\` (${finding.salvageBytes} bytes${finding.salvageTruncated ? ', truncated' : ''}${finding.proven ? ', output recorded' : ', unproven'})`);
  }
  if (finding.hotFiles?.length) {
    lines.push(`- **Re-read across transcripts:** ${finding.hotFiles.slice(0, 6).map((file) => `${file.basename} (${file.transcripts})`).join(', ')}`);
  }
  if (finding.paths?.length) {
    lines.push('- **Paths:**');
    lines.push(indent(finding.paths.slice(0, 12).join('\n'), '    '));
  }
  lines.push('');
  for (const item of finding.evidence ?? []) {
    lines.push(`  *${item.label}*`);
    lines.push('');
    lines.push('  ```');
    lines.push(indent(item.text, '  '));
    lines.push('  ```');
    lines.push('');
  }
  return lines.join('\n');
}

function formatReport(result) {
  const lines = [];
  lines.push('# Skill retro');
  lines.push('');
  lines.push(result.window.description);
  lines.push('');
  lines.push(
    `Streamed ${result.totals.transcripts} transcripts, ${result.totals.records.toLocaleString('en-US')} records, `
    + `~${Math.round(result.totals.tokens / 1000).toLocaleString('en-US')}k fresh tokens `
    + `(plus ~${Math.round((result.totals.cacheReadTokens ?? 0) / 1e6).toLocaleString('en-US')}M cache reads, which are re-reads of the same context, not work). `
    + 'None of it was loaded into this context.',
  );
  lines.push('');

  if (result.notes.hazards?.warning) {
    lines.push(`> ${result.notes.hazards.warning}`);
    lines.push('');
  }
  if (result.failures.length) {
    lines.push(`> ${result.failures.length} transcript(s) could not be read: ${result.failures.map((failure) => failure.message).join('; ')}`);
    lines.push('');
  }

  if (!result.findings.length) {
    lines.push('## No findings');
    lines.push('');
    lines.push('Nothing in this window recurred enough to be worth a durable fix. That is a real result, not an empty one.');
    lines.push('');
  } else {
    const hazards = result.findings.filter((finding) => String(finding.kind).startsWith('hazard'));
    const rest = result.findings.filter((finding) => !String(finding.kind).startsWith('hazard'));

    if (hazards.length) {
      lines.push('## Hazards, reported first regardless of frequency');
      lines.push('');
      hazards.forEach((finding) => lines.push(formatFinding(finding)));
    }

    lines.push('## Ranked findings');
    lines.push('');
    lines.push('| # | Finding | Route | Who | Spread |');
    lines.push('|---|---------|-------|-----|--------|');
    for (const finding of rest) {
      lines.push(`| ${finding.id} | ${finding.title.replace(/\|/g, '\\|')} | ${finding.routeLabel} | ${finding.audience.primary} | ${finding.occurrences}x / ${finding.sessions} sessions |`);
    }
    lines.push('');
    rest.forEach((finding) => lines.push(formatFinding(finding)));
  }

  if (result.dropped.length) {
    lines.push('## Dropped as one-offs');
    lines.push('');
    lines.push(`${result.dropped.length} candidate(s) scored below the floor and were dropped rather than padded into the report:`);
    lines.push('');
    for (const item of result.dropped.slice(0, 15)) lines.push(`- ${item.title} (${item.kind}, score ${item.score})`);
    lines.push('');
  }

  const notes = [];
  if (result.notes.commands) {
    const commands = result.notes.commands;
    notes.push(`${commands.distinctShapes} distinct command shapes merged into ${commands.mergedGroups} chores that ran 3+ times, ${commands.reportedShapes} reported.`);
    if (commands.candidateFixes) notes.push(`${commands.candidateFixes} failure/retry pairs seen, ${commands.reportedFixes} survived the similarity and recurrence checks.`);
    if (commands.trivialInvocations) notes.push(`${commands.trivialInvocations} navigation-only invocations (ls, cd, git status) were not clustered.`);
    if (commands.droppedShapes) notes.push(`${commands.droppedShapes} shapes exceeded the shape cap and were not counted.`);
  }
  if (result.notes.hazards?.untrackedNote) notes.push(result.notes.hazards.untrackedNote);
  if (result.notes.writes?.droppedFiles) notes.push(`${result.notes.writes.droppedFiles} written paths exceeded the tracking cap.`);
  if (result.notes.hazards?.droppedPaths) notes.push(`${result.notes.hazards.droppedPaths} paths exceeded the hazard tracking cap.`);
  if (result.window.skippedSessions) notes.push(`${result.window.skippedSessions} older sessions inside the ${result.window.days}-day range were not scanned because of the ${result.window.sessionLimit}-session cap.`);

  if (notes.length) {
    lines.push('## Coverage');
    lines.push('');
    for (const note of notes) lines.push(`- ${note}`);
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

module.exports = { formatReport };
