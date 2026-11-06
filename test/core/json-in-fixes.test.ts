// LB-63.2 (rule 3: always pass --json): every laneboard command an agent is told to run in the fix of an error or in a warning carries
// --json. A static guard over src/: the texts of `fix:` properties, of pushes to a warnings list and of functions and constants whose
// name says fix or warning (they build those texts), read with the TypeScript parser; a command inside "…" (the text of a comment or
// a note) is that text, not a command to run. A name used in such a text (`${init}`, `${addCheckerCommand(config)}`, `fix: f(rerun)`)
// is followed to its declarations and assignments, in the same file or the file it is imported from, and their texts count too; an
// array joined into a command (`['laneboard import …', '--json'].join(' ')`) is read as that command.
// Limits (not followed): a value passed in as a parameter from another file, a property of an object (`r.fix`), a text built by a
// helper that only takes the command apart (commandLine of argv: those fixes are tested where they are made). Names go by their text
// in the file, not by scope: a `${as}` counts as --json when any `as` of the file is given a text with --json.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { REPO } from '../helpers.ts';

// The commands of the CLI that print a JSON document with --json (board and mcp are servers, they print none).
const JSON_COMMANDS = 'prime|create|claim|comment|finish|get|list|update|attach|archive|restore|events|boards|init|config|doctor|delete|redact|import|setup|view|reply|migrate';
// A command and its words up to where the text goes on: `;`, `,`, `(`, `)`, `&&` or a closing quote (a quoted argument is one word).
const COMMAND = new RegExp(`laneboard (?:${JSON_COMMANDS})\\b(?:"[^"]*"|'[^']*'|[^;,()&"'\`])*`, 'g');
// Prose that names the command without running it: "the store pin of an earlier laneboard setup (LANEBOARD_DIR=…)".
const PROSE = /^laneboard setup \(LANEBOARD_DIR=/;
// Names of the functions and constants that build a fix or a warning text.
const BUILDS_TEXT = /^fix|Fix|FIX|[wW]arning|WARNING/; // not prefix… or suffix…

// Every *.ts file below `dir`, the browser UI left out (it prints no fix).
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) return file === path.join(REPO, 'src', 'board', 'ui') ? [] : sourceFiles(file);
    return e.name.endsWith('.ts') ? [file] : [];
  });
}

// A ${…} as one word: `${--json}` when the expression may add --json (`${json ? ' --json' : ''}`, `${as}` set from such a text in the
// same file), else `${}`.
function spanWord(expression: ts.Expression, file: ts.SourceFile): string {
  const carries = (text: string): boolean => /--json\b/.test(text);
  if (carries(expression.getText(file))) return '${--json}';
  if (ts.isIdentifier(expression) && (declarationsOf(file).get(expression.text) ?? []).some((d) => carries(d.getText(file)))) return '${--json}';
  return '${}';
}

// The text of a string or template literal, or of an array of words joined into one (`[...].join(' ')`); each ${…} counts as one word.
function literalText(node: ts.Node, file: ts.SourceFile): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => `${spanWord(s.expression, file)}${s.literal.text}`).join('');
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'join' && ts.isArrayLiteralExpression(node.expression.expression)) {
    const words = node.expression.expression.elements.map((e) => (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : /--json\b/.test(e.getText(file)) ? '${--json}' : '${}'));
    if (words.some((w) => w.startsWith('laneboard '))) return words.join(' ');
  }
  return undefined;
}

// The literals below `node` (not inside a nested literal), with their line.
function literalsIn(node: ts.Node, file: ts.SourceFile): Array<{ line: number; text: string }> {
  const text = literalText(node, file);
  if (text !== undefined) {
    const nested = ts.isTemplateExpression(node) ? node.templateSpans.flatMap((s) => literalsIn(s.expression, file)) : [];
    return [{ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text }, ...nested];
  }
  const found: Array<{ line: number; text: string }> = [];
  node.forEachChild((child) => void found.push(...literalsIn(child, file)));
  return found;
}

