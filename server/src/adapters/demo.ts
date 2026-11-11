import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentState } from '../../../shared/types.ts';
import { clip, type Adapter } from './types.ts';

// Simulated agent: lets people try the office without any account.

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });

const speed = Number(process.env.BEO_DEMO_SPEED ?? 1);

export const demoAdapter: Adapter = async (input) => {
  const step = async (state: AgentState, detail: string, ms: number) => {
    input.emit({ type: 'state', state, detail });
    if (state !== 'thinking') input.emit({ type: 'tool', tool: state, detail });
    await sleep(ms * speed, input.signal);
  };

  if (input.agent.role === 'manager' && input.teammates.length && !input.prompt.startsWith('[direct]')) {
    await step('thinking', '', 1800);
    // The lead remembers the task in its session, so its briefs still name it after the user's answers.
    const remembered = typeof input.session === 'string' && input.session.startsWith('task:') ? input.session.slice(5) : '';
    const firstLine = clip(input.prompt.split('\n').find((l) => l.trim()) ?? 'the task', 80);
    if (input.systemPrompt.includes('```questions') && !input.prompt.includes('Answers from the user') && !input.prompt.includes('Reports from your team') && !input.session) {
      const say = 'Two quick questions before we start.';
      input.emit({ type: 'message', kind: 'say', text: say });
      const questions = [
        { question: 'Where should the data be stored?', options: ['In the browser (localStorage)', 'In a small backend with SQLite'], recommended: 'In the browser (localStorage)' },
        { question: 'Which language?', options: ['TypeScript', 'JavaScript'], recommended: 'TypeScript' },
      ];
      return { text: `${say}\n\n\`\`\`questions\n${JSON.stringify(questions)}\n\`\`\``, session: `task:${firstLine}` };
    }
    if (!input.prompt.includes('Reports from your team')) {
      const brief = remembered || firstLine;
      const tasks = input.teammates.map((to, i) => i === 0
        ? { to, name: 'Build first version', task: `Build a first version of: ${brief}` }
        : { to, name: 'Research risks', task: `Look into background and risks for: ${brief}` });
      const say = `Here is the plan. I am splitting this into ${tasks.length} parts.`;
      input.emit({ type: 'message', kind: 'say', text: say });
      return { text: `${say}\n\n\`\`\`delegate\n${JSON.stringify(tasks, null, 2)}\n\`\`\``, session: `task:${brief}` };
    }
    await step('reading', 'team reports', 1500);
    const text = 'All parts are in. This was a simulated run: switch the agents to Claude, Codex or a local model in the team editor to do real work.';
    input.emit({ type: 'message', kind: 'say', text });
    return { text };
  }

  await step('thinking', '', 1200);
  await step('reading', 'README.md', 1400);
  if (input.agent.role === 'researcher') {
    await step('searching', 'prior art and pitfalls', 2200);
  } else {
    const file = `notes/${input.agent.name.toLowerCase()}.md`;
    if (input.autonomy !== 'read' && (!input.ask.edits || (await input.approve('edit', `${input.agent.name} wants to write a file`, file)))) {
      await step('writing', file, 2000);
      await fs.mkdir(path.join(input.cwd, 'notes'), { recursive: true });
      await fs.appendFile(path.join(input.cwd, file), `- ${new Date().toISOString()} simulated work by ${input.agent.name}\n`);
    }
    if (input.autonomy === 'full' && (!input.ask.commands || (await input.approve('command', `${input.agent.name} wants to run a command`, 'npm test')))) {
      await step('running', 'npm test', 1600);
      input.emit({ type: 'output', text: '> npm test\n\n 3 passed, 0 failed (simulated)' });
    }
  }
  const text = `${input.agent.name} finished the simulated task.`;
  input.emit({ type: 'message', kind: 'say', text });
  input.emit({ type: 'usage', inputTokens: 1200, outputTokens: 340 });
  return { text };
};
