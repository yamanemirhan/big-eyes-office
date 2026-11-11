import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentConfig, AgentState, ExternalSession, Run, Team } from '../../../shared/types.ts';
import { useI18n } from '../i18n.tsx';
import { setAudio, sfx, useAudio, type Sound } from '../lib/audio.ts';
import { Character, PRESETS } from './Character.tsx';

interface Actor { state: AgentState; detail?: string; at: string | null; bubble: string | null }
interface Point { x: number; y: number }
const IDLE: Actor = { state: 'idle', at: null, bubble: null };
const W = 1000;
const WALL = 124;
const WALK_MS = 1100;
const VISIT_MS = 3600;
const INK = '#2b2622';

const clip = (s: string, n = 70) => { const one = s.replace(/\s+/g, ' ').trim(); return one.length > n ? `${one.slice(0, n - 1)}…` : one; };

function layout(team: Team) {
  const lead = team.agents.find((a) => a.role === 'manager') ?? team.agents[0];
  const rest = team.agents.filter((a) => a.id !== lead?.id);
  const desks: Record<string, Point> = {};
  if (!lead) return { desks, height: 460 };
  if (!rest.length) { desks[lead.id] = { x: W / 2, y: 270 }; return { desks, height: 460 }; }
  desks[lead.id] = { x: W / 2, y: 196 };
  const perRow = rest.length <= 5 ? rest.length : Math.ceil(rest.length / 2);
  rest.forEach((a, i) => {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, rest.length - row * perRow);
    const col = i - row * perRow;
    desks[a.id] = { x: 110 + ((W - 220) / (inRow + 1)) * (col + 1), y: 410 + row * 170 };
  });
  return { desks, height: rest.length > perRow ? 760 : 590 };
}

/** Furniture you can drag around. Positions are remembered per team in this browser. */
const PROPS: Record<string, { home: (h: number) => Point; sound: Sound }> = {
  plant: { home: () => ({ x: 940, y: 210 }), sound: 'rustle' },
  coffee: { home: () => ({ x: 70, y: 250 }), sound: 'coffee' },
  radio: { home: () => ({ x: 790, y: 232 }), sound: 'switch' },
  cooler: { home: (h) => ({ x: 950, y: h - 60 }), sound: 'water' },
  lamp: { home: () => ({ x: 345, y: 240 }), sound: 'switch' },
  cat: { home: (h) => ({ x: 80, y: h - 50 }), sound: 'meow' },
};

function useLayoutStore(teamId: string) {
  const key = `beo.office.${teamId}`;
  const [moved, setMoved] = useState<Record<string, Point>>({});
  useEffect(() => {
    try { setMoved(JSON.parse(localStorage.getItem(key) ?? '{}')); } catch { setMoved({}); }
  }, [key]);
  const move = (id: string, p: Point) => setMoved((prev) => {
    const next = { ...prev, [id]: p };
    localStorage.setItem(key, JSON.stringify(next));
    return next;
  });
  const reset = () => { localStorage.removeItem(key); setMoved({}); };
  return { moved, move, reset };
}