// The values a function returns (its return statements, or the body of an arrow), not the rest of its body (messages, checks).
function returnedValues(fn: ts.FunctionLikeDeclaration): ts.Node[] {
  if (fn.body === undefined) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression && !ts.isNewExpression(node.expression)) found.push(node.expression);
    if (!ts.isFunctionLike(node)) node.forEachChild(visit);
  };
  fn.body.forEachChild(visit);
  return found;
}

// Per file: each name with the nodes that give it a value (a variable's initializer, an assignment's right side, a function's returns).
const declarationCache = new Map<ts.SourceFile, Map<string, ts.Node[]>>();
function declarationsOf(file: ts.SourceFile): Map<string, ts.Node[]> {
  const cached = declarationCache.get(file);
  if (cached) return cached;
  const found = new Map<string, ts.Node[]>();
  const add = (name: string, node: ts.Node): void => void found.set(name, [...(found.get(name) ?? []), node]);
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const fn = node.initializer;
      for (const value of ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) ? returnedValues(fn) : [fn]) add(node.name.text, value);
    }
    if (ts.isFunctionDeclaration(node) && node.name) for (const value of returnedValues(node)) add(node.name.text, value);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) add(node.left.text, node.right);
    node.forEachChild(visit);
  };
  visit(file);
  declarationCache.set(file, found);
  return found;
}

// Parsed source files, by path.
const parsed = new Map<string, ts.SourceFile>();
function parse(name: string): ts.SourceFile {
  const cached = parsed.get(name);
  if (cached) return cached;
  const file = ts.createSourceFile(name, fs.readFileSync(name, 'utf8'), ts.ScriptTarget.Latest, true);
  parsed.set(name, file);
  return file;
}

// The names a file imports from other files of src/: local name -> the file and the exported name.
function importsOf(file: ts.SourceFile): Map<string, { file: string; name: string }> {
  const found = new Map<string, { file: string; name: string }>();
  for (const st of file.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.moduleSpecifier.text.startsWith('.')) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const from = path.resolve(path.dirname(file.fileName), st.moduleSpecifier.text);
    for (const el of bindings.elements) found.set(el.name.text, { file: from, name: (el.propertyName ?? el.name).text });
  }
  return found;
}

// The names whose value an expression is, or is built from: `stuck`, `f(a, rerun)` (f, rerun), `...(await f())`, `a ?? b`, `[a, b]`.
// Not a property (`r.fix`) and not what a `new` gets (an error's message is no fix).
function valueNames(node: ts.Node): ts.Identifier[] {
  if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isSpreadElement(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return valueNames(node.expression);
  if (ts.isIdentifier(node)) return [node];
  if (ts.isCallExpression(node)) return [...(ts.isIdentifier(node.expression) ? [node.expression] : []), ...node.arguments.flatMap(valueNames)];
  if (ts.isConditionalExpression(node)) return [...valueNames(node.whenTrue), ...valueNames(node.whenFalse)];
  if (ts.isBinaryExpression(node)) return [...valueNames(node.left), ...valueNames(node.right)];
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(valueNames);
  if (ts.isTemplateExpression(node)) return unquotedSpans(node).flatMap((s) => valueNames(s.expression));
  return [];
}

// The ${…} of a template that are not inside "…": one inside is part of a text (a comment's), not a command to run.
function unquotedSpans(node: ts.TemplateExpression): ts.TemplateSpan[] {
  let before = node.head.text;
  return node.templateSpans.filter((span) => {
    const unquoted = (before.match(/"/g) ?? []).length % 2 === 0;
    before += `\${}${span.literal.text}`;
    return unquoted;
  });
}

// The holders a holder leads to: the value-giving nodes (declarationsOf) of each name its value or a ${…} in it is built from
// (valueNames), here or in the file it is imported from.
function followed(holder: ts.Node, file: ts.SourceFile): Array<{ node: ts.Node; file: ts.SourceFile }> {
  const names: ts.Identifier[] = [...valueNames(holder)];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) return;
    if (ts.isTemplateExpression(node)) names.push(...unquotedSpans(node).flatMap((span) => valueNames(span.expression)));
    node.forEachChild(visit);
  };
  visit(holder);
  return names.flatMap((name) => {
    const own = (declarationsOf(file).get(name.text) ?? []).map((node) => ({ node, file }));
    const imported = importsOf(file).get(name.text);
    if (!imported) return own;
    const other = parse(imported.file.endsWith('.ts') ? imported.file : `${imported.file}.ts`);
    return [...own, ...(declarationsOf(other).get(imported.name) ?? []).map((node) => ({ node, file: other }))];
  });
}

// The name of a declaration, or undefined.
function declaredName(node: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) return node.name.text;
  return undefined;
}

