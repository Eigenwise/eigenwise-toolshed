import ast
import copy
import hashlib
import json
import pathlib
import sys
from types import CodeType
from itertools import accumulate

VERSION, NATIVE_ORACLE_POLICY = json.loads(pathlib.Path(__file__).with_name("policies.json").read_text())
BODIES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)
UNIT_DECISIONS = (ast.If, ast.IfExp, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler)
SETUP_NAMES = {"setUp", "tearDown", "setUpClass", "tearDownClass", "setup", "teardown", "setup_method", "teardown_method", "setup_class", "teardown_class", "setup_module", "teardown_module", "setup_function", "teardown_function"}


def qualified_reference(node, imports):
    if isinstance(node, ast.Call):
        return qualified_reference(node.func, imports)
    if isinstance(node, ast.Attribute):
        return qualified_reference(node.value, imports) + "." + node.attr
    return imports.get(getattr(node, "id", ""), getattr(node, "id", ""))


def imported_names(tree):
    imports = {}
    for node in tree.body:
        imports.update(import_bindings(node))
    return imports


def import_bindings(node):
    if isinstance(node, ast.Import):
        return dict(import_alias(alias, "") for alias in node.names)
    if isinstance(node, ast.ImportFrom):
        return dict(import_alias(alias, str(node.module) + ".") for alias in node.names)
    return {}


def import_alias(alias, module):
    return alias.asname or alias.name, module + alias.name


def class_is_oracle(node, imports):
    return any(qualified_reference(base, imports) == "unittest.TestCase" for base in node.bases)


def fixture_reason(node, filename, imports):
    if pathlib.PurePosixPath(filename).name == "conftest.py":
        return "conftest body"
    decorators = getattr(node, "decorator_list", [])
    if any(qualified_reference(decorator, imports) == "pytest.fixture" for decorator in decorators):
        return "pytest fixture decorator"
    return ""


def oracle_role(node, filename, owner, imports, policy):
    fixture = fixture_reason(node, filename, imports)
    if fixture:
        return "fixture-setup", fixture
    name = getattr(node, "name", "")
    basename = pathlib.PurePosixPath(filename).name
    test_file = basename.startswith("test_") or basename.endswith("_test.py")
    if name in SETUP_NAMES and any([test_file, owner[1]]):
        return "fixture-setup", "test setup/teardown name"
    return ORACLE_QUALIFICATIONS[policy](name, test_file, owner)


def qualified_oracle(name, test_file, owner):
    if owner[1]:
        return "oracle", "method of source-resolved unittest.TestCase subclass"
    if not test_file:
        return "production", "no source-qualified oracle or fixture/setup marker"
    if owner[0].startswith("Test"):
        return "oracle", "Test* class method in a test module"
    if name.startswith("test_"):
        return "oracle", "test_* function in test_*.py or *_test.py"
    return "production", "no source-qualified oracle or fixture/setup marker"


def explicitly_named_oracle(name, test_file, owner):
    if not name.startswith("test_"):
        return "production", "no explicit test_* oracle name"
    if owner[1]:
        return "oracle", "test_* method of source-resolved unittest.TestCase subclass"
    if test_file:
        return "oracle", "test_* definition in test_*.py or *_test.py"
    return "production", "test_* name outside a qualified test module or TestCase"


ORACLE_QUALIFICATIONS = {VERSION: qualified_oracle, NATIVE_ORACLE_POLICY: explicitly_named_oracle}


def validate_oracles(oracles, policy):
    if oracles is None:
        return
    if policy == VERSION:
        raise ValueError("Explicit oracles require the native Python policy")
    if not isinstance(oracles, list):
        raise ValueError("oracles must be an array of exact file/name/reason selectors")
    for entry in oracles:
        validate_oracle_selector(entry)


def validate_oracle_selector(entry):
    if not isinstance(entry, dict):
        raise ValueError("Oracle selectors must contain exactly file, name and reason")
    valid = [set(entry) == {"file", "name", "reason"},
             all(isinstance(value, str) and value.strip() for value in entry.values())]
    if not all(valid):
        raise ValueError("Oracle file, name and reason must be nonempty strings")
    validate_oracle_identity(entry["file"], entry["name"])


def validate_oracle_identity(filename, name):
    valid = [filename.endswith(".py"), all(part not in ("", ".", "..") for part in filename.split("/")),
             not any(character in filename for character in "\\:*?[]{}"),
             not any(character in name for character in "*?[]{}"), name.strip() == name]
    if not all(valid):
        raise ValueError("Oracle identity must be an exact relative POSIX .py file and qualified body name without patterns")


def selected_oracle_role(role, reason, selector):
    if role == "fixture-setup":
        return role, reason
    if selector is not None:
        return "oracle", "explicit file/name selector: " + selector["reason"]
    return "production", "not in explicit oracle allowlist"


