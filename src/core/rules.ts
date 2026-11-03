// Agent rules: one source (agent-rules.md next to this file) for the plugin skill, `prime` and MCP instructions.
import fs from 'node:fs';

// The agent rules text, without the trailing newline.
export function agentRules(): string {
  return fs.readFileSync(new URL('./agent-rules.md', import.meta.url), 'utf8').trimEnd();
}

// Skill frontmatter (code.claude.com/docs/en/skills: `name`, `description`; no angle brackets in the description).
const SKILL_DESCRIPTION =
  'Track work on the laneboard task board - claim a task, change its status, comment results, attach files, link branches and PRs, archive. Use in a project with a .laneboard/ store, or when the user mentions tasks, the board or a task id like LB-12.';

// SKILL.md of the Claude Code plugin: frontmatter plus the agent rules.
export function skillMarkdown(): string {
  // JSON string syntax is a valid YAML double-quoted scalar.
  return `---\nname: laneboard\ndescription: ${JSON.stringify(SKILL_DESCRIPTION)}\n---\n\n${agentRules()}\n`;
}