// The lists a `fix:` joins (`fix: steps.join('; ')`): their names.
function joinedLists(fix: ts.Expression): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'join' && ts.isIdentifier(node.expression.expression)) {
      names.push(node.expression.expression.text);
    }
    node.forEachChild(visit);
  };
  visit(fix);
  return names;
}

// The function a node is in, or the file.
function enclosingFunction(node: ts.Node): ts.Node {
  let at = node.parent;
  while (at !== undefined && !ts.isFunctionLike(at) && !ts.isSourceFile(at)) at = at.parent;
  return at ?? node;
}

// The parts of a source file that hold fix and warning texts. A list a `fix:` joins counts too: its declaration and the pushes to it
// in the same function (`steps.push(…)`, then `fix: steps.join('; ')`).
function textHolders(file: ts.SourceFile): ts.Node[] {
  const holders: ts.Node[] = [];
  const listsOf = (scope: ts.Node, names: readonly string[]): void => {
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.includes(node.name.text) && node.initializer) holders.push(node.initializer);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'push' && names.includes(node.expression.expression.getText(file))) {
        holders.push(...node.arguments);
      }
      node.forEachChild(visit);
    };
    visit(scope);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'fix') {
      listsOf(enclosingFunction(node), joinedLists(node.initializer));
      return void holders.push(node.initializer);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'push' && /warnings?$/i.test(node.expression.expression.getText(file))) {
      return void holders.push(...node.arguments);
    }
    const name = declaredName(node);
    if (name !== undefined && BUILDS_TEXT.test(name)) return void holders.push(node);
    node.forEachChild(visit);
  };
  visit(file);
  return holders;
}

// Commands without --json in the fix and warning texts of src/: `file:line: command`.
function commandsWithoutJson(): string[] {
  // Every holder of src/ and every node it leads to (followed), each once.
  const seen = new Set<ts.Node>();
  const queue: Array<{ node: ts.Node; file: ts.SourceFile }> = sourceFiles(path.join(REPO, 'src')).flatMap((name) => {
    const file = parse(name);
    return textHolders(file).map((node) => ({ node, file }));
  });
  const holders: Array<{ node: ts.Node; file: ts.SourceFile }> = [];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next.node)) continue;
    seen.add(next.node);
    holders.push(next);
    queue.push(...followed(next.node, next.file));
  }
  const found = holders.flatMap(({ node, file }) =>
    literalsIn(node, file).flatMap(({ line, text }) =>
      [...text.matchAll(COMMAND)]
        .filter((m) => (text.slice(0, m.index).match(/"/g) ?? []).length % 2 === 0)
        .filter((m) => !PROSE.test(text.slice(m.index)))
        .map((m) => m[0].trim())
        .filter((command) => !/--json\b|--help\b|--hook\b|--edit-hook\b/.test(command))
        .map((command) => `${path.relative(REPO, file.fileName)}:${line}: ${command}`),
    ),
  );
  return [...new Set(found)];
}

describe('LB-63.2: --json in every command of a fix or a warning', () => {
  it('no fix and no warning in src/ names a laneboard command without --json', () => {
    expect(commandsWithoutJson()).toEqual([]);
  });
});
