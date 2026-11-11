import { useEffect, useState } from 'react';
import type { ProviderStatus, Settings, SkillsState } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { useI18n, type Lang } from '../i18n.tsx';

/** Ollama: installed models with what they can do, and downloads with progress. */
function OllamaSection({ endpoints, providers, onRefresh }: { endpoints: Settings['localEndpoints']; providers: ProviderStatus[]; onRefresh: () => Promise<void> }) {
  const { t } = useI18n();
  const ollama = endpoints.filter((e) => e.id && (e.kind === 'ollama' || (e.kind !== 'openai' && /:11434(\/|$)/.test(e.baseUrl))));
  const [endpointId, setEndpointId] = useState(ollama[0]?.id ?? '');
  const [model, setModel] = useState('');
  const [pulls, setPulls] = useState<Awaited<ReturnType<typeof api.ollamaPulls>>>([]);
  const [error, setError] = useState('');
  const running = pulls.some((p) => !p.done);
  useEffect(() => { api.ollamaPulls().then(setPulls).catch(() => {}); }, []);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(async () => {
      const next = await api.ollamaPulls().catch(() => pulls);
      setPulls(next);
      if (!next.some((p) => !p.done)) void onRefresh();
    }, 1500);
    return () => clearInterval(timer);
  }, [running]);
  if (!ollama.length) return null;
  const status = providers.find((p) => p.endpointId === (endpointId || ollama[0].id));
  return (<>
    <h3>{t('localModels')}</h3>
    <p className="hint">{t('localModelsHint')}</p>
    {status && (status.ok
      ? <ul className="status-list">{status.models.map((m) => (
        <li key={m.id}><span className={m.capabilities?.includes('tools') ? 'led ok' : 'led'} /><b>{m.id}</b><span className="grow">{m.label?.split(' · ').slice(1).join(' · ')}</span>
          <button className="ghost" title={t('removeModel')} onClick={async () => {
            if (!confirm(t('removeModelConfirm').replace('{m}', m.id))) return;
            try { await api.ollamaDelete(endpointId || ollama[0].id, m.id); await onRefresh(); } catch (e) { setError((e as Error).message); }
          }}>×</button></li>))}</ul>
      : <div className="warn">{status.note}</div>)}
    <div className="row">
      {ollama.length > 1 && <select value={endpointId} onChange={(e) => setEndpointId(e.target.value)}>{ollama.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>}
      <input className="grow" value={model} onChange={(e) => setModel(e.target.value)} placeholder={t('pullPlaceholder')} />
      <button disabled={!model.trim()} onClick={async () => {
        setError('');
        try { await api.ollamaPull(endpointId || ollama[0].id, model); setModel(''); setPulls(await api.ollamaPulls()); } catch (e) { setError((e as Error).message); }
      }}>{t('pull')}</button>
    </div>
    {pulls.map((p) => <div key={p.model} className="row pull"><b>{p.model}</b><span className="grow">{p.error ?? p.status}</span>{p.percent != null && !p.error && <progress max={100} value={p.percent} />}</div>)}
    {error && <div className="error">{error}</div>}
  </>);
}

function ServerSection() {
  const { t } = useI18n();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.server>> | null>(null);
  const [logs, setLogs] = useState('');
  const [note, setNote] = useState('');
  const load = () => api.server().then(setInfo).catch((e) => setNote(e.message));
  useEffect(() => { load(); }, []);
  const managed = info && !info.supervisor?.error;
  return (<>
    <h3>{t('serverTitle')}</h3>
    {info && <p className="hint">pid {info.pid} · Node {info.node} · {t('since')} {new Date(info.startedAt).toLocaleTimeString()} · {managed ? t('managed') : info.supervisor?.error}</p>}
    <div className="row">
      <button disabled={!managed} onClick={async () => { setNote(t('restarting')); await api.restartServer().catch(() => {}); setTimeout(() => location.reload(), 6000); }}>{t('restartServer')}</button>
      <button disabled={!managed} onClick={async () => { const l = await api.serverLogs().catch((e) => ({ server: e.message, supervisor: '' })); setLogs(`${l.supervisor}\n---\n${l.server}`); }}>{t('showLogs')}</button>
      <span className="muted">{note}</span>
    </div>
    {logs && <pre className="changes" style={{ maxHeight: 240 }}>{logs}</pre>}
  </>);
}

