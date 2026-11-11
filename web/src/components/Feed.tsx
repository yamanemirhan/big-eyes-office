import type React from 'react';
import { useEffect, useRef } from 'react';
import type { Run, RunEvent } from '../../../shared/types.ts';
import { useI18n } from '../i18n.tsx';
import { PALETTE } from './Character.tsx';
import { withoutRepeats } from '../lib/run.ts';
import { api } from '../api.ts';

export function Feed({ run }: { run: Run | undefined }) {
  const { t } = useI18n();
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const count = run?.events.length ?? 0;

  useEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 240) end.current?.scrollIntoView({ block: 'end' });
  }, [count]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [run?.id]);

  if (!run) return <div className="feed empty">{t('noRuns')}</div>;

  const agent = (id?: string) => run.team.agents.find((a) => a.id === id);
  const Name = ({ id }: { id?: string }) => {
    const a = agent(id);
    const p = a ? PALETTE[a.look.color % PALETTE.length] : undefined;
    return <b className="agent-name" style={{ '--agent-ink': p?.ink, '--agent-body': p?.body } as React.CSSProperties}>{a?.name ?? '?'}</b>;
  };

  const row = (e: RunEvent) => {
    switch (e.type) {
      case 'user': return (
        <div className="ev user"><b>{t('you')}</b>{e.toAgentId && <> → <Name id={e.toAgentId} /></>}<p>{e.text}</p>
          {!!e.files?.length && <div className="thumbs">{e.files.map((f) => (/\.(png|jpe?g|gif|webp)$/i.test(f)
            ? <a key={f} href={api.uploadUrl(f)} target="_blank" rel="noreferrer"><img src={api.uploadUrl(f)} alt={f.split(/[\\/]/).pop()} /></a>
            : <span key={f} className="chip">{f.split(/[\\/]/).pop()}</span>))}</div>}
        </div>);
      case 'note': return <div className="ev note">{e.agentId && <Name id={e.agentId} />} {/branch|merge|worktree|pull request/i.test(e.text) && <code>git</code>} <span>{e.text}</span></div>;
      case 'route': return <div className={`ev route ${e.mode}`}><b>{e.mode === 'quick' ? t('routeQuick') : e.escalated ? t('routeEscalated') : t('routeTeam')}</b> <span>{e.reason}</span></div>;
      case 'memory': return <div className="ev memory"><b>{t('memorySaved')}</b><ul>{e.added.map((l, i) => <li key={i}>{l}</li>)}</ul></div>;
      case 'question': return e.question.status !== 'answered' ? null : (
        <div className="ev handoff"><Name id={e.agentId} /> <em>{t('asked')}</em>
          {e.question.items.map((q, i) => <p key={i}>{q.question}{'\n'}<b>→ {e.question.answers?.[i]}</b></p>)}</div>);
      case 'approval': return e.approval.status === 'pending' ? null
        : <div className={`ev check ${e.approval.status === 'allowed' ? 'ok' : 'bad'}`}><b>{e.approval.status === 'allowed' ? t('approved') : t('denied')}</b> <span>{e.approval.title}</span></div>;
      case 'message':
        if (e.kind === 'final') return <div className="ev final"><span className="tag">{t('result')}</span><Name id={e.agentId} /><p>{e.text}</p></div>;
        return <div className={`ev msg ${e.kind}`}><Name id={e.agentId} /><p>{e.text}</p></div>;
      case 'tool': return <div className="ev tool"><Name id={e.agentId} /> <code>{e.tool}</code> <span>{e.detail}</span></div>;
      case 'delegate': return <div className="ev handoff"><Name id={e.agentId} /> → <Name id={e.toAgentId} /> <em>{t('delegates')}</em><p>{e.task}</p></div>;
      case 'report': return <div className="ev handoff report"><Name id={e.agentId} /> → <Name id={e.toAgentId} /> <em>{t('reports')}</em><p>{e.text}</p></div>;
      case 'check': return <div className={`ev check ${e.ok ? 'ok' : 'bad'}`}><b>{e.ok ? t('checkPassed') : t('checkFailed')}</b> <span>({t('attempt')} {e.attempt})</span>{!e.ok && <pre>{e.output}</pre>}</div>;
      case 'error': return <div className="ev error">{e.agentId && <Name id={e.agentId} />} <p>{e.message}</p></div>;
      case 'usage': return <div className="ev usage"><Name id={e.agentId} /> {e.inputTokens.toLocaleString()} in{e.cachedTokens ? ` (+${e.cachedTokens.toLocaleString()} cached)` : ''} · {e.outputTokens.toLocaleString()} out{e.costUsd != null ? ` · $${e.costUsd.toFixed(3)}` : ''}</div>;
      default: return null;
    }
  };

  return (
    <div className="feed" ref={box}>
      {withoutRepeats(run.events).map((e) => { const r = row(e); return r && <div key={e.seq}>{r}</div>; })}
      <div ref={end} />
    </div>
  );
}