class OwnedBody(ast.NodeTransformer):
    def __init__(self, boundaries):
        self.boundaries = boundaries

    def visit(self, node):
        if isinstance(node, self.boundaries):
            return ast.copy_location(ast.Name(id=getattr(node, "name", "<lambda>"), ctx=ast.Load()), node)
        return super().visit(node)


def owned_nodes(node, policy):
    boundaries = BODIES + (ast.ClassDef,) if policy == NATIVE_ORACLE_POLICY else BODIES
    body = node.body if isinstance(node.body, list) else [node.body]
    return [OwnedBody(boundaries).visit(copy.deepcopy(statement)) for statement in body]


def decision_count(node):
    if isinstance(node, UNIT_DECISIONS):
        return 1
    if isinstance(node, ast.BoolOp):
        return len(node.values) - 1
    if isinstance(node, ast.comprehension):
        return 1 + len(node.ifs)
    if isinstance(node, ast.match_case):
        return int(not wildcard_pattern(node.pattern)) + int(node.guard is not None)
    return 0


class NativeDecisions(ast.NodeVisitor):
    def __init__(self, role):
        self.role = role
        self.decisions = 0

    def generic_visit(self, node):
        self.decisions += decision_count(node)
        super().generic_visit(node)

    def visit_Assert(self, node):
        if self.role == "oracle":
            self.generic_visit(node)

    def visit_For(self, node):
        self.decisions += 1 + bool(node.orelse)
        super().generic_visit(node)

    visit_AsyncFor = visit_For
    visit_While = visit_For

    def visit_Try(self, node):
        self.decisions += len(node.handlers) + bool(node.orelse)
        super().generic_visit(node)

    visit_ExceptHandler = ast.NodeVisitor.generic_visit

    def visit_Match(self, node):
        self.decisions += max(0, len(node.cases) - any(wildcard_pattern(case.pattern) for case in node.cases))
        super().generic_visit(node)

    visit_match_case = ast.NodeVisitor.generic_visit


def body_decisions(statements, nodes, role, policy):
    if policy == VERSION:
        return sum(decision_count(child) for child in nodes)
    visitor = NativeDecisions(role)
    for statement in statements:
        visitor.visit(statement)
    return visitor.decisions


def wildcard_pattern(pattern):
    return isinstance(pattern, ast.MatchAs) and pattern.pattern is None


def body_name(node, parent):
    if not isinstance(node, ast.Lambda):
        return node.name
    if isinstance(parent, ast.Assign):
        return ast.unparse(parent.targets[0]) + ".<lambda>"
    if isinstance(parent, ast.AnnAssign):
        return ast.unparse(parent.target) + ".<lambda>"
    return "<lambda>"


def body_nodes(statements):
    return [child for statement in statements for child in ast.walk(statement)]


def owned_line_numbers(nodes):
    return sorted({child.lineno for child in nodes if hasattr(child, "lineno")})


def source_end(node, source, line_offsets):
    if isinstance(node, ast.Lambda):
        return line_offsets[node.end_lineno - 1] + node.end_col_offset
    end = line_offsets[node.end_lineno]
    for line_number in range(node.end_lineno, len(line_offsets) - 1):
        line = source[line_offsets[line_number]:line_offsets[line_number + 1]]
        if not line.strip():
            continue
        if len(line) - len(line.lstrip(b" \t")) <= node.col_offset:
            break
        end = line_offsets[line_number + 1]
    return end


def source_start(node, source, line_offsets):
    decorators = getattr(node, "decorator_list", [])
    if not decorators:
        return line_offsets[node.lineno - 1] + node.col_offset
    line = decorators[0].lineno - 1
    while not source[line_offsets[line]:line_offsets[line + 1]].lstrip(b" \t").startswith(b"@"):
        line -= 1
    return line_offsets[line] + node.col_offset


def source_span(node, source, line_offsets):
    return source_start(node, source, line_offsets), source_end(node, source, line_offsets)


def nested_bodies(node):
    for child in ast.iter_child_nodes(node):
        if isinstance(child, BODIES):
            yield child
        else:
            yield from nested_bodies(child)


def owned_source_bytes(node, source, line_offsets):
    cursor, end = source_span(node, source, line_offsets)
    pieces = []
    spans = sorted(source_span(nested, source, line_offsets) for nested in nested_bodies(node))
    for start, nested_end in spans:
        pieces.append(source[cursor:start])
        cursor = nested_end
    pieces.append(source[cursor:end])
    return b"".join(pieces)


