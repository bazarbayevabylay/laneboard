// LB-63.2 (rule 3: always pass --json): every laneboard command an agent is told to run in the fix of an error or in a warning carries
// --json. A static guard over src/: the texts of `fix:` properties, of pushes to a warnings list and of functions and constants whose
// name says fix or warning (they build those texts), read with the TypeScript parser; a command inside "…" (the text of a comment or
// a note) is that text, not a command to run.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { REPO } from '../helpers.ts';

// The commands of the CLI that print a JSON document with --json (board and mcp are servers, they print none).
const JSON_COMMANDS = 'prime|create|claim|comment|finish|get|list|update|attach|archive|restore|events|boards|init|config|doctor|delete|redact|import|setup|view|reply|migrate';
// A command and its words up to where the text goes on: `;`, `,`, `)` or a closing quote (a quoted argument is one word).
const COMMAND = new RegExp(`laneboard (?:${JSON_COMMANDS})\\b(?:"[^"]*"|'[^']*'|[^;,)"'\`])*`, 'g');
// Prose that names the command without running it: "the store pin of an earlier laneboard setup (LANEBOARD_DIR=…)".
const PROSE = /^laneboard setup \(/;
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

// The text of a string or template literal; each ${…} counts as one word.
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => `\${}${s.literal.text}`).join('');
  return undefined;
}

// The literals below `node` (not inside a nested literal), with their line.
function literalsIn(node: ts.Node, file: ts.SourceFile): Array<{ line: number; text: string }> {
  const text = literalText(node);
  if (text !== undefined) {
    const nested = ts.isTemplateExpression(node) ? node.templateSpans.flatMap((s) => literalsIn(s.expression, file)) : [];
    return [{ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text }, ...nested];
  }
  const found: Array<{ line: number; text: string }> = [];
  node.forEachChild((child) => void found.push(...literalsIn(child, file)));
  return found;
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
  return sourceFiles(path.join(REPO, 'src')).flatMap((name) => {
    const file = ts.createSourceFile(name, fs.readFileSync(name, 'utf8'), ts.ScriptTarget.Latest, true);
    return textHolders(file).flatMap((holder) =>
      literalsIn(holder, file).flatMap(({ line, text }) =>
        [...text.matchAll(COMMAND)]
          .filter((m) => (text.slice(0, m.index).match(/"/g) ?? []).length % 2 === 0)
          .map((m) => m[0].trim())
          .filter((command) => !PROSE.test(command) && !/--json\b|--help\b|--hook\b|--edit-hook\b/.test(command))
          .map((command) => `${path.relative(REPO, name)}:${line}: ${command}`),
      ),
    );
  });
}

describe('LB-63.2: --json in every command of a fix or a warning', () => {
  it('no fix and no warning in src/ names a laneboard command without --json', () => {
    expect(commandsWithoutJson()).toEqual([]);
  });
});
