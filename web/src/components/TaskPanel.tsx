import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import type { Run, Team, RunMode } from '../../../shared/types.ts';
import { api, type FolderListing } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { canListen, listen } from '../lib/audio.ts';

function FolderPicker({ start, onPick, onClose }: { start: string; onPick: (p: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState('');
  const go = (p?: string) => api.folders(p).then((l) => { setListing(l); setError(''); }).catch((e) => setError(e.message));
  useEffect(() => { go(start || undefined); }, []);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal small" onClick={(e) => e.stopPropagation()}>
        <h3>{t('workdir')}</h3>
        <div className="path">{listing?.path}</div>
        {error && <div className="error-text">{error}</div>}
        <div className="folders">
          {listing?.parent && <button className="folder up" onClick={() => go(listing.parent!)}>↑ {t('up')}</button>}
          {listing?.dirs.map((d) => <button key={d} className="folder" onClick={() => go(`${listing.path}/${d}`)}>{d}</button>)}
        </div>
        <div className="actions">
          <button onClick={onClose}>{t('cancel')}</button>
          <button className="primary" disabled={!listing} onClick={() => { onPick(listing!.path); onClose(); }}>{t('selectFolder')}</button>
        </div>
      </div>
    </div>
  );
}

export function TaskPanel({ team, run, recent, onStarted, onError }: {
  team: Team; run: Run | undefined; recent: string[]; onStarted: (run: Run) => void; onError: (message: string) => void;
}) {
  const { t, lang } = useI18n();
  const [task, setTask] = useState('');
  const [stopListening, setStopListening] = useState<(() => void) | null>(null);
  const dictate = () => {
    if (stopListening) { stopListening(); return; }
    const base = task ? `${task.trimEnd()} ` : '';
    let finals = '';
    const stop = listen(lang, (text, final) => { if (final) finals += `${text} `; setTask(base + finals + (final ? '' : text)); }, () => setStopListening(null));
    if (stop) setStopListening(() => stop);
  };
  const [workdir, setWorkdir] = useState(() => localStorage.getItem('beo.workdir') ?? '');
  const [check, setCheck] = useState('');
  const [files, setFiles] = useState<{ path: string; name: string }[]>([]);
  const [more, setMore] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState('new');
  const [mode, setMode] = useState<RunMode>('auto');

  const running = run?.status === 'running';
  const inRun = !!run && run.teamId === team.id;
  // "new" starts a run; "team" or an agent id sends a message into the selected run.
  const continuing = inRun && target !== 'new';
  useEffect(() => { if (!inRun || (target !== 'new' && target !== 'team' && !run!.team.agents.some((a) => a.id === target))) setTarget('new'); }, [inRun, run?.id]);
  useEffect(() => { localStorage.setItem('beo.workdir', workdir); }, [workdir]);
  // Voice commands fill the task box and press Run.
  const submitRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onTask = (e: Event) => setTask((e as CustomEvent<string>).detail);
    const onSend = () => submitRef.current();
    window.addEventListener('beo-task', onTask);
    window.addEventListener('beo-send', onSend);
    return () => { window.removeEventListener('beo-task', onTask); window.removeEventListener('beo-send', onSend); };
  }, []);

  const submit = async () => {
    if (!task.trim() || busy) return;
    setBusy(true);
    try {
      const next = continuing && run
        ? await api.message(run.id, task, target === 'team' ? undefined : target, files.map((f) => f.path), mode)
        : await api.startRun({ teamId: team.id, task, workdir, files: files.map((f) => f.path), checkCommand: check, mode });
      onStarted(next);
      setTask('');
      setFiles([]);
    } catch (e) {
      onError((e as Error).message);
    }
    setBusy(false);
  };

  submitRef.current = submit;

  const attach = async (list: FileList | File[] | null) => {
    if (!list || !list.length) return;
    try {
      const uploaded = await Promise.all([...list].map((f) => api.upload(f)));
      setFiles((prev) => [...prev, ...uploaded]);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  // Ctrl+V of a screenshot (PrtSc, Win+Shift+S) or a copied file attaches it; so does dropping files on the panel.
  const onPaste = (e: React.ClipboardEvent) => {
    const pasted = [...e.clipboardData.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f);
    if (!pasted.length) return;
    e.preventDefault();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    void attach(pasted.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `screenshot-${stamp}${pasted.length > 1 ? `-${i + 1}` : ''}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }))));
  };
  const isImg = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name);

  return (
    <div className="task-panel" onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); void attach(e.dataTransfer.files); } }}>
      <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={3} onPaste={onPaste}
        placeholder={continuing ? t('followUpPlaceholder') : t('taskPlaceholder')}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); }} />
      {files.length > 0 && (
        <div className="chips">{files.map((f) => (
          <span key={f.path} className={`chip${isImg(f.name) ? ' with-thumb' : ''}`}>
            {isImg(f.name) && <img src={api.uploadUrl(f.path)} alt="" />}{f.name}
            <button onClick={() => setFiles(files.filter((x) => x !== f))} aria-label={t('remove')}>×</button>
          </span>))}</div>
      )}
      {!continuing && (
        <div className="row">
          <input className="grow" value={workdir} onChange={(e) => setWorkdir(e.target.value)} placeholder={`${t('workdir')} — ${t('workdirPlaceholder')}`} list="recent-dirs" />
          <datalist id="recent-dirs">{recent.map((r) => <option key={r} value={r} />)}</datalist>
          <button onClick={() => setPicking(true)}>{t('browse')}</button>
        </div>
      )}
      {more && !continuing && (
        <div className="row"><input className="grow" value={check} onChange={(e) => setCheck(e.target.value)} placeholder={`${t('check')} — ${t('checkPlaceholder')}`} /></div>
      )}
      <div className="row">
        <label className="button" title={t('attachHint')}>{t('attach')}<input type="file" multiple hidden onChange={(e) => { attach(e.target.files); e.target.value = ''; }} /></label>
        {canListen() && <button className={stopListening ? 'danger' : ''} onClick={dictate} title={t('dictate')} aria-pressed={!!stopListening}>{stopListening ? '■' : '●'} {t('mic')}</button>}
        {!continuing && <button className="ghost" onClick={() => setMore(!more)}>{t('more')}</button>}
        {inRun && (
          <select className="target" value={target} onChange={(e) => setTarget(e.target.value)} aria-label={t('sendTo')}>
            <option value="new">{t('newTask')}</option>
            <option value="team">{t('toTeam')}</option>
            {run!.team.agents.map((a) => <option key={a.id} value={a.id}>{t('messageTo')} {a.name}</option>)}
          </select>
        )}
        {(!inRun || target === 'new' || target === 'team') && (
          <select className="mode" value={mode} onChange={(e) => setMode(e.target.value as RunMode)} title={t('modeHint')} aria-label={t('mode')}>
            <option value="auto">{t('modeAuto')}</option>
            <option value="quick">{t('modeQuick')}</option>
            <option value="team">{t('modeTeam')}</option>
          </select>
        )}
        <span className="grow" />
        {running && <button className="danger" onClick={() => api.stopRun(run!.id).catch((e) => onError(e.message))}>{t('stop')}</button>}
        <button className="primary" disabled={!task.trim() || busy} onClick={submit}>{continuing ? t('send') : t('run')}</button>
      </div>
      {picking && <FolderPicker start={workdir} onPick={setWorkdir} onClose={() => setPicking(false)} />}
    </div>
  );
}
