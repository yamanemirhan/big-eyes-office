import type { AgentState, Look } from '../../../shared/types.ts';

export const PALETTE = [
  { body: '#ff8a65', head: '#ffc9b5', ink: '#8a3b22' },
  { body: '#4db6ac', head: '#b9e6e0', ink: '#1f5f58' },
  { body: '#5c9ded', head: '#c3dcfa', ink: '#234f8a' },
  { body: '#9ccc65', head: '#d9eebf', ink: '#44691c' },
  { body: '#ba8fe0', head: '#e4d3f5', ink: '#5a3285' },
  { body: '#f2c14e', head: '#fae7b0', ink: '#7d5a0c' },
  { body: '#f48fb1', head: '#fbd3e0', ink: '#8c2f52' },
  { body: '#90a4ae', head: '#d5dee2', ink: '#3d4f57' },
];
export const HAIRS: Look['hair'][] = ['none', 'tuft', 'spiky', 'bun', 'bob', 'curls'];
export const GLASSES: Look['glasses'][] = ['none', 'round', 'square'];
export const ACCESSORIES: Look['accessory'][] = ['none', 'headphones', 'cap', 'bow', 'antenna'];
export const HAIR_COLORS = ['#3b2f2f', '#1f3b57', '#6b3fa0', '#7a4b1d', '#2f4f2f', '#c0392b', '#e8d27a', '#f5f5f5'];

const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];
export const randomLook = (): Look => ({
  color: Math.floor(Math.random() * PALETTE.length),
  hair: pick(HAIRS), hairColor: pick(HAIR_COLORS),
  glasses: Math.random() < 0.45 ? pick(GLASSES.slice(1)) : 'none',
  accessory: Math.random() < 0.4 ? pick(ACCESSORIES.slice(1)) : 'none',
});

/** The ten standard characters offered when building a team. */
export const PRESETS: { name: string; look: Look }[] = [
  { name: 'Mila', look: { color: 0, hair: 'bun', hairColor: '#3b2f2f', glasses: 'round', accessory: 'none' } },
  { name: 'Bolt', look: { color: 2, hair: 'spiky', hairColor: '#1f3b57', glasses: 'none', accessory: 'headphones' } },
  { name: 'Iris', look: { color: 4, hair: 'bob', hairColor: '#6b3fa0', glasses: 'square', accessory: 'none' } },
  { name: 'Otto', look: { color: 5, hair: 'tuft', hairColor: '#7a4b1d', glasses: 'round', accessory: 'bow' } },
  { name: 'Pip', look: { color: 3, hair: 'curls', hairColor: '#2f4f2f', glasses: 'none', accessory: 'antenna' } },
  { name: 'Nox', look: { color: 7, hair: 'none', hairColor: '#3b2f2f', glasses: 'square', accessory: 'cap' } },
  { name: 'Juno', look: { color: 6, hair: 'bob', hairColor: '#c0392b', glasses: 'none', accessory: 'bow' } },
  { name: 'Rumi', look: { color: 1, hair: 'curls', hairColor: '#e8d27a', glasses: 'round', accessory: 'none' } },
  { name: 'Kiko', look: { color: 3, hair: 'tuft', hairColor: '#c0392b', glasses: 'square', accessory: 'headphones' } },
  { name: 'Zed', look: { color: 4, hair: 'spiky', hairColor: '#f5f5f5', glasses: 'none', accessory: 'antenna' } },
];
export const sameLook = (a: Look, b: Look) =>
  a.color === b.color && a.hair === b.hair && a.hairColor === b.hairColor && a.glasses === b.glasses && a.accessory === b.accessory;

const INK = '#2b2622';
const EYE_Y = -78;
const EYE_X = 13;

function Hair({ look }: { look: Look }) {
  const c = look.hairColor;
  switch (look.hair) {
    case 'tuft':
      return <path d="M-8,-106 Q-6,-124 2,-110 Q6,-126 12,-106 Z" fill={c} />;
    case 'spiky':
      return <path d="M-30,-88 L-24,-112 L-14,-100 L-6,-120 L4,-102 L14,-118 L20,-100 L30,-108 L31,-86 Q0,-112 -30,-88 Z" fill={c} />;
    case 'bun':
      return (<g fill={c}><circle cx="0" cy="-116" r="11" /><path d="M-32,-80 A33,33 0 0 1 32,-80 Q16,-102 0,-100 Q-16,-102 -32,-80 Z" /></g>);
    case 'bob':
      return <path d="M-34,-56 Q-40,-112 0,-112 Q40,-112 34,-56 Q30,-84 18,-98 Q0,-104 -18,-98 Q-30,-84 -34,-56 Z" fill={c} />;
    case 'curls':
      return (<g fill={c}>{[[-26, -94], [-14, -104], [0, -108], [14, -104], [26, -94]].map(([x, y]) => <circle key={x} cx={x} cy={y} r="10" />)}</g>);
    default:
      return null;
  }
}