export function SettingsModal({ settings: initial, providers, skills, useDatabase, onDatabase, onSaved, onRefresh, onSkills, onClose }: {
  settings: Settings; providers: ProviderStatus[]; skills: SkillsState; useDatabase: boolean; onDatabase: (on: boolean) => void;
  onSaved: (s: Settings) => void; onRefresh: () => Promise<void>; onSkills: (s: SkillsState) => void; onClose: () => void;
}) {
  const { t, lang, setLang } = useI18n();
  const [settings, setSettings] = useState(initial);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [docker, setDocker] = useState<Awaited<ReturnType<typeof api.docker>> | null>(null);
  const [buildLog, setBuildLog] = useState('');
  useEffect(() => { api.docker().then(setDocker).catch(() => {}); }, []);
  const setEndpoint = (i: number, patch: Partial<Settings['localEndpoints'][number]>) =>
    setSettings({ ...settings, localEndpoints: settings.localEndpoints.map((e, j) => (j === i ? { ...e, ...patch } : e)) });

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError('');
    try { await fn(); } catch (e) { setError((e as Error).message); }
    setBusy('');
  };
  const save = () => act('save', async () => { const s = await api.saveSettings(settings); setSettings(s); onSaved(s); await onRefresh(); });

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('settings')}</h2>
        <label className="inline">{t('language')}
          <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}><option value="en">English</option><option value="tr">Türkçe</option></select>
        </label>

        <h3>{t('accounts')}</h3>
        <p className="hint">{t('keyHint')}</p>
        <div className="grid2">
          <label>{t('anthropicKey')}<input type="password" value={settings.anthropicApiKey ?? ''} onChange={(e) => setSettings({ ...settings, anthropicApiKey: e.target.value })} placeholder="sk-ant-…" autoComplete="off" /></label>
          <label>{t('openaiKey')}<input type="password" value={settings.openaiApiKey ?? ''} onChange={(e) => setSettings({ ...settings, openaiApiKey: e.target.value })} placeholder="sk-…" autoComplete="off" /></label>
        </div>

        <div className="grid2">
          <label>{t('anthropicAdminKey')}<input type="password" value={settings.anthropicAdminKey ?? ''} onChange={(e) => setSettings({ ...settings, anthropicAdminKey: e.target.value })} placeholder="sk-ant-admin…" autoComplete="off" /></label>
          <label>{t('openaiAdminKey')}<input type="password" value={settings.openaiAdminKey ?? ''} onChange={(e) => setSettings({ ...settings, openaiAdminKey: e.target.value })} placeholder="sk-admin-…" autoComplete="off" /></label>
        </div>
        <p className="hint">{t('adminKeyHint')}</p>
        <label className="inline">{t('claudeAuth')}
          <select value={settings.claudeAuth ?? 'auto'} onChange={(e) => setSettings({ ...settings, claudeAuth: e.target.value as Settings['claudeAuth'] })}>
            <option value="auto">{t('claudeAuth_auto')}</option><option value="login">{t('claudeAuth_login')}</option><option value="apiKey">{t('claudeAuth_apiKey')}</option>
          </select>
        </label>
        <p className="hint">{t('claudeAuthHint')}</p>
        <label className="inline">{t('codexAuth')}
          <select value={settings.codexAuth ?? 'auto'} onChange={(e) => setSettings({ ...settings, codexAuth: e.target.value as Settings['codexAuth'] })}>
            <option value="auto">{t('codexAuth_auto')}</option><option value="chatgpt">{t('codexAuth_chatgpt')}</option><option value="apiKey">{t('codexAuth_apiKey')}</option>
          </select>
        </label>

        <h3>{t('endpoints')}</h3>
        {settings.localEndpoints.map((e, i) => (
          <div className="row" key={e.id || i}>
            <input style={{ width: 130 }} value={e.name} onChange={(ev) => setEndpoint(i, { name: ev.target.value })} placeholder={t('name')} />
            <input className="grow" value={e.baseUrl} onChange={(ev) => setEndpoint(i, { baseUrl: ev.target.value })} placeholder="http://localhost:11434/v1" />
            <input style={{ width: 130 }} type="password" value={e.apiKey ?? ''} onChange={(ev) => setEndpoint(i, { apiKey: ev.target.value })} placeholder={t('apiKey')} autoComplete="off" />
            {(e.kind === 'ollama' || (e.kind !== 'openai' && /:11434(\/|$)/.test(e.baseUrl))) && (
              <label className="inline" title={t('contextHint')}>{t('context')}
                <select value={e.contextLength ?? 32768} onChange={(ev) => setEndpoint(i, { contextLength: Number(ev.target.value) })}>
                  {[8192, 16384, 32768, 65536, 131072].map((n) => <option key={n} value={n}>{n / 1024}k</option>)}
                </select></label>)}
            <button className="ghost" onClick={() => setSettings({ ...settings, localEndpoints: settings.localEndpoints.filter((_, j) => j !== i) })}>×</button>
          </div>
        ))}
        <button onClick={() => setSettings({ ...settings, localEndpoints: [...settings.localEndpoints, { id: '', name: '', baseUrl: '' }] })}>+ {t('addEndpoint')}</button>

        <OllamaSection endpoints={settings.localEndpoints} providers={providers} onRefresh={onRefresh} />

        <h3>{t('providers')} <button className="ghost" disabled={busy === 'refresh'} onClick={() => act('refresh', onRefresh)}>{t('refresh')}</button></h3>
        <ul className="status-list">
          {providers.map((p) => <li key={p.id}><span className={p.ok ? 'led ok' : 'led'} /><b>{p.name}</b><span>{p.note}</span></li>)}
        </ul>

        <h3>{t('superpowers')}</h3>
        <p className="hint">{t('superpowersHint')}</p>
        <div className="row">
          <span>{skills.installed ? `${skills.skills.length} skills ${t('installed')}` : t('notInstalled')}</span>
          <button disabled={busy === 'skills'} onClick={() => act('skills', async () => onSkills(await api.installSkills()))}>{busy === 'skills' ? '…' : skills.installed ? t('update') : t('install')}</button>
        </div>

        <h3>{t('tracing')}</h3>
        <p className="hint">{t('tracingHint')}</p>
        <div className="grid2">
          <label>{t('otlpEndpoint')}<input value={settings.otlpEndpoint ?? ''} onChange={(e) => setSettings({ ...settings, otlpEndpoint: e.target.value })} placeholder="http://localhost:4318" /></label>
          <label>{t('otlpHeaders')}<input type="password" value={settings.otlpHeaders ?? ''} onChange={(e) => setSettings({ ...settings, otlpHeaders: e.target.value })} placeholder="Authorization=Basic …" autoComplete="off" /></label>
        </div>
        <label className="check"><input type="checkbox" checked={settings.watchExternal !== false} onChange={(e) => setSettings({ ...settings, watchExternal: e.target.checked })} />{t('watchExternal')}</label>

        <h3>{t('storage')}</h3>
        <label className="check"><input type="checkbox" checked={useDatabase} disabled={busy === 'db'}
          onChange={(e) => act('db', async () => onDatabase((await api.setStorage(e.target.checked)).useDatabase))} />{t('useDatabase')}</label>
        <p className="hint">{t('storageHint')}</p>

        <h3>{t('dockerTitle')}</h3>
        <p className="hint">{t('dockerHint')}</p>
        <div className="row">
          <span className={docker?.docker && docker.image ? 'led ok' : 'led'} /><span className="grow">{docker?.detail ?? '…'}</span>
          <button disabled={busy === 'docker' || !docker?.docker} onClick={() => act('docker', async () => {
            const r = await api.dockerBuild(); setBuildLog(r.ok ? '' : r.log); setDocker(await api.docker()); if (!r.ok) throw new Error(t('dockerBuildFailed'));
          })}>{busy === 'docker' ? t('dockerBuilding') : docker?.image ? t('dockerRebuild') : t('dockerBuild')}</button>
          <button disabled={busy === 'clean' || !docker?.docker} title={t('dockerCleanHint')} onClick={() => act('clean', async () => {
            const r = await api.dockerClean(); setBuildLog(t('dockerCleaned').replace('{n}', String(r.removed)));
          })}>{t('dockerClean')}</button>
        </div>
        {buildLog && <pre className="changes">{buildLog}</pre>}
        <div className="grid2">
          <label>{t('dockerNetwork')}
            <select value={settings.dockerNetwork ?? 'allowlist'} onChange={(e) => setSettings({ ...settings, dockerNetwork: e.target.value as Settings['dockerNetwork'] })}>
              <option value="allowlist">{t('net_allowlist')}</option><option value="open">{t('net_open')}</option><option value="none">{t('net_none')}</option></select></label>
          <div className="grid2">
            <label>{t('dockerMemory')}<input value={settings.dockerMemory ?? '4g'} onChange={(e) => setSettings({ ...settings, dockerMemory: e.target.value })} /></label>
            <label>{t('dockerCpus')}<input type="number" min={0.5} step={0.5} value={settings.dockerCpus ?? 2} onChange={(e) => setSettings({ ...settings, dockerCpus: Number(e.target.value) || 2 })} /></label>
          </div>
        </div>
        {(settings.dockerNetwork ?? 'allowlist') === 'allowlist' && (<>
          <label>{t('dockerAllow')}<input value={(settings.dockerAllow ?? []).join(', ')} placeholder="example.com, api.mycompany.dev" onChange={(e) => setSettings({ ...settings, dockerAllow: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></label>
          <p className="hint">{t('dockerAllowHint')} {docker?.defaultAllow.join(', ')}</p>
          {docker?.denials && <><span className="label">{t('dockerDenied')}</span><pre className="changes">{docker.denials}</pre></>}
        </>)}

        <ServerSection />

        {error && <div className="error-text">{error}</div>}
        <div className="actions">
          <span className="grow" />
          <button onClick={onClose}>{t('close')}</button>
          <button className="primary" disabled={busy === 'save'} onClick={save}>{t('save')}</button>
        </div>
      </div>
    </div>
  );
}
