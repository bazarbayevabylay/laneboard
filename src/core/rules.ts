// Agent rules: one source (agent-rules.md next to this file) for the plugin skill, `prime` and MCP instructions, with the short
// forms prime prints at its size limit and the MCP forms of the server's instructions in the same file.
import fs from 'node:fs';

// The line that starts the short forms in agent-rules.md; everything above it is the rules.
const SHORT_FORMS_MARK = '<!-- short forms';

// A short form of rule `n`: `hash` = the first 8 hex of the sha256 of the full rule line it was written for, `text` without the number.
export interface ShortRule {
  n: string;
  hash: string;
  text: string;
}

// agent-rules.md split at SHORT_FORMS_MARK: the rules, and the short-form part.
function rulesFile(): { rules: string; short: string } {
  const text = fs.readFileSync(new URL('./agent-rules.md', import.meta.url), 'utf8');
  const at = text.indexOf(`\n${SHORT_FORMS_MARK}`);
  return at < 0 ? { rules: text.trimEnd(), short: '' } : { rules: text.slice(0, at).trimEnd(), short: text.slice(at) };
}

// The agent rules text, without the trailing newline.
export function agentRules(): string {
  return rulesFile().rules;
}

// The short forms, in file order: lines `short <n> <hash>: <text>` after SHORT_FORMS_MARK.
export function shortRuleForms(): ShortRule[] {
  const out: ShortRule[] = [];
  for (const line of rulesFile().short.split('\n')) {
    const m = /^short (\d+) ([0-9a-f]{8}): (.+)$/.exec(line);
    if (m) out.push({ n: m[1] ?? '', hash: m[2] ?? '', text: m[3] ?? '' });
  }
  return out;
}

// The MCP forms, in file order: lines `mcp <n> <hash>: <text>` after SHORT_FORMS_MARK (text `-`: the rule has no MCP form).
export function mcpRuleForms(): ShortRule[] {
  const out: ShortRule[] = [];
  for (const line of rulesFile().short.split('\n')) {
    const m = /^mcp (\d+) ([0-9a-f]{8}): (.+)$/.exec(line);
    if (m) out.push({ n: m[1] ?? '', hash: m[2] ?? '', text: m[3] ?? '' });
  }
  return out;
}

// The agent rules for an MCP client (its instructions): the MCP form of each rule that has one, under the rules' own numbers, so a fix
// that names "rule 3" means the same rule in both texts.
export function mcpAgentRules(): string {
  const lines = mcpRuleForms()
    .filter((r) => r.text !== '-')
    .map((r) => `${r.n}. ${r.text}`);
  return ['laneboard agent rules (task board for AI coding agents, MCP tools):', ...lines].join('\n');
}

// Skill frontmatter (code.claude.com/docs/en/skills: `name`, `description`; no angle brackets in the description).
const SKILL_DESCRIPTION =
  'Track work on the laneboard task board - claim a task (or resume your own after /clear or a restart), comment steps, finish it with a result and the commit, attach files, link branches and PRs, archive. Use in a project with a .laneboard/ store, or when the user mentions tasks, the board or a task id like LB-12.';

// SKILL.md of the Claude Code plugin: frontmatter plus the agent rules.
export function skillMarkdown(): string {
  // JSON string syntax is a valid YAML double-quoted scalar.
  return `---\nname: laneboard\ndescription: ${JSON.stringify(SKILL_DESCRIPTION)}\n---\n\n${agentRules()}\n`;
}
