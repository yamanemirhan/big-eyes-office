import { useSyncExternalStore } from 'react';

// All sound is synthesized in the browser: no audio files, nothing to license.

export interface AudioPrefs { sfx: boolean; music: boolean; track: number; voice: boolean }
const KEY = 'beo.audio';
let prefs: AudioPrefs = { sfx: true, music: false, track: 0, voice: false, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
const listeners = new Set<() => void>();

export function setAudio(patch: Partial<AudioPrefs>) {
  prefs = { ...prefs, ...patch };
  localStorage.setItem(KEY, JSON.stringify(prefs));
  listeners.forEach((l) => l());
  if (prefs.music) startMusic(); else stopMusic();
  if (!prefs.voice) window.speechSynthesis?.cancel();
}
export const useAudio = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => prefs);

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, dur: number, opts: { type?: OscillatorType; gain?: number; at?: number; to?: number; out?: AudioNode } = {}) {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + (opts.at ?? 0);
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(freq, t);
  if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(opts.gain ?? 0.08, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(opts.out ?? ac.destination);
  osc.start(t);
  osc.stop(t + dur + 0.03);
}

function noise(dur: number, gain: number, at = 0, freq = 1800) {
  const ac = audio();
  if (!ac) return;
  const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * dur), ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = ac.createBufferSource();
  const filter = ac.createBiquadFilter();
  const g = ac.createGain();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  g.gain.value = gain;
  src.buffer = buffer;
  src.connect(filter).connect(g).connect(ac.destination);
  src.start(ac.currentTime + at);
}

const SOUNDS = {
  click: () => tone(620, 0.05, { type: 'triangle', gain: 0.05 }),
  switch: () => { noise(0.03, 0.12, 0, 3200); tone(180, 0.06, { type: 'square', gain: 0.03 }); },
  send: () => { tone(520, 0.09, { type: 'triangle' }); tone(780, 0.12, { type: 'triangle', at: 0.08 }); },
  pop: () => tone(420, 0.09, { to: 880, gain: 0.07 }),
  ask: () => { tone(660, 0.12); tone(880, 0.12, { at: 0.13 }); tone(660, 0.16, { at: 0.26 }); },
  done: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, { type: 'triangle', at: i * 0.1, gain: 0.07 })),
  error: () => { tone(220, 0.18, { type: 'sawtooth', gain: 0.05 }); tone(165, 0.3, { type: 'sawtooth', at: 0.16, gain: 0.05 }); },
  pick: () => tone(300, 0.06, { to: 460, gain: 0.05 }),
  drop: () => { tone(200, 0.09, { to: 110, gain: 0.09 }); noise(0.05, 0.05, 0.02, 500); },
  meow: () => { tone(700, 0.16, { type: 'sawtooth', to: 1100, gain: 0.035 }); tone(1100, 0.3, { type: 'sawtooth', to: 600, at: 0.15, gain: 0.035 }); },
  rustle: () => { noise(0.12, 0.07, 0, 4200); noise(0.1, 0.05, 0.09, 5200); },
  coffee: () => { noise(0.9, 0.05, 0, 900); [0.15, 0.4, 0.62].forEach((at) => tone(240, 0.07, { to: 420, at, gain: 0.04 })); },
  water: () => [0, 0.11, 0.2].forEach((at, i) => tone(300 + i * 90, 0.09, { to: 620 + i * 80, at, gain: 0.05 })),
} satisfies Record<string, () => void>;
export type Sound = keyof typeof SOUNDS;
export const sfx = (name: Sound) => { if (prefs.sfx) SOUNDS[name](); };

// ---- Music: three small generative loops ----
const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);
export const TRACKS = [
  { name: 'Morning desk', bpm: 76, wave: 'triangle' as OscillatorType, chords: [[57, 60, 64, 67], [53, 57, 60, 64], [48, 55, 60, 64], [55, 59, 62, 67]] },
  { name: 'Late shift', bpm: 64, wave: 'sine' as OscillatorType, chords: [[50, 57, 60, 65], [46, 53, 58, 62], [43, 50, 58, 62], [45, 52, 57, 61]] },
  { name: 'Coffee break', bpm: 96, wave: 'triangle' as OscillatorType, chords: [[60, 64, 67, 71], [57, 60, 64, 69], [53, 57, 60, 65], [55, 59, 62, 65]] },
];
let timer: number | undefined;
let master: GainNode | null = null;

function startMusic() {
  const ac = audio();
  if (!ac || timer !== undefined) return;
  master = ac.createGain();
  master.gain.value = 0.5;
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 1500;
  master.connect(filter).connect(ac.destination);
  let step = 0;
  let next = ac.currentTime + 0.1;
  timer = window.setInterval(() => {
    const track = TRACKS[prefs.track % TRACKS.length];
    const beat = 60 / track.bpm / 2; // eighth notes
    while (next < ac.currentTime + 0.3) {
      const chord = track.chords[Math.floor(step / 8) % track.chords.length];
      const at = next - ac.currentTime;
      if (step % 8 === 0) chord.forEach((n) => tone(midi(n), beat * 8.2, { type: 'sine', gain: 0.03, at, out: master! }));
      if (step % 8 === 0) tone(midi(chord[0] - 12), beat * 4, { type: 'sine', gain: 0.06, at, out: master! });
      // A wandering arpeggio: mostly chord tones, sometimes a rest.
      if (Math.random() > 0.28) tone(midi(chord[(step * 3 + (Math.random() > 0.7 ? 1 : 0)) % chord.length] + 12), beat * 1.6, { type: track.wave, gain: 0.035, at, out: master! });
      next += beat;
      step++;
    }
  }, 80);
}

function stopMusic() {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  if (master && ctx) master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.15);
  master = null;
}

/** Browsers only allow sound after a click; call this from the first one. */
export function unlockAudio() { if (prefs.music) startMusic(); }

// ---- Voice ----
export function speak(text: string, lang: string) {
  if (!prefs.voice || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text.replace(/[`*#_>]/g, '').slice(0, 500));
  u.lang = lang === 'tr' ? 'tr-TR' : 'en-US';
  u.rate = 1.05;
  window.speechSynthesis.speak(u);
}

export function listen(lang: string, onText: (text: string, final: boolean) => void, onEnd: () => void): (() => void) | null {
  const Rec = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  if (!Rec) return null;
  const rec = new Rec();
  rec.lang = lang === 'tr' ? 'tr-TR' : 'en-US';
  rec.interimResults = true;
  rec.continuous = true;
  rec.onresult = (e: any) => {
    for (let i = e.resultIndex; i < e.results.length; i++) onText(e.results[i][0].transcript, e.results[i].isFinal);
  };
  rec.onend = onEnd;
  rec.onerror = onEnd;
  rec.start();
  return () => rec.stop();
}
export const canListen = () => !!((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition);
