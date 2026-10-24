import { spawnSync } from 'node:child_process';
import { logicalLoopContext, logicalLoopOutcomes } from './loop-branches.mjs';

export function conditionalDescriptors(ast, functionNode, forEachOwnNode) {
  const conditions = [];
  forEachOwnNode(functionNode, (node) => {
    const descriptors = ast.isSwitchStatement(node) ? switchConditions(ast, node) : [conditionalNode(ast, node)];
    conditions.push(...descriptors.filter(Boolean).map((condition) => describeCondition(node, condition)));
  }, () => {});
  return conditions;
}

function describeCondition(node, condition) {
  const source = node.getSourceFile();
  return { ...condition, line: source.getLineAndCharacterOfPosition(condition.start).line + 1, endLine: source.getLineAndCharacterOfPosition(condition.end - 1).line + 1, text: source.text.slice(condition.start, condition.end) };
}

function binaryCondition(ast, node) {
  if (!ast.isBinaryExpression(node)) return null;
  const operator = node.operatorToken.getText();
  if (!['&&', '||', '??'].includes(operator)) return null;
  return { start: node.left.getStart(), end: node.end, evaluation: node.left.getStart(), taken: node.right.getStart(), sides: ['right', 'short-circuit'], ...logicalLoopContext(ast, node) };
}

function conditionalNode(ast, node) {
  if (ast.isIfStatement(node)) return { start: node.expression.getStart(), end: node.expression.end, evaluation: node.expression.getStart(), taken: node.thenStatement.getStart(), other: node.elseStatement?.getStart(), sides: ['then', 'else'] };
  if (ast.isConditionalExpression(node)) return { start: node.condition.getStart(), end: node.condition.end, evaluation: node.condition.getStart(), taken: node.whenTrue.getStart(), other: node.whenFalse.getStart(), sides: ['then', 'else'] };
  return binaryCondition(ast, node) ?? loopCondition(ast, node);
}

function loopCondition(ast, node) {
  const kinds = [ast.SyntaxKind.WhileStatement, ast.SyntaxKind.DoStatement, ast.SyntaxKind.ForStatement, ast.SyntaxKind.ForInStatement, ast.SyntaxKind.ForOfStatement];
  if (!kinds.includes(node.kind)) return null;
  const expression = node.condition ?? node.expression;
  if (!expression) return null;
  return { start: expression.getStart(), end: expression.end, evaluation: node.getStart(), taken: node.statement.getStart(), after: node.end, loop: node.kind === ast.SyntaxKind.DoStatement ? 'do' : 'while', sides: loopSides(ast, node), unverified: ambiguousLoop(ast, node) };
}

function loopSides(ast, node) {
  return node.kind === ast.SyntaxKind.DoStatement ? ['repeat', 'exit'] : ['body', 'exit'];
}

function ambiguousLoop(ast, node) {
  return hasAbruptExit(ast, node.statement) ? 'V8 block counts do not identify loop-condition outcomes independently of break, return or throw' : undefined;
}

function hasAbruptExit(ast, node) {
  if (ast.isFunctionLikeDeclaration(node)) return false;
  const abrupt = [ast.SyntaxKind.BreakStatement, ast.SyntaxKind.ReturnStatement, ast.SyntaxKind.ThrowStatement];
  return abrupt.includes(node.kind) || Boolean(node.forEachChild((child) => hasAbruptExit(ast, child) || undefined));
}

function switchConditions(ast, node) {
  const clauses = node.caseBlock.clauses;
  const selectionLine = node.getSourceFile().getLineAndCharacterOfPosition(node.expression.getStart()).line + 1;
  return clauses.map((clause) => {
    const expression = ast.isCaseClause(clause) ? clause.expression : null;
    return { start: clause.getStart(), end: expression?.end ?? clause.getStart() + 7, selectionLine, arms: [{ offset: clause.getStart(), name: expression ? `case ${expression.getText()}` : 'default' }] };
  });
}

export function changedLineRanges(projectRoot, base, relativePath, external = false) {
  if (external) return [[1, Infinity]];
  const result = spawnSync('git', ['diff', '--no-ext-diff', '--unified=0', base, '--', relativePath], { cwd: projectRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim());
  if (!result.stdout) return untrackedLines(projectRoot, relativePath);
  return [...result.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].map((match) => [Number(match[1]), Number(match[1]) + Number(match[2] ?? 1) - 1]);
}

function untrackedLines(projectRoot, relativePath) {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', relativePath], { cwd: projectRoot, encoding: 'utf8' });
  return result.status === 0 ? [] : [[1, Infinity]];
}

export function inChangedLines(condition, ranges) {
  return ranges.some(([start, end]) => overlapsCondition(condition, start, end));
}

function overlapsCondition(condition, start, end) {
  return (condition.line <= end && condition.endLine >= start) || (condition.selectionLine >= start && condition.selectionLine <= end);
}

function countAt(ranges, offset) {
  const enclosing = ranges.filter((range) => range.startOffset <= offset && offset < range.endOffset);
  enclosing.sort((left, right) => (left.endOffset - left.startOffset) - (right.endOffset - right.startOffset));
  return enclosing[0]?.count ?? 0;
}

function sidesExecuted(condition, ranges) {
  if (condition.arms) return condition.arms.map((arm) => countAt(ranges, arm.offset) > 0);
  if (condition.loop) return loopOutcomes(condition, ranges);
  const evaluated = countAt(ranges, condition.evaluation);
  const taken = countAt(ranges, condition.taken);
  const other = condition.other === undefined ? evaluated - taken : countAt(ranges, condition.other);
  return [taken > 0, other > 0];
}

function loopOutcomes(condition, ranges) {
  const initial = condition.loop === 'do' ? countAt(ranges, condition.evaluation) : 0;
  return [countAt(ranges, condition.taken) > initial, countAt(ranges, condition.after) > 0];
}

function executionResult(condition, record) {
  return condition.logicalLoop ? logicalLoopOutcomes(condition, record) : sidesExecuted(condition, record.ranges);
}

export function conditionResult(condition, records, unverified) {
  const row = { line: condition.line, text: condition.text, untaken: [] };
  const reason = unverified ?? condition.unverified;
  if (reason) return { ...row, unverified: reason };
  return measuredConditionResult(condition, records, row);
}

function measuredConditionResult(condition, records, row) {
  const sides = condition.sides ?? condition.arms.map((arm) => arm.name);
  const executions = records.map((record) => executionResult(condition, record));
  const incomplete = executions.find((execution) => execution.unverified);
  if (incomplete) return { ...row, unverified: incomplete.unverified };
  row.untaken = sides.filter((side, index) => !executions.some((counts) => counts[index]));
  return row.untaken.length ? row : null;
}
