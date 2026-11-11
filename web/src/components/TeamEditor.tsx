import { useEffect, useState } from 'react';
import { TEAM_DEFAULTS, type AgentConfig, type Effort, type McpServer, type ProviderStatus, type Role, type SkillsState, type Team } from '../../../shared/types.ts';
import { useI18n, type TKey } from '../i18n.tsx';
import { api } from '../api.ts';
import { ACCESSORIES, Character, GLASSES, HAIRS, HAIR_COLORS, PALETTE, PRESETS, randomLook, sameLook } from './Character.tsx';

const ROLES: Role[] = ['manager', 'coder', 'researcher', 'reviewer', 'custom'];
const EFFORTS: Effort[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const uid = () => Math.random().toString(36).slice(2, 10);

export function blankTeam(name: string): Team {
  const now = Date.now();
  return {
    id: '', name, description: '', autonomy: 'edit', workflow: 'free', maxRounds: 8, createdAt: now, updatedAt: now, ...structuredClone(TEAM_DEFAULTS),
    agents: [newAgent('manager', []), newAgent('coder', [PRESETS[0].name])],
  };
}

function newAgent(role: Role, taken: string[]): AgentConfig {
  // Each new agent starts as the next standard character that is not on the team yet.
  const preset = PRESETS.find((p) => !taken.includes(p.name));
  return {
    id: uid(), name: preset?.name ?? `Agent ${taken.length + 1}`, role, roleTitle: '', provider: 'claude', model: '', effort: 'default',
    instructions: '', skills: [], look: preset ? { ...preset.look } : randomLook(),
  };
}

function AgentCard({ agent, providers, skills, onChange, onRemove }: {
  agent: AgentConfig; providers: ProviderStatus[]; skills: SkillsState; onChange: (a: AgentConfig) => void; onRemove: () => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<AgentConfig>) => onChange({ ...agent, ...patch });
  const look = (patch: Partial<AgentConfig['look']>) => set({ look: { ...agent.look, ...patch } });
  const providerKey = agent.provider === 'local' ? `local:${agent.endpointId ?? ''}` : agent.provider;
  const status = providers.find((p) => p.id === providerKey);
  const cycle = <T,>(list: T[], current: T) => list[(list.indexOf(current) + 1) % list.length];

  return (
    <div className="agent-card">
      <div className="agent-look">
        <svg viewBox="-60 -150 120 160" width="110" height="146"><Character look={agent.look} state="idle" /></svg>
        <div className="look-buttons">
          <button title={t('color')} onClick={() => look({ color: (agent.look.color + 1) % PALETTE.length })}><span className="dot" style={{ background: PALETTE[agent.look.color % PALETTE.length].body }} /></button>
          <button onClick={() => look({ hair: cycle(HAIRS, agent.look.hair) })}>{t('hair')}</button>
          <button title={t('hair')} onClick={() => look({ hairColor: cycle(HAIR_COLORS, agent.look.hairColor) })}><span className="dot" style={{ background: agent.look.hairColor }} /></button>
          <button onClick={() => look({ glasses: cycle(GLASSES, agent.look.glasses) })}>{t('glasses')}</button>
          <button onClick={() => look({ accessory: cycle(ACCESSORIES, agent.look.accessory) })}>{t('accessory')}</button>
        </div>
      </div>
      <div className="agent-fields">
        <div className="grid2">
          <label>{t('name')}<input value={agent.name} onChange={(e) => set({ name: e.target.value })} /></label>
          <label>{t('role')}
            <select value={agent.role} onChange={(e) => set({ role: e.target.value as Role })}>
              {ROLES.map((r) => <option key={r} value={r}>{t(`role_${r}` as TKey)}</option>)}
            </select>
          </label>
          <label>{t('provider')}
            <select value={providerKey} onChange={(e) => {
              const p = providers.find((x) => x.id === e.target.value);
              if (p) set({ provider: p.provider, endpointId: p.endpointId, model: '' });
            }}>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}{p.ok ? '' : ' ⚠'}</option>)}
              {!status && <option value={providerKey}>{agent.provider}</option>}
            </select>
          </label>
          <label>{t('model')}
            <input value={agent.model} onChange={(e) => set({ model: e.target.value })} placeholder={t('modelDefault')} list={`models-${agent.id}`} disabled={agent.provider === 'demo'} />
            <datalist id={`models-${agent.id}`}>{status?.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</datalist>
          </label>
          <label>{t('effort')}
            <select value={agent.effort} onChange={(e) => set({ effort: e.target.value as Effort })} disabled={agent.provider === 'demo'}>
              {EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </label>
          <label>{t('agentBudget')}<input type="number" min={0} step={10000} value={agent.dailyTokens ?? 0} onChange={(e) => set({ dailyTokens: Math.max(0, Number(e.target.value) || 0) })} /></label>
          {agent.provider !== 'demo' && (
            <label title={t('fallbackHint')}>{t('fallback')}
              <select value={agent.fallback ? `${agent.fallback.provider}|${agent.fallback.endpointId ?? ''}` : ''} onChange={(e) => {
                if (!e.target.value) { set({ fallback: undefined }); return; }
                const [provider, endpointId] = e.target.value.split('|');
                set({ fallback: { provider: provider as AgentConfig['provider'], model: '', endpointId: endpointId || undefined } });
              }}>
                <option value="">{t('fallbackNone')}</option>
                {providers.filter((p) => p.provider !== 'demo' && p.provider !== agent.provider).map((p) => <option key={p.id} value={`${p.provider}|${p.endpointId ?? ''}`}>{p.name}{p.ok ? '' : ' ⚠'}</option>)}
              </select>
              {agent.fallback && <input value={agent.fallback.model} placeholder={t('modelDefault')} list={`fb-${agent.id}`} onChange={(e) => set({ fallback: { ...agent.fallback!, model: e.target.value } })} />}
              {agent.fallback && <datalist id={`fb-${agent.id}`}>{providers.find((p) => p.provider === agent.fallback!.provider && (p.endpointId ?? '') === (agent.fallback!.endpointId ?? ''))?.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</datalist>}
            </label>)}
          {agent.role !== 'manager' && agent.provider !== 'demo' && (
            <label title={t('lightModelHint')}>{t('lightModel')}
              <input value={agent.lightModel ?? ''} onChange={(e) => set({ lightModel: e.target.value })} placeholder={t('lightModelNone')} list={`models-${agent.id}`} />
            </label>)}
          <label>{t('roleTitle')}<input value={agent.roleTitle} onChange={(e) => set({ roleTitle: e.target.value })} placeholder={t(`role_${agent.role}` as TKey)} /></label>
        </div>
        {status && !status.ok && <div className="warn">{status.note}</div>}
        <label>{t('instructions')}<textarea rows={2} value={agent.instructions} onChange={(e) => set({ instructions: e.target.value })} placeholder={t('instructionsPlaceholder')} /></label>
        {skills.installed && (
          <div className="skill-list">
            <span className="label">{t('skills')}</span>
            {skills.skills.map((s) => {
              const on = agent.skills.includes(s.name);
              return <button key={s.name} title={s.description} className={on ? 'chip on' : 'chip'} onClick={() => set({ skills: on ? agent.skills.filter((x) => x !== s.name) : [...agent.skills, s.name] })}>{s.name}</button>;
            })}
          </div>
        )}
        <div className="presets">
          <span className="label">{t('character')}</span>
          {PRESETS.map((p) => (
            <button key={p.name} title={p.name} className={sameLook(p.look, agent.look) ? 'preset on' : 'preset'}
              onClick={() => set({ look: { ...p.look }, name: PRESETS.some((x) => x.name === agent.name) || !agent.name.trim() ? p.name : agent.name })}>
              <svg viewBox="-42 -136 84 100" width="38" height="45"><Character look={p.look} state="idle" /></svg>
            </button>
          ))}
        </div>
        <button className="ghost danger-text" onClick={onRemove}>{t('remove')}</button>
      </div>
    </div>
  );
}

const MCP_PRESETS: { name: string; command: string; args: string[]; hint: TKey }[] = [
  { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless'], hint: 'mcpPlaywright' },
  { name: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'], hint: 'mcpContext7' },
];

/** MCP servers: extra tools for the team's agents, such as a browser for UI testing. */
function McpEditor({ servers, docker, onChange }: { servers: McpServer[]; docker: boolean; onChange: (s: McpServer[]) => void }) {
  const { t } = useI18n();
  const update = (i: number, patch: Partial<McpServer>) => onChange(servers.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <fieldset className="mcp"><legend>{t('mcpTitle')}</legend>
      {servers.map((s, i) => (
        <div className="row" key={s.id}>
          <input type="checkbox" checked={s.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} aria-label={t('enabled')} />
          <input style={{ width: 120 }} value={s.name} onChange={(e) => update(i, { name: e.target.value })} placeholder={t('name')} />
          <input className="grow mono" value={s.url ?? [s.command, ...(s.args ?? [])].filter(Boolean).join(' ')} placeholder={t('mcpCommandPlaceholder')}
            onChange={(e) => {
              const v = e.target.value;
              if (/^https?:\/\//.test(v.trim())) update(i, { url: v.trim(), command: undefined, args: undefined });
              else { const [command = '', ...args] = v.split(' ').filter((x, k) => x || k === 0); update(i, { command, args, url: undefined }); }
            }} />
          <button className="ghost" onClick={() => onChange(servers.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <div className="row">
        {MCP_PRESETS.filter((p) => !servers.some((s) => s.name === p.name)).map((p) => (
          <button key={p.name} className="ghost" title={t(p.hint)} onClick={() => onChange([...servers, { id: uid(), name: p.name, command: p.command, args: p.args, enabled: true }])}>+ {p.name}</button>
        ))}
        <button className="ghost" onClick={() => onChange([...servers, { id: uid(), name: 'server', command: '', args: [], enabled: true }])}>+ {t('mcpCustom')}</button>
      </div>
      <p className="hint">{t('mcpHint')}{docker ? ` ${t('mcpDocker')}` : ''}</p>
    </fieldset>
  );
}

/** What the team remembers between runs; the lead adds to it, you can edit it. */
function MemoryEditor({ team, onToggle }: { team: Team; onToggle: (on: boolean) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  useEffect(() => {
    if (!team.id) return;
    api.memory(team.id).then((m) => { setText(m.text); setSaved(m.text); }).catch(() => setText(''));
  }, [team.id]);
  return (
    <fieldset className="memory"><legend>{t('memoryTitle')}</legend>
      <label className="check"><input type="checkbox" checked={team.memory} onChange={(e) => onToggle(e.target.checked)} />{t('memoryOn')}</label>
      {team.id && text !== null && <>
        <textarea rows={5} className="mono" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('memoryEmpty')} />
        <div className="row"><span className="hint grow">{t('memoryHint')}</span>
          <button disabled={text === saved} onClick={async () => { const r = await api.saveMemory(team.id, text); setSaved(r.text); setText(r.text); }}>{t('memorySave')}</button></div>
      </>}
    </fieldset>
  );
}

export function TeamEditor({ team: initial, providers, skills, onSave, onDelete, onClose }: {
  team: Team; providers: ProviderStatus[]; skills: SkillsState;
  onSave: (team: Team) => void; onDelete: (id: string) => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const [team, setTeam] = useState<Team>(initial);
  const set = (patch: Partial<Team>) => setTeam({ ...team, ...patch });
  const titled = (): Team => ({ ...team, agents: team.agents.map((a) => ({ ...a, name: a.name.trim() || 'Agent', roleTitle: a.roleTitle.trim() || t(`role_${a.role}` as TKey) })) });
  const hasLead = team.agents.some((a) => a.role === 'manager');

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="grid2 top">
          <label>{t('teamName')}<input value={team.name} onChange={(e) => set({ name: e.target.value })} autoFocus /></label>
          <label>{t('description')}<input value={team.description} onChange={(e) => set({ description: e.target.value })} /></label>
          <label>{t('autonomy')}
            <select value={team.autonomy} onChange={(e) => set({ autonomy: e.target.value as Team['autonomy'] })}>
              {(['read', 'edit', 'full'] as const).map((a) => <option key={a} value={a}>{t(`autonomy_${a}`)}</option>)}
            </select>
          </label>
          <div className="grid2">
            <label>{t('workflow')}
              <select value={team.workflow} onChange={(e) => set({ workflow: e.target.value as Team['workflow'] })}>
                {(['free', 'superpowers'] as const).map((w) => <option key={w} value={w}>{t(`workflow_${w}`)}</option>)}
              </select>
            </label>
            <label>{t('maxRounds')}<input type="number" min={1} max={30} value={team.maxRounds} onChange={(e) => set({ maxRounds: Math.max(1, Math.min(30, Number(e.target.value) || 1)) })} /></label>
          </div>
        </div>
        <div className="grid2">
          <label>{t('budgetUsd')}<input type="number" min={0} step={1} value={team.budget.dailyUsd} onChange={(e) => set({ budget: { ...team.budget, dailyUsd: Math.max(0, Number(e.target.value) || 0) } })} /></label>
          <label>{t('budgetTokens')}<input type="number" min={0} step={100000} value={team.budget.dailyTokens} onChange={(e) => set({ budget: { ...team.budget, dailyTokens: Math.max(0, Number(e.target.value) || 0) } })} /></label>
        </div>
        <p className="hint">{t('budgetHint')}</p>
        <label>{t('stack')}<input value={team.stack} onChange={(e) => set({ stack: e.target.value })} placeholder={t('stackPlaceholder')} /></label>
        <div className="rules">
          <fieldset><legend>{t('askFirst')}</legend>
            <label className="check"><input type="checkbox" checked={team.approvals.edits} onChange={(e) => set({ approvals: { ...team.approvals, edits: e.target.checked } })} />{t('askEdits')}</label>
            <label className="check"><input type="checkbox" checked={team.approvals.commands} onChange={(e) => set({ approvals: { ...team.approvals, commands: e.target.checked } })} />{t('askCommands')}</label>
            <p className="hint">{t('askHint')}</p>
            <div className="rules-list">
              <span className="label">{t('rules')}</span>
              {team.rules.map((r, i) => (
                <div className="row" key={r.id}>
                  <select value={r.kind} onChange={(e) => set({ rules: team.rules.map((x, j) => (j === i ? { ...x, kind: e.target.value as typeof r.kind } : x)) })} style={{ width: 110 }}>
                    <option value="command">{t('ruleCommand')}</option><option value="edit">{t('ruleEdit')}</option></select>
                  <input className="grow mono" value={r.pattern} placeholder={r.kind === 'command' ? 'git push*' : 'src/*'} onChange={(e) => set({ rules: team.rules.map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)) })} />
                  <select value={r.action} onChange={(e) => set({ rules: team.rules.map((x, j) => (j === i ? { ...x, action: e.target.value as typeof r.action } : x)) })} style={{ width: 90 }}>
                    <option value="allow">{t('allow')}</option><option value="ask">{t('ask')}</option><option value="deny">{t('deny')}</option></select>
                  <button className="ghost" onClick={() => set({ rules: team.rules.filter((_, j) => j !== i) })}>×</button>
                </div>
              ))}
              <button className="ghost" onClick={() => set({ rules: [...team.rules, { id: uid(), kind: 'command', pattern: '', action: 'deny' }] })}>+ {t('addRule')}</button>
              <p className="hint">{t('rulesHint')}</p>
            </div>
            <label className="check"><input type="checkbox" checked={team.clarify} onChange={(e) => set({ clarify: e.target.checked })} />{t('clarify')}</label>
          </fieldset>
          <fieldset><legend>Git</legend>
            {(['worktrees', 'reviewBeforeMerge', 'requireCheck', 'openPr'] as const).map((k) => (
              <label className="check" key={k}><input type="checkbox" checked={team.git[k]} disabled={k !== 'worktrees' && !team.git.worktrees}
                onChange={(e) => set({ git: { ...team.git, [k]: e.target.checked } })} />{t(`git_${k}` as TKey)}</label>
            ))}
            <label className="check"><input type="checkbox" checked={team.isolation === 'docker'} onChange={(e) => set({ isolation: e.target.checked ? 'docker' : 'none' })} />{t('isolationDocker')}</label>
          </fieldset>
        </div>
        <fieldset className="saving"><legend>{t('savingTitle')}</legend>
          <div className="grid2">
            <label title={t('routingHint')}>{t('routing')}
              <select value={team.routing} onChange={(e) => set({ routing: e.target.value as Team['routing'] })}>
                <option value="auto">{t('routingAuto')}</option><option value="team">{t('routingTeam')}</option>
              </select>
            </label>
            <label>{t('quickAgent')}
              <select value={team.quickAgentId ?? ''} onChange={(e) => set({ quickAgentId: e.target.value || undefined })} disabled={team.routing === 'team'}>
                <option value="">{t('quickAgentLead')}</option>
                {team.agents.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.provider}{a.model ? ` · ${a.model}` : ''}</option>)}
              </select>
            </label>
          </div>
          <p className="hint">{t('savingHint')}</p>
        </fieldset>
        <MemoryEditor team={team} onToggle={(memory) => set({ memory })} />
        <McpEditor servers={team.mcp} docker={team.isolation === 'docker'} onChange={(mcp) => set({ mcp })} />
        <h3>{t('agents')}</h3>
        {!hasLead && team.agents.length > 1 && <div className="warn">{t('needsLead')}</div>}
        <div className="agent-cards">
          {team.agents.map((a, i) => (
            <AgentCard key={a.id} agent={a} providers={providers} skills={skills}
              onChange={(next) => set({ agents: team.agents.map((x, j) => (j === i ? next : x)) })}
              onRemove={() => set({ agents: team.agents.filter((_, j) => j !== i) })} />
          ))}
        </div>
        <button onClick={() => set({ agents: [...team.agents, newAgent(hasLead ? 'coder' : 'manager', team.agents.map((a) => a.name))] })}>+ {t('addAgent')}</button>
        <div className="actions">
          {team.id && <button className="ghost danger-text" onClick={() => { if (confirm(t('confirmDelete'))) onDelete(team.id); }}>{t('deleteTeam')}</button>}
          {team.id && <button className="ghost" onClick={() => onSave({ ...titled(), id: '', name: `${team.name} (${t('copy')})`, agents: titled().agents.map((a) => ({ ...a, id: uid() })) })}>{t('duplicate')}</button>}
          <span className="grow" />
          <button onClick={onClose}>{t('cancel')}</button>
          <button className="primary" disabled={!team.name.trim() || !team.agents.length} onClick={() => onSave(titled())}>{t('save')}</button>
        </div>
      </div>
    </div>
  );
}
