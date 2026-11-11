import type { AgentConfig, Team } from '../../shared/types.ts';
import { brainstormingSkill } from './skills.ts';

const roster = (team: Team, self: AgentConfig) =>
  team.agents.filter((a) => a.id !== self.id)
    .map((a) => `- ${a.name} — ${a.roleTitle}${a.instructions ? `: ${a.instructions}` : ''}`)
    .join('\n');

const SUPERPOWERS_FLOW = `
Work in this order:
1. Restate the goal and settle the design before any code is written. Keep it short.
2. Break the work into small tasks, each with a way to verify it.
3. Hand out one implementation task at a time. Ask for a failing test first where tests make sense.
4. After each implementation task, send the result to a reviewer if the team has one: first "does it match the brief", then "is the code good".
5. Do not call the work finished until it has been verified by running it or its tests.`;

const GIT_FLOW = `
Each teammate task runs on its own git branch in a separate copy of the repository and is merged back when the task ends, so teammates only see work that was already merged. If a report says a branch was not merged (conflict, failed check, rejected review), decide what to do: usually a follow-up task that names the branch and the files.`;

/** Lets an agent answer "which model are you" truthfully. */
export const identity = (agent: AgentConfig, modelLabel: string) =>
  `You run on the ${agent.provider} provider, model ${modelLabel}${agent.effort !== 'default' ? `, effort ${agent.effort}` : ''}. If asked which model you are, say exactly that.`;

const stackLine = (team: Team) => (team.stack.trim() ? `\nTech stack for this team: ${team.stack.trim()}. Use it unless the task says otherwise.\n` : '');

const CLARIFY = `
Before work starts: if a decision that matters is unclear and guessing wrong would waste real work, ask the user first. To ask, reply with one short sentence and exactly one fenced block:

\`\`\`questions
[{"question": "<the question>", "options": ["<answer A>", "<answer B>"], "recommended": "<the option you would pick>"}]
\`\`\`

At most 4 questions per block, each with 2 to 4 options and your recommended option. For an open question with no sensible options, give "options": [] and the user types the answer. Only ask about things the user must decide (scope, behaviour, technology, where things go). Decide small details yourself. If the task is already clear, do not ask: start.`;

const CLARIFY_WITH_SKILL = `
Follow the Superpowers brainstorming skill (given with the first task) for WHEN and WHAT to ask, one question at a time, until you understand what the user wants and they approved an approach. In this app you reach the user only through a questions block, and their answers come back to you as "Answers from the user". To get approval of an approach or a design, ask it as a question with options such as "Approve" and "Change it". Skip the parts about visual companions, spikes and writing files before approval. When the user has approved, stop asking and start the work.`;

/** The rules for asking stay in the system prompt (stable, so the provider can cache it). */
function clarifyText(): string {
  return brainstormingSkill() ? `${CLARIFY}\n${CLARIFY_WITH_SKILL}` : CLARIFY;
}

/**
 * The skill text itself travels once, with the first message of a conversation. It then stays in the session
 * (and in the provider's prompt cache) instead of being sent again with every turn.
 */
export function withSkillOnce(prompt: string, firstTurn: boolean, clarify: boolean): string {
  const skill = firstTurn && clarify ? brainstormingSkill() : '';
  return skill ? `<brainstorming-skill>\n${skill}\n</brainstorming-skill>\n\n${prompt}` : prompt;
}

const MEMORY_RULES = `
Team memory: when this run taught you something worth knowing in future runs (a decision, a convention of this project, a preference of the user), end your final summary with one block of short lines. Only durable facts, never secrets:

\`\`\`memory
- <one fact per line>
\`\`\``;

/** Earlier notes of the team, newest last, capped so they never crowd the context. */
export function memorySection(notes: string): string {
  const text = notes.trim();
  if (!text) return MEMORY_RULES;
  const capped = text.length > 6000 ? `…\n${text.slice(-6000)}` : text;
  return `\nNotes this team kept from earlier runs:\n<team-memory>\n${capped}\n</team-memory>\n${MEMORY_RULES}`;
}

/** One reply, no tools, a few sentences of instructions: the cheapest way to answer a simple question. */
export function quickPrompt(team: Team, agent: AgentConfig, modelLabel: string, memory = ''): string {
  return `You are ${agent.name}, ${agent.roleTitle} of the team "${team.name}". ${identity(agent, modelLabel)}
Answer the user directly and briefly, in the language they wrote in. You have no tools and cannot see files or run anything.
If answering properly needs files, code changes, commands or research, reply with exactly ${'NEEDS_TEAM'} and nothing else.${memory.trim() ? `\nNotes this team kept from earlier runs:\n${memory.trim().slice(-2000)}` : ''}`;
}

export function leadPrompt(team: Team, lead: AgentConfig, opts: { worktrees: boolean; modelLabel: string; memory?: string }): string {
  const light = team.agents.some((a) => a.id !== lead.id && a.lightModel);
  return `You are ${lead.name}, ${lead.roleTitle} of the team "${team.name}". ${identity(lead, opts.modelLabel)}
${lead.instructions ? `${lead.instructions}\n` : ''}${stackLine(team)}
Your teammates:
${roster(team, lead)}

You coordinate. Give hands-on work to teammates instead of doing it yourself, and keep small glue work for yourself only when delegating would cost more than it saves. Simple questions you can answer directly.

To delegate, end your reply with exactly one fenced block like this:

\`\`\`delegate
[{"to": "<teammate name>", "name": "<short task name, 2-5 words>", "task": "<complete brief>"}]
\`\`\`

Rules for delegating:
- Teammates cannot see this conversation. Each brief must stand alone: goal, relevant file paths, constraints, and what "done" looks like.
- All tasks in one block start at the same time, so only group tasks that do not depend on each other or touch the same files. Put dependent work in a later block. Two tasks for the same teammate run one after the other.
- After they finish you receive their reports. You can then delegate again or finish.
- Lines starting with "Message from the user" are new instructions that arrived while the team was working. Take them into account.
- Keep briefs tight: what to do and how to check it, not background the teammate does not need.${light ? `
- Add "level": "light" to a task that is simple and mechanical (a lookup, a rename, a small edit). It then runs on that teammate's cheaper model.` : ''}

When the whole job is done, reply with a summary for the user and no delegate block. Reply to the user in the language they wrote the task in.
${team.clarify ? clarifyText() : ''}${opts.worktrees ? GIT_FLOW : ''}${team.workflow === 'superpowers' ? SUPERPOWERS_FLOW : ''}${team.memory ? memorySection(opts.memory ?? '') : ''}`.trim();
}

export function memberPrompt(team: Team, agent: AgentConfig, lead: AgentConfig | undefined, modelLabel: string, canAsk = false, memory = ''): string {
  return `You are ${agent.name}, ${agent.roleTitle} on the team "${team.name}". ${identity(agent, modelLabel)}
${agent.instructions ? `${agent.instructions}\n` : ''}${stackLine(team)}
${lead ? `${lead.name} leads the team and gives you tasks.` : 'You work alone on tasks from the user.'} Do the task in the current working directory and stay inside it.

End with a short report (at most about 150 words): what you did, which files changed, how you checked it, and anything left open. Do not paste whole files or long logs into the report. If you could not do something, say so plainly instead of guessing.
${canAsk && team.clarify ? clarifyText() : ''}${canAsk && team.memory ? memorySection(memory) : ''}`.trim();
}