function useActors(team: Team, run: Run | undefined) {
  const [actors, setActors] = useState<Record<string, Actor>>({});
  const cursor = useRef({ key: '', seq: 0 });
  const timers = useRef<number[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  useEffect(() => {
    const events = run?.events ?? [];
    const key = `${team.id}:${run?.id ?? ''}`;
    if (cursor.current.key !== key) {
      timers.current.forEach(clearTimeout);
      timers.current = [];
      const init: Record<string, Actor> = {};
      if (run?.status === 'running') {
        for (const e of events) if (e.type === 'agent_state' && e.agentId) init[e.agentId] = { ...IDLE, state: e.state, detail: e.detail };
      }
      cursor.current = { key, seq: events.length };
      setActors(init);
      return;
    }
    const fresh = events.slice(cursor.current.seq);
    if (!fresh.length) return;
    cursor.current.seq = events.length;

    const patch = (id: string, change: Partial<Actor>) => setActors((prev) => ({ ...prev, [id]: { ...(prev[id] ?? IDLE), ...change } }));
    for (const e of fresh) {
      if (!e.agentId) continue;
      const id = e.agentId;
      if (e.type === 'agent_state') patch(id, { state: e.state, detail: e.detail });
      else if (e.type === 'delegate' || e.type === 'report') {
        patch(id, { at: e.toAgentId, bubble: clip(e.type === 'delegate' ? e.task : e.text) });
        timers.current.push(window.setTimeout(() => patch(id, { at: null, bubble: null }), VISIT_MS));
      }
    }
  }, [team.id, run?.id, run?.events.length, run?.status]);

  return actors;
}

/** Drag with the pointer; a press without movement counts as a click. */
function Draggable({ pos, minY, maxY, onMove, onClick, label, children }: {
  pos: Point; minY: number; maxY: number; onMove: (p: Point) => void; onClick?: () => void; label: string; children: ReactNode;
}) {
  const drag = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  const [held, setHeld] = useState(false);
  const toSvg = (e: React.PointerEvent<SVGGElement>) => {
    const svg = e.currentTarget.ownerSVGElement!;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  };
  return (
    <g className={`prop${held ? ' held' : ''}`} transform={`translate(${pos.x},${pos.y})`} role="button" tabIndex={0} aria-label={label}
      onKeyDown={(e) => e.key === 'Enter' && onClick?.()}
      onPointerDown={(e) => { const p = toSvg(e); drag.current = { dx: p.x - pos.x, dy: p.y - pos.y, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const p = toSvg(e);
        const next = { x: Math.max(40, Math.min(W - 40, p.x - d.dx)), y: Math.max(minY, Math.min(maxY, p.y - d.dy)) };
        if (!d.moved && Math.hypot(next.x - pos.x, next.y - pos.y) < 5) return;
        if (!d.moved) { d.moved = true; setHeld(true); sfx('pick'); }
        onMove(next);
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        setHeld(false);
        if (d?.moved) sfx('drop'); else onClick?.();
      }}>
      <title>{label}</title>
      {children}
    </g>
  );
}

function DeskArt({ active, lead }: { active: boolean; lead: boolean }) {
  return (
    <g>
      <ellipse cx="0" cy="18" rx="82" ry="9" fill="rgba(60,40,20,0.12)" />
      <rect x="-8" y="-58" width="16" height="22" fill="#6b625a" />
      <rect x="-38" y="-92" width="76" height="46" rx="6" fill="#3d3833" />
      <rect className={active ? 'screen on' : 'screen'} x="-33" y="-87" width="66" height="36" rx="3" />
      <rect x="-74" y="-38" width="148" height="20" rx="8" fill={lead ? '#c98f5a' : '#dcae7c'} stroke={INK} strokeWidth="2.5" />
      <rect x="-64" y="-18" width="10" height="34" rx="3" fill="#a9794c" /><rect x="54" y="-18" width="10" height="34" rx="3" fill="#a9794c" />
      <rect x="44" y="-50" width="14" height="12" rx="3" fill="#fff" stroke={INK} strokeWidth="2" />
      {lead && <path d="M-62,-38 l6,-12 h14 l6,12 z" fill="#f2c14e" stroke={INK} strokeWidth="2" />}
    </g>
  );
}

function PropArt({ id, on, dark }: { id: string; on: boolean; dark: boolean }) {
  switch (id) {
    case 'plant': return (
      <g><ellipse cx="0" cy="2" rx="22" ry="5" fill="rgba(60,40,20,0.14)" />
        <g className={on ? 'wiggle' : ''}><path d="M0,-30 Q-26,-56 -14,-86 Q-2,-60 0,-36 Q8,-70 24,-80 Q22,-52 4,-32 Z" fill="#5fae6e" stroke={INK} strokeWidth="2" />
          <path d="M-2,-32 Q-30,-40 -34,-62 Q-14,-56 -2,-36 Z" fill="#7cc487" stroke={INK} strokeWidth="2" /></g>
        <path d="M-15,-32 H15 L10,0 H-10 Z" fill="#d98c5f" stroke={INK} strokeWidth="2" /></g>);
    case 'coffee': return (
      <g><ellipse cx="0" cy="2" rx="30" ry="6" fill="rgba(60,40,20,0.14)" />
        <rect x="-26" y="-34" width="52" height="34" rx="4" fill="#b08a64" stroke={INK} strokeWidth="2" />
        <rect x="-18" y="-78" width="36" height="46" rx="6" fill="#4a4540" stroke={INK} strokeWidth="2" />
        <rect x="-10" y="-70" width="20" height="10" rx="2" fill={on ? '#ffb347' : '#8fe3a4'} />
        <rect x="-7" y="-46" width="14" height="12" rx="2" fill="#fff" stroke={INK} strokeWidth="2" />
        {on && <g className="steam" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round"><path d="M-4,-52 q-5,-8 0,-14" /><path d="M5,-52 q5,-8 0,-16" /></g>}</g>);
    case 'radio': return (
      <g><ellipse cx="0" cy="2" rx="30" ry="6" fill="rgba(60,40,20,0.14)" />
        <rect x="-24" y="-30" width="48" height="30" rx="4" fill="#b08a64" stroke={INK} strokeWidth="2" />
        <rect x="-28" y="-62" width="56" height="34" rx="8" fill="#e2574c" stroke={INK} strokeWidth="2.5" />
        <circle cx="-12" cy="-45" r="9" fill="#3d3833" /><circle cx="-12" cy="-45" r="3.5" fill="#8a817a" />
        <rect x="4" y="-54" width="18" height="6" rx="2" fill="#fffdf7" /><circle cx="9" cy="-40" r="3" fill="#fffdf7" /><circle cx="18" cy="-40" r="3" fill="#fffdf7" />
        <line x1="20" y1="-62" x2="34" y2="-84" stroke={INK} strokeWidth="2.5" strokeLinecap="round" />
        {on && <g className="notes" fill={dark ? '#ffd9a0' : INK}><text x="-34" y="-70" fontSize="18">♪</text><text x="2" y="-78" fontSize="15">♫</text></g>}</g>);
    case 'cooler': return (
      <g><ellipse cx="0" cy="2" rx="22" ry="5" fill="rgba(60,40,20,0.14)" />
        <rect x="-17" y="-52" width="34" height="52" rx="5" fill="#eef3f5" stroke={INK} strokeWidth="2" />
        <rect x="-13" y="-92" width="26" height="42" rx="9" fill="#9fd4f0" stroke={INK} strokeWidth="2" opacity="0.9" />
        {on && <g className="steam" fill="#fff"><circle cx="-3" cy="-66" r="3" /><circle cx="5" cy="-76" r="2.2" /></g>}
        <rect x="-8" y="-38" width="6" height="8" rx="1" fill="#5c9ded" /><rect x="3" y="-38" width="6" height="8" rx="1" fill="#e2574c" /></g>);
    case 'lamp': return (
      <g><ellipse cx="0" cy="2" rx="20" ry="5" fill="rgba(60,40,20,0.14)" />
        {dark && <ellipse cx="0" cy="-10" rx="90" ry="34" fill="#ffe49a" opacity="0.28" />}
        <rect x="-14" y="-6" width="28" height="6" rx="3" fill="#4a4540" /><rect x="-2.5" y="-96" width="5" height="92" fill="#4a4540" />
        <path d="M-22,-96 L-14,-128 H14 L22,-96 Z" fill={dark ? '#ffe49a' : '#f5ecd8'} stroke={INK} strokeWidth="2.5" /></g>);
    case 'cat': return (
      <g className={on ? 'hop' : ''}><ellipse cx="0" cy="2" rx="24" ry="5" fill="rgba(60,40,20,0.14)" />
        <path className="tail" d="M18,-10 q20,-4 14,-26" fill="none" stroke="#f2a65a" strokeWidth="7" strokeLinecap="round" />
        <ellipse cx="0" cy="-12" rx="22" ry="14" fill="#f2a65a" stroke={INK} strokeWidth="2" />
        <circle cx="-14" cy="-28" r="14" fill="#f2a65a" stroke={INK} strokeWidth="2" />
        <path d="M-25,-36 l-2,-14 l11,7 z M-4,-36 l3,-14 l-11,7 z" fill="#f2a65a" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
        <g className="eyes"><ellipse cx="-19" cy="-29" rx="4.5" ry="5.5" fill="#fff" stroke={INK} strokeWidth="1.5" /><ellipse cx="-8" cy="-29" rx="4.5" ry="5.5" fill="#fff" stroke={INK} strokeWidth="1.5" />
          <circle cx="-18.5" cy="-28.5" r="2.6" fill={INK} /><circle cx="-7.5" cy="-28.5" r="2.6" fill={INK} /></g>
        <path d="M-15,-22 l1.5,2 l1.5,-2 z" fill="#d6453a" /></g>);
    default: return null;
  }
}

function Sprite({ agent, actor, home, target, side, index, selected, onSelect }: {
  agent: AgentConfig; actor: Actor; home: Point; target: Point; side: number; index: number; selected: boolean; onSelect: () => void;
}) {
  const { t } = useI18n();
  const last = useRef(target);
  const [walk, setWalk] = useState({ on: false, facing: 0 });

  useEffect(() => {
    const dx = target.x - last.current.x;
    const dy = target.y - last.current.y;
    last.current = target;
    if (Math.hypot(dx, dy) < 30) return; // Small moves happen while the desk is being dragged.
    setWalk({ on: true, facing: Math.sign(dx) });
    const timer = window.setTimeout(() => setWalk((w) => ({ ...w, on: false })), WALK_MS);
    return () => clearTimeout(timer);
  }, [target.x, target.y]);

  // A big jump is a walk; small ones are the desk being dragged and should follow the pointer at once.
  const far = Math.hypot(target.x - last.current.x, target.y - last.current.y) >= 30;
  const visiting = actor.at !== null;
  const state: AgentState = visiting ? 'talking' : actor.state;
  const away = target.x !== home.x || target.y !== home.y;
  // While visiting, stand beside the other desk and look toward its owner.
  const facing = walk.on ? walk.facing : visiting ? -side : 0;
  const label = state === 'idle' ? agent.roleTitle : `${t(`state_${state}`)}${actor.detail && !visiting ? ` · ${actor.detail}` : ''}`;

  return (
    <>
      <g transform={`translate(${home.x},${home.y + 24})`} className={`nametag clickable${selected ? ' selected' : ''}`} onClick={onSelect}>
        <rect x="-70" y="-15" width="140" height="52" rx="10" className="nametag-bg" />
        <text className="nametag-name" textAnchor="middle" y="0">{agent.name}</text>
        <text className={`nametag-sub${state !== 'idle' ? ' busy' : ''}`} textAnchor="middle" y="17">{clip(label, 34)}</text>
        <text className="nametag-model" textAnchor="middle" y="32">{agent.model || agent.provider}{agent.effort !== 'default' ? ` · ${agent.effort}` : ''}</text>
      </g>
      <g className="sprite clickable" role="button" tabIndex={0} aria-label={agent.name} onClick={onSelect} onKeyDown={(e) => e.key === 'Enter' && onSelect()}
        style={{ transform: `translate(${target.x}px, ${target.y}px)`, transitionDuration: walk.on || far ? `${WALK_MS}ms` : '0ms' }}>
        {selected && <ellipse cx="0" cy="2" rx="40" ry="11" className="select-ring" />}
        <Character look={agent.look} state={state} walking={walk.on} facing={facing} seed={index} />
        {actor.bubble && !walk.on && away && (
          <foreignObject x={-95 + side * 60} y="-196" width="190" height="74">
            <div className="bubble">{actor.bubble}</div>
          </foreignObject>
        )}
      </g>
    </>
  );
}

/** Your own Claude Code and Codex sessions visit the office: they sit on the bench and show what they are doing. */
function Guests({ guests, height, onOpen }: { guests: ExternalSession[]; height: number; onOpen: () => void }) {
  const { t } = useI18n();
  const shown = guests.filter((g) => g.state !== 'idle').slice(0, 6);
  if (!shown.length) return null;
  const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const state: Record<ExternalSession['state'], AgentState> = { working: 'thinking', waiting: 'waiting', done: 'idle', idle: 'idle' };
  return (
    <g className="guests clickable" transform={`translate(${Math.round((W - shown.length * 78) / 2)},${height - 20})`} onClick={onOpen} role="button" tabIndex={0}>
      <rect x="-10" y="-8" width={shown.length * 78 + 12} height="14" rx="7" className="bench" />
      {shown.map((g, i) => (
        <g key={g.id} transform={`translate(${i * 78 + 34},0)`}>
          <title>{`${g.tool === 'claude' ? 'Claude Code' : 'Codex'} · ${t(`ext_${g.state}` as any)}\n${g.title}\n${g.cwd}`}</title>
          <circle cy="-40" r="34" className={`guest-halo ${g.state}`} />
          <g transform="scale(0.42)"><Character look={PRESETS[hash(g.id) % PRESETS.length].look} state={state[g.state]} seed={i} /></g>
          <text y="20" textAnchor="middle" className="guest-label">{g.tool === 'claude' ? 'Claude' : 'Codex'}</text>
        </g>
      ))}
    </g>
  );
}

export function Office({ team, run, selected, onSelect, dark, onToggleLight, guests = [], onGuests }: {
  team: Team; run: Run | undefined; selected: string | null; onSelect: (id: string) => void; dark: boolean; onToggleLight: () => void;
  guests?: ExternalSession[]; onGuests?: () => void;
}) {
  const { t } = useI18n();
  const actors = useActors(team, run);
  const audio = useAudio();
  const { moved, move, reset } = useLayoutStore(team.id);
  const [poked, setPoked] = useState<Record<string, number>>({});
  const base = layout(team);
  // Visitors (your own Claude Code / Codex sessions) get their own strip of floor below the desks.
  const height = base.height + (guests.some((g) => g.state !== 'idle') ? 80 : 0);
  const desks: Record<string, Point> = Object.fromEntries(Object.entries(base.desks).map(([id, p]) => [id, moved[`desk:${id}`] ?? p]));
  const leadId = (team.agents.find((a) => a.role === 'manager') ?? team.agents[0])?.id;
  const home = (id: string) => ({ x: desks[id].x, y: desks[id].y + 56 });

  const poke = (id: string) => {
    sfx(PROPS[id].sound);
    setPoked((p) => ({ ...p, [id]: Date.now() }));
    window.setTimeout(() => setPoked((p) => (Date.now() - (p[id] ?? 0) >= 1400 ? { ...p, [id]: 0 } : p)), 1500);
    if (id === 'radio') setAudio({ music: !audio.music });
    if (id === 'lamp') onToggleLight();
  };

  return (
    <svg className={`office${dark ? ' night' : ''}`} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`${team.name} office`}>
      <defs>
        <pattern id="floor" width="80" height="80" patternUnits="userSpaceOnUse">
          <rect width="80" height="80" className="floor-tile" /><path d="M0,0 H80 M0,0 V80" className="floor-line" strokeWidth="2" />
        </pattern>
      </defs>
      <rect width={W} height={WALL} className="wall" />
      <rect y={WALL - 8} width={W} height="10" className="trim" />
      <rect y={WALL + 2} width={W} height={height - WALL - 2} fill="url(#floor)" />
      <ellipse cx={W / 2} cy={height * 0.62} rx="330" ry={height * 0.2} className="rug" />

      <g transform="translate(90,22)">
        <rect width="150" height="76" rx="6" fill="#fff" stroke={INK} strokeWidth="2.5" />
        <rect x="6" y="6" width="138" height="64" rx="3" className="sky" />
        {dark ? (<g><circle cx="112" cy="26" r="10" fill="#f5ecd8" /><circle cx="107" cy="23" r="9" className="sky" />
          {[[24, 20], [48, 44], [70, 18], [90, 52], [30, 56]].map(([x, y]) => <circle key={x} className="star" cx={x} cy={y} r="1.6" fill="#fff" />)}</g>)
          : (<g><circle cx="112" cy="24" r="9" fill="#ffe49a" /><ellipse className="cloud" cx="44" cy="30" rx="18" ry="7" fill="#fff" /></g>)}
        <path d="M75,6 V70 M6,38 H144" stroke="#fff" strokeWidth="4" />
      </g>

      <g className="clickable" role="button" tabIndex={0} aria-label={t('lights')} transform="translate(300,54)"
        onClick={() => { sfx('switch'); onToggleLight(); }} onKeyDown={(e) => e.key === 'Enter' && onToggleLight()}>
        <title>{t('lights')}</title>
        <rect x="-13" y="-19" width="26" height="38" rx="5" fill="#fffdf7" stroke={INK} strokeWidth="2.5" />
        <rect x="-5" y={dark ? 1 : -11} width="10" height="12" rx="2" fill={dark ? '#8a817a' : '#f2c14e'} stroke={INK} strokeWidth="1.5" />
      </g>

      <g transform={`translate(${W - 250},20)`}>
        <rect width="170" height="80" rx="6" fill="#fffdf7" stroke={INK} strokeWidth="2.5" />
        <text x="85" y="34" textAnchor="middle" className="board-title">{clip(team.name, 18)}</text>
        <text x="85" y="56" textAnchor="middle" className="board-sub">{team.agents.length} agents · {team.workflow}</text>
      </g>
      <g transform="translate(470,34)"><circle r="20" fill="#fffdf7" stroke={INK} strokeWidth="2.5" /><line className="clock-hand" x1="0" y1="0" x2="0" y2="-13" stroke={INK} strokeWidth="2.5" strokeLinecap="round" /><line x1="0" y1="0" x2="8" y2="4" stroke={INK} strokeWidth="2.5" strokeLinecap="round" /></g>

      {Object.entries(PROPS).filter(([id]) => (moved[id] ?? PROPS[id].home(height)).y < 300).map(([id, p]) => (
        <Draggable key={id} label={t(`prop_${id}` as any)} pos={moved[id] ?? p.home(height)} minY={WALL + 60} maxY={height - 20} onMove={(pt) => move(id, pt)} onClick={() => poke(id)}>
          <PropArt id={id} on={id === 'radio' ? audio.music : !!poked[id]} dark={dark} />
        </Draggable>
      ))}
      {team.agents.map((a) => desks[a.id] && (
        <Draggable key={a.id} label={`${a.name} desk`} pos={desks[a.id]} minY={WALL + 70} maxY={height - 110} onMove={(pt) => move(`desk:${a.id}`, pt)}>
          <DeskArt lead={a.id === leadId} active={['writing', 'running', 'reading', 'searching', 'thinking', 'waiting'].includes((actors[a.id] ?? IDLE).state)} />
        </Draggable>
      ))}
      {team.agents.map((a, i) => {
        if (!desks[a.id]) return null;
        const actor = actors[a.id] ?? IDLE;
        const h = home(a.id);
        const host = actor.at && desks[actor.at] ? home(actor.at) : null;
        const side = host && h.x > host.x ? 1 : -1;
        const visit = host ? { x: host.x + side * 78, y: host.y + 6 } : h;
        return <Sprite key={a.id} agent={a} actor={actor} home={h} target={visit} side={side} index={i} selected={selected === a.id} onSelect={() => onSelect(a.id)} />;
      })}
      {Object.entries(PROPS).filter(([id]) => (moved[id] ?? PROPS[id].home(height)).y >= 300).map(([id, p]) => (
        <Draggable key={id} label={t(`prop_${id}` as any)} pos={moved[id] ?? p.home(height)} minY={WALL + 60} maxY={height - 20} onMove={(pt) => move(id, pt)} onClick={() => poke(id)}>
          <PropArt id={id} on={id === 'radio' ? audio.music : !!poked[id]} dark={dark} />
        </Draggable>
      ))}
      <Guests guests={guests} height={height} onOpen={() => onGuests?.()} />
      {Object.keys(moved).length > 0 && (
        <g className="clickable reset" transform={`translate(${W - 92},${height - 24})`} role="button" tabIndex={0} onClick={reset} onKeyDown={(e) => e.key === 'Enter' && reset()}>
          <rect x="-4" y="-14" width="90" height="20" rx="6" /><text x="41" y="0" textAnchor="middle">{t('resetLayout')}</text>
        </g>
      )}
    </svg>
  );
}
