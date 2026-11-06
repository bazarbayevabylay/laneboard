// The tool calls of an MCP fix or warning (LB-60.1: `task_x {json}` in place of a CLI command), and running them as printed (rule 13).
import { callTool } from '../../src/mcp/tools.ts';
import type { ToolEnv, ToolResult } from '../../src/mcp/tools.ts';

// The tool calls of `text`, in order: `task_x` or `task_x {json}`.
export function toolCalls(text: string): Array<{ name: string; args: Record<string, unknown> }> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const re = /\btask_[a-z]+/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    let args: Record<string, unknown> = {};
    const start = re.lastIndex + 1;
    if (text[start - 1] === ' ' && text[start] === '{') {
      for (let end = text.indexOf('}', start); end !== -1; end = text.indexOf('}', end + 1)) {
        try {
          args = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
          re.lastIndex = end + 1;
          break;
        } catch {
          // Not the closing brace of the arguments yet (a brace inside a value): try the next one.
        }
      }
    }
    calls.push({ name: m[0], args });
  }
  return calls;
}

// Run every tool call of `text` in order as the server does, `extra` added to each call's arguments; the replies.
export async function runCalls(text: string, env: ToolEnv, extra: Record<string, unknown> = {}): Promise<ToolResult[]> {
  const out: ToolResult[] = [];
  for (const c of toolCalls(text)) out.push(await callTool(c.name, { ...c.args, ...extra }, env));
  return out;
}

// Run a fix as printed: 0 when there is a call and every call succeeds, else 1 (like the exit code of a shell line).
export async function runFix(text: string, env: ToolEnv, extra: Record<string, unknown> = {}): Promise<number> {
  const replies = await runCalls(text, env, extra);
  return replies.length > 0 && replies.every((r) => r.isError !== true) ? 0 : 1;
}
