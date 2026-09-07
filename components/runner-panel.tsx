'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Eye, EyeOff, Link2, Monitor, RefreshCw, ShieldX, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Agent = { agentId: string; agentName: string; agentVersion: string; selectedApiVersion: string; os: string; status: 'online' | 'offline' | 'revoked'; lastSeenAt: string | null };
type Pairing = { pairingId: string; expiresAt: string; status: string; pairingSecret?: string };

async function api<T>(path: string, signal: AbortSignal, write = false): Promise<T> {
  const response = await fetch(`/api/v1/agents${path}`, { signal, ...(write ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error((value as { error?: { code?: string } } | null)?.error?.code ?? 'REQUEST_FAILED');
  return value as T;
}

function Connections() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [next, setNext] = useState<string | null>(null);
  const [paged, setPaged] = useState(false);
  const cursor = useRef<string | null>(null);
  const pairId = useRef<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const alive = useRef(false);
  const serial = useRef(0);

  const run = useCallback(async (action: (signal: AbortSignal) => Promise<void>, issuing = false) => {
    if (busy.current || !alive.current) return;
    busy.current = true; setPending(true);
    const controller = new AbortController(); active.current = controller;
    const sequence = ++serial.current;
    const timeout = setTimeout(() => controller.abort(), 4000);
    try { await action(controller.signal); }
    catch (error) {
      if (alive.current && serial.current === sequence) {
        const code = error instanceof Error ? error.message : '';
        setMessage(code === 'PERSISTENCE_DISABLED' ? 'Подключение доступно только в локальном запуске платформы' :
          code === 'DATABASE_UNAVAILABLE' ? 'База данных недоступна' : issuing ?
            'Разрешение не получено. Создайте новое; прежнее истечёт через 5 минут.' : 'Не удалось обновить подключение. Повторите запрос.');
      }
    } finally {
      clearTimeout(timeout);
      if (alive.current && serial.current === sequence) { busy.current = false; setPending(false); }
    }
  }, []);
  const refresh = useCallback(async (signal: AbortSignal) => {
    const result = await api<{ agents: Agent[]; nextCursor: string | null }>(`?limit=20${cursor.current ? `&cursor=${cursor.current}` : ''}`, signal);
    if (signal.aborted) return;
    setAgents(result.agents); setNext(result.nextCursor); setPaged(!!cursor.current);
    if (pairId.current) {
      const current = await api<Pairing>(`/pairings/${pairId.current}`, signal);
      if (!signal.aborted && current.status !== 'pending') { pairId.current = null; setPairing(null); setShowSecret(false); }
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await run(refresh); if (!disposed) timer = setTimeout(() => void poll(), 5000); };
    timer = setTimeout(() => void poll(), 0);
    const cancel = () => { disposed = true; alive.current = false; serial.current++; busy.current = false; clearTimeout(timer); active.current?.abort(); pairId.current = null; };
    return cancel;
  }, [run, refresh]);
  useEffect(() => {
    if (!pairing) return;
    const timeout = setTimeout(() => { pairId.current = null; setPairing(null); setShowSecret(false); }, Math.max(0, Math.min(300000, Date.parse(pairing.expiresAt) - Date.now())));
    return () => clearTimeout(timeout);
  }, [pairing]);

  const issue = () => void run(async (signal) => {
    const result = await api<Pairing>('/pairings', signal, true);
    if (signal.aborted) return;
    pairId.current = result.pairingId; setPairing(result); setShowSecret(false); setMessage(''); cursor.current = null;
  }, true);
  const cancelPairing = () => {
    if (!pairing || busy.current) return;
    const id = pairing.pairingId;
    setPairing({ ...pairing, pairingSecret: undefined }); setShowSecret(false);
    void run(async (signal) => {
      await api(`/pairings/${id}/cancel`, signal, true);
      if (signal.aborted) return;
      pairId.current = null; setPairing(null); setMessage('');
    });
  };
  const revoke = (id: string) => void run(async (signal) => {
    const result = await api<{ agent: Agent }>(`/${id}/revoke`, signal, true);
    if (signal.aborted) return;
    setAgents((old) => old.map((agent) => agent.agentId === id ? result.agent : agent)); setMessage('');
  });
  return <>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Button variant="outline" className="h-auto min-h-8 whitespace-normal border-white/10 bg-white/5 text-slate-100" disabled={pending || !!pairing} onClick={issue}><Link2 className="size-4" />Разрешить подключение</Button>
      <Button variant="ghost" size="icon" title="Обновить Runner" aria-label="Обновить Runner" disabled={pending} onClick={() => void run(refresh)}><RefreshCw className="size-4" /></Button>
    </div>
    {pairing && <div className="mt-3 border-y border-white/10 py-3" data-sensitive-pairing>
      <p className="text-xs text-amber-300">Одноразовый код действует 5 минут. Введите его в скрытом запросе Runner.</p>
      {pairing.pairingSecret && <div className="mt-2 flex min-w-0 gap-1">
        <input aria-label="Временный код Runner" readOnly autoComplete="off" type={showSecret ? 'text' : 'password'} value={pairing.pairingSecret} className="min-w-0 flex-1 rounded border border-white/10 bg-black/20 px-2 py-1 font-mono text-xs" />
        <Button variant="ghost" size="icon" title={showSecret ? 'Скрыть код' : 'Показать код'} aria-label={showSecret ? 'Скрыть код' : 'Показать код'} onClick={() => setShowSecret(!showSecret)}>{showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</Button>
      </div>}
      <Button variant="ghost" size="sm" className="mt-2" disabled={pending} onClick={cancelPairing}><X className="size-4" />Отменить разрешение</Button>
    </div>}
    <p aria-live="polite" className="mt-2 text-xs text-amber-300">{message}</p>
    {!agents.length && <p className="mt-2 text-xs text-slate-400">{pending ? 'Загрузка подключений...' : 'Нет подключённых устройств'}</p>}
    <ul className="divide-y divide-white/10">
      {agents.map((agent) => <li key={agent.agentId} data-agent-id={agent.agentId} className="min-w-0 py-3">
        <p className="break-words text-sm font-medium">{agent.agentName}</p>
        <p className="mt-1 text-xs text-slate-400">{agent.os} · Runner {agent.agentVersion} · API {agent.selectedApiVersion}</p>
        <p className={`mt-2 text-xs ${agent.status === 'online' ? 'text-emerald-300' : 'text-slate-400'}`}>{agent.status === 'online' ? 'На связи' : agent.status === 'revoked' ? 'Доступ отозван' : 'Не в сети'}</p>
        <p className="mt-1 text-xs text-slate-400">Последний сигнал: {agent.lastSeenAt ? new Date(agent.lastSeenAt).toLocaleString('ru-RU') : 'ещё не получен'}</p>
        {agent.status !== 'revoked' && <Button variant="ghost" size="sm" className="mt-2" disabled={pending} onClick={() => revoke(agent.agentId)}><ShieldX className="size-4" />Отозвать доступ</Button>}
      </li>)}
    </ul>
    <div className="flex flex-wrap gap-2">
      {next && <Button variant="ghost" disabled={pending} onClick={() => { cursor.current = next; void run(refresh); }}><ChevronDown className="size-4" />Ещё устройства</Button>}
      {paged && <Button variant="ghost" disabled={pending} onClick={() => { cursor.current = null; void run(refresh); }}>Начало списка</Button>}
    </div>
  </>;
}

export function RunnerPanel() {
  const [expanded, setExpanded] = useState(false);
  return <section aria-label="Локальный Runner" className="min-w-0 rounded-lg border border-white/10 bg-[#0b1118]/90 p-4">
    <div className="flex items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold"><Monitor className="size-4" />Локальный Runner</h2>
      <Button variant="ghost" size="icon" title={expanded ? 'Закрыть подключения' : 'Открыть подключения'} aria-label={expanded ? 'Закрыть подключения' : 'Открыть подключения'} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? <X className="size-4" /> : <ChevronDown className="size-4" />}</Button>
    </div>
    <p className="mt-2 text-xs text-slate-400">Исполнение заданий ещё не подключено</p>
    {expanded && <Connections />}
  </section>;
}
