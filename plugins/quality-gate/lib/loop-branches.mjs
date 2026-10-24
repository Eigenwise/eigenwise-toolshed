const UNVERIFIED = 'V8 block counts do not independently prove logical loop-test evaluations';

function logical(ast, node) {
  return ast.isBinaryExpression(node) && ['&&', '||', '??'].includes(node.operatorToken.getText());
}

function loopTest(ast, node) {
  if (ast.isForStatement(node)) return node.condition;
  if (ast.isWhileStatement(node) || ast.isDoStatement(node)) return node.expression;
  return undefined;
}

function findLoopTest(ast, node, path = []) {
  const parent = node.parent;
  if (!parent || ast.isFunctionLikeDeclaration(parent)) return null;
  const expression = loopTest(ast, parent);
  if (expression) return testOwner(expression, node, parent, path);
  return findLoopTest(ast, parent, [...path, node]);
}

function testOwner(expression, node, loop, path) {
  return expression === node ? { loop, path: [...path, node] } : null;
}

function negation(ast, node) {
  return ast.isPrefixUnaryExpression(node) && node.operator === ast.SyntaxKind.ExclamationToken;
}

function evaluationPath(ast, node) {
  return logical(ast, node) || ast.isParenthesizedExpression(node) || negation(ast, node);
}

function rightAncestor(ast, node, child) {
  return logical(ast, node) && node.right === child;
}

function continuationStatement(ast, loop) {
  if (!ast.isBlock(loop.parent)) return undefined;
  const next = loop.parent.statements[loop.parent.statements.indexOf(loop) + 1];
  return executableContinuation(ast, next) ? next : undefined;
}

function executableContinuation(ast, node) {
  const kinds = ['ReturnStatement', 'ThrowStatement', 'IfStatement', 'ExpressionStatement', 'VariableStatement'];
  return Boolean(node) && kinds.some((kind) => node.kind === ast.SyntaxKind[kind]);
}

function containsFlow(ast, node, predicate) {
  if (ast.isFunctionLikeDeclaration(node)) return false;
  return predicate(node) || Boolean(node.forEachChild((child) => containsFlow(ast, child, predicate) || undefined));
}

function unsafeFlow(ast, node) {
  return [ast.SyntaxKind.BreakStatement, ast.SyntaxKind.TryStatement].includes(node.kind) || (ast.isContinueStatement(node) && Boolean(node.label));
}

function insideTry(ast, node) {
  const parent = node.parent;
  if (!parent || ast.isFunctionLikeDeclaration(parent)) return false;
  return ast.isTryStatement(parent) || insideTry(ast, parent);
}

function exitBoundary(ast, node) {
  return ast.isFunctionLikeDeclaration(node) || [ast.SyntaxKind.ClassDeclaration, ast.SyntaxKind.ClassExpression].includes(node.kind);
}

function sourceSpan(node) {
  return { startOffset: node.getStart(), endOffset: node.end };
}

function exitStatement(ast, node) {
  return [ast.SyntaxKind.ReturnStatement, ast.SyntaxKind.ThrowStatement].includes(node.kind);
}

function bodyExits(ast, node, exits = []) {
  if (exitBoundary(ast, node)) return exits;
  if (exitStatement(ast, node)) exits.push(sourceSpan(node));
  node.forEachChild((child) => { bodyExits(ast, child, exits); });
  return exits;
}

function exclusiveBodyExit(ast, body) {
  const statements = ast.isBlock(body) ? body.statements : [body];
  if (statements.length !== 1) return undefined;
  const [statement] = statements;
  return exitStatement(ast, statement) ? { statement: sourceSpan(statement), body: sourceSpan(body) } : undefined;
}

function describeLoop(ast, { loop, path }) {
  const next = continuationStatement(ast, loop);
  const exits = bodyExits(ast, loop.statement);
  const unsupported = [ast.isDoStatement(loop), !next, !path.every((node) => evaluationPath(ast, node)),
    containsFlow(ast, loop.statement, (node) => unsafeFlow(ast, node)), insideTry(ast, loop),
    !loop.getSourceFile().fileName.endsWith('.js')].some(Boolean);
  const rightAncestors = path.flatMap((node, index) => rightAncestor(ast, node, path[index - 1]) ? [node.right.getStart()] : []).reverse();
  return { start: loop.getStart(), end: loop.end, body: loop.statement.getStart(), after: next?.getStart(), rightAncestors, unsupported,
    abrupt: exits.length > 0, exits, exclusiveExit: exclusiveBodyExit(ast, loop.statement) };
}

