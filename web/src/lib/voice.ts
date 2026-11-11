// Spoken commands. Matches a few phrases in English and Turkish; everything else is ignored.

export type VoiceAction =
  | { type: 'stop' } | { type: 'approve' } | { type: 'deny' } | { type: 'send' }
  | { type: 'task'; text: string } | { type: 'team'; name: string }
  | { type: 'theme'; dark: boolean } | { type: 'music'; on: boolean } | { type: 'sounds'; on: boolean };

const has = (t: string, ...words: string[]) => words.some((w) => new RegExp(`(^|\\s)${w}(\\s|$)`).test(t));

export function parseVoice(raw: string): VoiceAction | null {
  const t = raw.toLowerCase().trim().replace(/[.,!?]/g, '');
  let m = /^(?:new task|task|yeni görev|görev)\s+(.+)$/.exec(t);
  if (m) return { type: 'task', text: raw.trim().replace(/^(new task|task|yeni görev|görev)\s+/i, '') };
  m = /^(?:switch to|open|go to)\s+(.+?)(?:\s+team)?$/.exec(t) ?? /^(.+?)\s+(?:ekibine geç|ekibini aç|ekibine git)$/.exec(t);
  if (m) return { type: 'team', name: m[1] };
  if (has(t, 'stop', 'dur', 'durdur')) return { type: 'stop' };
  if (has(t, 'approve', 'allow', 'onayla', 'izin ver')) return { type: 'approve' };
  if (has(t, 'deny', 'reject', 'reddet')) return { type: 'deny' };
  if (has(t, 'run', 'send', 'start', 'başlat', 'gönder')) return { type: 'send' };
  if (has(t, 'dark mode', 'lights off', 'karanlık mod', 'ışıkları kapat')) return { type: 'theme', dark: true };
  if (has(t, 'light mode', 'lights on', 'aydınlık mod', 'ışıkları aç')) return { type: 'theme', dark: false };
  if (has(t, 'music on', 'play music', 'müziği aç', 'müzik aç')) return { type: 'music', on: true };
  if (has(t, 'music off', 'stop music', 'müziği kapat', 'müzik kapat')) return { type: 'music', on: false };
  if (has(t, 'sounds on', 'sesleri aç')) return { type: 'sounds', on: true };
  if (has(t, 'sounds off', 'mute', 'sesleri kapat', 'sessiz')) return { type: 'sounds', on: false };
  return null;
}