function Accessory({ look }: { look: Look }) {
  switch (look.accessory) {
    case 'headphones':
      return (<g><path d="M-34,-78 A34,36 0 0 1 34,-78" fill="none" stroke={INK} strokeWidth="5" strokeLinecap="round" />
        <rect x="-41" y="-88" width="11" height="22" rx="5" fill={INK} /><rect x="30" y="-88" width="11" height="22" rx="5" fill={INK} /></g>);
    case 'cap':
      return (<g><path d="M-31,-88 A32,30 0 0 1 31,-88 Z" fill="#e2574c" /><path d="M8,-90 H44 Q46,-84 38,-83 H8 Z" fill="#b93f36" /></g>);
    case 'bow':
      return (<g fill="#e2574c"><path d="M18,-104 L4,-114 L6,-94 Z" /><path d="M18,-104 L32,-114 L30,-94 Z" /><circle cx="18" cy="-104" r="4.5" fill="#b93f36" /></g>);
    case 'antenna':
      return (<g><line x1="0" y1="-108" x2="0" y2="-128" stroke={INK} strokeWidth="3" strokeLinecap="round" /><circle className="antenna-ball" cx="0" cy="-131" r="5.5" fill="#f2c14e" stroke={INK} strokeWidth="2" /></g>);
    default:
      return null;
  }
}

function Glasses({ look }: { look: Look }) {
  if (look.glasses === 'none') return null;
  const frame = { fill: 'rgba(255,255,255,0.18)', stroke: INK, strokeWidth: 2.6 };
  return (
    <g>
      {look.glasses === 'round'
        ? (<><circle cx={-EYE_X} cy={EYE_Y} r="15.5" {...frame} /><circle cx={EYE_X} cy={EYE_Y} r="15.5" {...frame} /></>)
        : (<><rect x={-EYE_X - 14.5} y={EYE_Y - 14} width="29" height="28" rx="7" {...frame} /><rect x={EYE_X - 14.5} y={EYE_Y - 14} width="29" height="28" rx="7" {...frame} /></>)}
      <path d={`M-3,${EYE_Y - 2} Q0,${EYE_Y - 5} 3,${EYE_Y - 2}`} fill="none" stroke={INK} strokeWidth="2.6" />
    </g>
  );
}

function Prop({ state }: { state: AgentState }) {
  if (state === 'writing' || state === 'running') {
    return (<g><rect x="-21" y="-30" width="42" height="24" rx="4" fill="#4a4540" /><rect x="-17" y="-26" width="34" height="16" rx="2" fill={state === 'running' ? '#1d2b24' : '#eef6ff'} />
      <g className="code-lines" stroke={state === 'running' ? '#6ee7a0' : '#5c9ded'} strokeWidth="2" strokeLinecap="round">
        <line x1="-13" y1="-22" x2="3" y2="-22" /><line x1="-13" y1="-18" x2="10" y2="-18" /><line x1="-13" y1="-14" x2="-2" y2="-14" /></g></g>);
  }
  if (state === 'reading') {
    return (<g transform="rotate(-6)"><rect x="-15" y="-34" width="30" height="30" rx="3" fill="#fffdf7" stroke={INK} strokeWidth="2" />
      <g stroke="#b7ada0" strokeWidth="2" strokeLinecap="round"><line x1="-9" y1="-27" x2="9" y2="-27" /><line x1="-9" y1="-21" x2="9" y2="-21" /><line x1="-9" y1="-15" x2="3" y2="-15" /></g></g>);
  }
  if (state === 'searching') {
    return (<g className="magnifier"><circle cx="24" cy="-34" r="11" fill="rgba(200,230,255,0.55)" stroke={INK} strokeWidth="3" /><line x1="32" y1="-26" x2="42" y2="-15" stroke={INK} strokeWidth="4.5" strokeLinecap="round" /></g>);
  }
  return null;
}