def descriptor(node, name, identity, parent, role, reason, source, line_offsets, policy):
    statements = owned_nodes(node, policy)
    nodes = body_nodes(statements)
    assertions = sum(isinstance(child, ast.Assert) for child in nodes)
    decisions = body_decisions(statements, nodes, role, policy)
    fingerprint = owned_source_bytes(node, source, line_offsets)
    return {
        "identity": identity, "parent": parent, "name": name,
        "line": node.lineno, "endLine": node.end_lineno,
        "ownedLines": owned_line_numbers(nodes),
        "complexity": 1 + decisions + assertions * int(role != "oracle"),
        "decisions": decisions, "assertionStatements": assertions,
        "oracleClassification": role, "oracleReason": reason,
        "fingerprint": hashlib.sha256(fingerprint).hexdigest(),
        "source": "python-ast", "adapterVersion": VERSION, "measurementPolicy": policy,
    }


def executable_line_numbers(code):
    lines = {line for _, _, line in code.co_lines() if line}
    for constant in code.co_consts:
        if isinstance(constant, CodeType):
            lines.update(executable_line_numbers(constant))
    return lines


class BodyCollector:
    def __init__(self, tree, filename, text, policy, oracles):
        self.oracles = oracles
        self.policy = policy
        self.filename = filename
        self.source = text.encode("utf-8")
        self.line_offsets = list(accumulate((len(line) for line in self.source.splitlines(keepends=True)), initial=0))
        self.imports = imported_names(tree)
        self.executable_lines = executable_line_numbers(compile(tree, filename, "exec", dont_inherit=True, optimize=0))
        self.rows = []
        self.ordinals = {}

    def add_body(self, node, parent_node, names, parent, owner):
        local_name = body_name(node, parent_node)
        name = ".".join(names + [local_name])
        key = (parent, type(node).__name__, name)
        ordinal = self.ordinals.get(key, 0)
        self.ordinals[key] = ordinal + 1
        identity = parent + "/" + type(node).__name__ + ":" + name + "#" + str(ordinal)
        role, reason = oracle_role(node, self.filename, owner, self.imports, self.policy)
        selector = self.oracle_selector(name)
        if self.oracles is not None:
            role, reason = selected_oracle_role(role, reason, selector)
        row = descriptor(node, name, identity, parent, role, reason, self.source, self.line_offsets, self.policy)
        row["oracleSelector"] = selector
        row["executableLines"] = sorted(set(row["ownedLines"]) & self.executable_lines)
        self.rows.append(row)
        for child in ast.iter_child_nodes(node):
            self.walk(child, node, names + [local_name], identity, ("", False))

    def oracle_selector(self, name):
        return next((entry for entry in (self.oracles or []) if entry["file"] == self.filename and entry["name"] == name), None)

    def walk(self, node, parent_node, names, parent, owner):
        if isinstance(node, BODIES):
            self.add_body(node, parent_node, names, parent, owner)
            return
        if isinstance(node, ast.ClassDef):
            names = names + [node.name]
            owner = (node.name, class_is_oracle(node, self.imports))
        for child in ast.iter_child_nodes(node):
            self.walk(child, node, names, parent, owner)


def analyze(text, filename, policy=VERSION, oracles=None):
    validate_oracles(oracles, policy)
    if policy not in ORACLE_QUALIFICATIONS:
        raise ValueError("Unknown Python measurement policy. Choose " + ", ".join(ORACLE_QUALIFICATIONS))
    identities = [(entry["file"], entry["name"]) for entry in (oracles or [])]
    if len(set(identities)) != len(identities):
        raise ValueError("Duplicate or conflicting oracle selectors")
    tree = ast.parse(text, filename=filename)
    collector = BodyCollector(tree, filename, text, policy, oracles)
    collector.walk(tree, None, [], "<root>", ("", False))
    validate_selected_ownership(collector.rows, filename, oracles)
    return {"adapterVersion": VERSION, "measurementPolicy": policy, "rows": collector.rows}


def validate_selected_ownership(rows, filename, oracles):
    for entry in (oracles or []):
        if entry["file"] == filename:
            validate_selector_match(entry, rows, filename)


def validate_selector_match(entry, rows, filename):
    matches = [row for row in rows if row["name"] == entry["name"]]
    if len(matches) != 1:
        raise ValueError("Oracle selector must match exactly one independently owned body: " + filename + ":" + entry["name"])
    if matches[0]["oracleClassification"] == "fixture-setup":
        raise ValueError("Oracle selectors cannot override fixture/setup qualification")


def main():
    request = json.load(sys.stdin)
    if "oracles" in request and request["oracles"] is None:
        raise ValueError("oracles must be an array, not null")
    print(json.dumps(analyze(request["text"], request["file"], request.get("policy", VERSION), request.get("oracles"))))


if __name__ == "__main__":
    main()