export function logicalLoopContext(ast, node) {
  const context = findLoopTest(ast, node);
  return context ? { logicalLoop: describeLoop(ast, context) } : {};
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validRange(range) {
  if (!range) return false;
  return [range.startOffset, range.endOffset, range.count].every(nonnegativeInteger) && range.startOffset < range.endOffset;
}

function within(range, root) {
  return root.startOffset <= range.startOffset && range.endOffset <= root.endOffset;
}

function sameSpan(left, right) {
  return left.startOffset === right.startOffset && left.endOffset === right.endOffset;
}

function crossing(left, right) {
  return left.startOffset < right.startOffset && right.startOffset < left.endOffset && left.endOffset < right.endOffset;
}

function ambiguousRanges(left, right) {
  return sameSpan(left, right) || crossing(left, right) || crossing(right, left);
}

function validNesting(ranges) {
  return ranges.every((left, index) => ranges.slice(index + 1).every((right) => !ambiguousRanges(left, right)));
}

function validRanges(ranges) {
  return Array.isArray(ranges) && validRangeList(ranges);
}

function validRangeList(ranges) {
  return ranges.length > 0 && ranges.every(validRange) && ranges.every((range) => within(range, ranges[0])) && validNesting(ranges);
}

function rangeAt(ranges, offset) {
  const enclosing = ranges.filter((range) => range.startOffset <= offset && offset < range.endOffset);
  enclosing.sort((left, right) => (left.endOffset - left.startOffset) - (right.endOffset - right.startOffset));
  return enclosing[0];
}

function naturalContinuation(context, entry, after) {
  if (after.startOffset >= context.end) return true;
  // An inherited range proves continuation only in the no-abrupt regime, and only
  // when it is the very same reached region as the loop statement, not function entry by fiat.
  return !context.abrupt && after === entry;
}

function entryAllowsBody(entry, body) {
  return entry.count !== 0 || body.count === 0;
}

function ownedExitRange(context, ranges, exit) {
  const exact = ranges.find((range) => sameSpan(range, exit));
  if (exact) return exact;
  if (!context.exclusiveExit) return undefined;
  if (!sameSpan(context.exclusiveExit.statement, exit)) return undefined;
  // The body contains only this exit, so its exact, exclusive block count also
  // proves entry into the exit. Never inherit an enclosing function/pre-loop count.
  return ranges.find((range) => sameSpan(range, context.exclusiveExit.body));
}

function ownedExitCount(context, ranges) {
  if (!Array.isArray(context.exits)) return undefined;
  const counts = context.exits.map((exit) => ownedExitRange(context, ranges, exit)?.count);
  if (!counts.every(nonnegativeInteger)) return undefined;
  const total = counts.reduce((sum, count) => sum + count, 0);
  return nonnegativeInteger(total) ? total : undefined;
}

function conservedEntries(context, ranges, entry, after) {
  if (after.count > entry.count) return false;
  const completed = after.count + ownedExitCount(context, ranges);
  return nonnegativeInteger(completed) && completed === entry.count;
}

function guardEvaluations(context, ranges) {
  const anchors = [context.start, context.body, context.after].map((offset) => rangeAt(ranges, offset));
  if (anchors.some((range) => !range)) return undefined;
  // A predicate/getter can throw without an AST ThrowStatement. Account for every
  // reached attempt before trusting nested RHS counts, which also include aborted attempts.
  if (!conservedEntries(context, ranges, anchors[0], anchors[2])) return undefined;
  return reachedGuardEvaluations(context, ...anchors);
}

function reachedGuardEvaluations(context, entry, body, after) {
  // A skipped suffix may use different zero ranges for the header and body.
  // Those explicit zero counters prove absence, not an inherited function invocation.
  if ([entry, body, after].every((range) => range.count === 0)) return 0;
  if (![naturalContinuation(context, entry, after), entryAllowsBody(entry, body)].every(Boolean)) return undefined;
  // Each body entry proves one true test. Only the independently proven natural
  // continuation contributes a false test; returns/throws do not add an exit.
  const evaluations = body.count + after.count;
  return nonnegativeInteger(evaluations) ? evaluations : undefined;
}

function boundedCount(evaluated, taken) {
  if (!nonnegativeInteger(evaluated)) return undefined;
  if (!nonnegativeInteger(taken)) return undefined;
  return taken <= evaluated ? taken : undefined;
}

function logicalEvaluations(context, ranges) {
  return context.rightAncestors.reduce((evaluated, offset) => boundedCount(evaluated, rangeAt(ranges, offset)?.count), guardEvaluations(context, ranges));
}

function outcomes(evaluated, taken) {
  const proven = boundedCount(evaluated, taken);
  if (proven === undefined) return { unverified: UNVERIFIED };
  return [proven > 0, evaluated - proven > 0];
}

export function logicalLoopOutcomes(condition, record) {
  const context = condition.logicalLoop;
  if (context.unsupported || record.directSource !== true) return { unverified: UNVERIFIED };
  if (!validRanges(record.ranges)) return { unverified: UNVERIFIED };
  return outcomes(logicalEvaluations(context, record.ranges), rangeAt(record.ranges, condition.taken)?.count);
}