function Badge({ state }: { state: AgentState }) {
  if (state === 'thinking') {
    return (<g className="thought"><circle cx="34" cy="-112" r="4" fill="#fff" stroke={INK} strokeWidth="2" /><rect x="36" y="-146" width="46" height="26" rx="13" fill="#fff" stroke={INK} strokeWidth="2" />
      {[49, 59, 69].map((x, i) => <circle key={x} className="dot" style={{ animationDelay: `${i * 0.18}s` }} cx={x} cy="-133" r="3.2" fill={INK} />)}</g>);
  }
  if (state === 'waiting') {
    return (<g className="pulse"><circle cx="34" cy="-116" r="14" fill="#f2c14e" stroke={INK} strokeWidth="2" />
      <text x="34" y="-110" textAnchor="middle" fontSize="18" fontWeight="800" fill={INK}>?</text></g>);
  }
  if (state === 'done') {
    return (<g className="pop"><circle cx="34" cy="-116" r="13" fill="#57b96a" stroke={INK} strokeWidth="2" /><path d="M27,-116 L32,-110 L41,-122" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" /></g>);
  }
  if (state === 'error') {
    return (<g className="pop"><circle cx="34" cy="-116" r="13" fill="#e2574c" stroke={INK} strokeWidth="2" /><rect x="32.2" y="-124" width="3.6" height="10" rx="1.8" fill="#fff" /><circle cx="34" cy="-109.5" r="2.2" fill="#fff" /></g>);
  }
  return null;
}

const GAZE: Record<AgentState, [number, number]> = {
  idle: [0, 0], waiting: [0, -3], thinking: [3, -5], reading: [0, 5], writing: [0, 5.5], running: [0, 5.5], searching: [4, 3], talking: [0, 1], done: [0, 0], error: [0, 2],
};

export function Character({ look, state = 'idle', walking = false, facing = 0, seed = 0 }: {
  look: Look; state?: AgentState; walking?: boolean; facing?: number; seed?: number;
}) {
  const p = PALETTE[look.color % PALETTE.length];
  const [gx, gy] = walking ? [facing * 4.5, 1] : state === 'talking' ? [facing * 4, 1] : GAZE[state];
  const happy = state === 'done' && !walking;
  const busyHands = !walking && (state === 'writing' || state === 'running');
  const blinkDelay = `${(seed % 7) * 0.6}s`;

  return (
    <g className={`character${walking ? ' walking' : ''} state-${state}`}>
      <ellipse cx="0" cy="2" rx="30" ry="7" fill="rgba(60,40,20,0.16)" />
      <g className="bob">
        <ellipse className="foot foot-l" cx="-11" cy="-3" rx="10" ry="6.5" fill={p.ink} />
        <ellipse className="foot foot-r" cx="11" cy="-3" rx="10" ry="6.5" fill={p.ink} />
        <rect x="-23" y="-50" width="46" height="44" rx="19" fill={p.body} stroke={INK} strokeWidth="2.5" />
        <ellipse cx="0" cy="-24" rx="13" ry="12" fill={p.head} opacity="0.7" />
        <circle className={`hand hand-l${busyHands ? ' typing' : ''}`} cx="-26" cy="-28" r="7.5" fill={p.body} stroke={INK} strokeWidth="2.5" />
        <circle className={`hand hand-r${busyHands ? ' typing' : ''}`} cx="26" cy="-28" r="7.5" fill={p.body} stroke={INK} strokeWidth="2.5" />
        <circle cx="0" cy="-76" r="33" fill={p.head} stroke={INK} strokeWidth="2.5" />
        <Hair look={look} />
        <circle cx="-25" cy="-62" r="5" fill={p.body} opacity="0.45" /><circle cx="25" cy="-62" r="5" fill={p.body} opacity="0.45" />
        {happy ? (
          <g fill="none" stroke={INK} strokeWidth="3.5" strokeLinecap="round">
            <path d={`M${-EYE_X - 9},${EYE_Y + 3} Q${-EYE_X},${EYE_Y - 10} ${-EYE_X + 9},${EYE_Y + 3}`} />
            <path d={`M${EYE_X - 9},${EYE_Y + 3} Q${EYE_X},${EYE_Y - 10} ${EYE_X + 9},${EYE_Y + 3}`} />
          </g>
        ) : (
          <g className="eyes" style={{ animationDelay: blinkDelay }}>
            {[-EYE_X, EYE_X].map((x) => (
              <g key={x}>
                <ellipse cx={x} cy={EYE_Y} rx="12" ry="14" fill="#fff" stroke={INK} strokeWidth="2.2" />
                <g className={state === 'idle' && !walking ? 'pupil wander' : state === 'searching' ? 'pupil scan' : 'pupil'}
                  style={{ transform: `translate(${gx}px, ${gy}px)`, animationDelay: blinkDelay }}>
                  <circle cx={x} cy={EYE_Y} r={state === 'error' ? 4.5 : 7} fill={INK} />
                  <circle cx={x + 2.4} cy={EYE_Y - 2.6} r="2.3" fill="#fff" />
                </g>
              </g>
            ))}
          </g>
        )}
        <Glasses look={look} />
        {state === 'talking' && !walking
          ? <ellipse className="mouth-talk" cx="0" cy="-55" rx="5" ry="4" fill={INK} />
          : state === 'error'
            ? <path d="M-6,-53 Q0,-58 6,-53" fill="none" stroke={INK} strokeWidth="2.6" strokeLinecap="round" />
            : <path d="M-6,-57 Q0,-51 6,-57" fill="none" stroke={INK} strokeWidth="2.6" strokeLinecap="round" />}
        <Accessory look={look} />
        {!walking && <Prop state={state} />}
      </g>
      {!walking && <Badge state={state} />}
    </g>
  );
}
