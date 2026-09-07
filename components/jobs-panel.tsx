'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { History, ListTodo, LoaderCircle, Play, Plus, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Job = {
  id: string; type: string; state: string; version: number;
  assignment: { agentId: string; specSha256: string } | null; reason: string | null;
  siteSpec: { revision: number; sha256: string }; currentRevision: number;
  isInputStale: boolean; createdAt: string;
};
type JobEvent = { sequence: number; type: string; createdAt: string };
type Operation = { url: string; body: string; key: string };
type JobList = { jobs: Job[]; nextCursor: string | null };
type Events = { events: JobEvent[]; nextCursor: string | null };
type Runner = { agentId: string; agentName: string; mode: string; projectId?: string; executionEnabled: boolean; status: string };
type ExecutionDetail = { report: { validationStatus: string; counts: { schema: number; semantic: number }; details: { kind: string; code: string; path: string }[]; truncated: boolean } | null;
  attempts: { attempt: number; state: string; failure_code: string | null }[] };
const states: Record<string, string> = { queued: 'Передано выбранному Runner', claimed: 'Получено Runner', running: 'Проверка запускается', validating: 'Проверяется структура SiteSpec', cancel_requested: 'Ожидается подтверждение остановки', succeeded: 'Проверка выполнена', failed: 'Проверка не завершена', cancelled: 'Отменено' };
const eventNames: Record<string, string> = { job_queued: 'Заявка сохранена в очереди', job_dispatched: 'Проверка разрешена выбранному Runner', job_claimed: 'Получено Runner', job_started: 'Запуск подтверждён', job_validating: 'Началась проверка', job_succeeded: 'Результат проверен сервером', job_failed: 'Попытка завершилась ошибкой', job_cancel_requested: 'Запрошена остановка', job_cancelled: 'Задание отменено', job_lease_expired: 'Срок попытки истёк' };

class JobApiError extends Error {
  constructor(public code: string) { super(code); }
}

async function request<T>(url: string, signal: AbortSignal, operation?: Operation): Promise<T> {
  const response = await fetch(url, operation ? {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operation.key }, body: operation.body,
  } : { signal });
  const body = await response.json();
  if (!response.ok) throw new JobApiError((body as { error?: { code?: string } } | null)?.error?.code ?? 'INTERNAL_ERROR');
  return body as T;
}

function errorMessage(error: unknown) {
  if (!(error instanceof JobApiError)) return 'Ответ не получен. Повторите тот же запрос.';
  if (error.code === 'PERSISTENCE_DISABLED') return 'Задания доступны только в локальном запуске';
  if (error.code === 'DATABASE_UNAVAILABLE') return 'База данных недоступна';
  if (error.code === 'REVISION_CONFLICT') return 'Бриф изменился на сервере. Загрузите актуальную версию брифа.';
  if (error.code === 'JOB_VERSION_CONFLICT') return 'Задание изменилось. Обновите список и журнал.';
  if (error.code === 'PROJECT_ARCHIVED') return 'Проект архивирован: новые задания недоступны';
  return 'Не удалось выполнить запрос задания';
}

export function JobsPanel({ projectId, revision, canCreate }: { projectId: string; revision: number | null; canCreate: boolean }) {
  const base = `/api/v1/projects/${projectId}/jobs`;
  const [items, setItems] = useState<Job[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [selected, setSelected] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [eventsNext, setEventsNext] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [retry, setRetry] = useState<Operation | null>(null);
  const [runners, setRunners] = useState<Runner[]>([]);
  const [runnerId, setRunnerId] = useState('');
  const [execution, setExecution] = useState<ExecutionDetail | null>(null);
  const selectedId = useRef<string | undefined>(undefined);
  const active = useRef<{ controller: AbortController; sequence: number } | null>(null);
  const serial = useRef(0);
  const busy = useRef(false);

  const read = useCallback(async (id?: string, cursor?: string, refreshList = false) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    const token = { controller: new AbortController(), sequence: ++serial.current };
    active.current = token;
    const timeout = setTimeout(() => token.controller.abort(), 5000);
    try {
      const connections = await request<{ agents: Runner[] }>('/api/v1/agents?limit=100', token.controller.signal);
      if (serial.current !== token.sequence) return;
      setRunners(connections.agents);
      if (id) {
        if (refreshList) {
          const list = await request<JobList>(base, token.controller.signal);
          if (serial.current !== token.sequence) return;
          setItems((old) => [...list.jobs, ...old.filter((job) => !list.jobs.some((fresh) => fresh.id === job.id))]);
        }
        const detail = await request<{ job: Job }>(`${base}/${id}`, token.controller.signal);
        const journal = await request<Events>(`${base}/${id}/events${cursor ? `?cursor=${cursor}` : ''}`, token.controller.signal);
        const result = await request<ExecutionDetail>(`${base}/${id}/execution`, token.controller.signal);
        if (serial.current !== token.sequence) return;
        setSelected(detail.job);
        selectedId.current = id; setExecution(result);
        setItems((old) => old.map((job) => job.id === id ? detail.job : job));
        setEvents((old) => cursor ? [...old, ...journal.events] : journal.events);
        setEventsNext(journal.nextCursor);
      } else {
        const result = await request<JobList>(`${base}${cursor ? `?cursor=${cursor}` : ''}`, token.controller.signal);
        if (serial.current !== token.sequence) return;
        setItems((old) => cursor ? [...old, ...result.jobs] : result.jobs);
        setNext(result.nextCursor);
      }
      if (!retry) setMessage('');
    } catch (error) {
      if (!token.controller.signal.aborted) setMessage(errorMessage(error));
    } finally {
      clearTimeout(timeout);
      if (serial.current === token.sequence) { busy.current = false; setPending(false); }
    }
  }, [base, retry]);

  useEffect(() => {
    const cancel = () => { active.current?.controller.abort(); serial.current++; busy.current = false; };
    return cancel;
  }, [base]);

  useEffect(() => {
    if (revision === null) return;
    const timer = setTimeout(() => void read(), 0);
    return () => clearTimeout(timer);
  }, [read, revision]);

  useEffect(() => {
    if (!items.some((job) => job.assignment && !['succeeded', 'failed', 'cancelled'].includes(job.state))) return;
    const timer = setInterval(() => void read(selectedId.current, undefined, true), 1500);
    return () => clearInterval(timer);
  }, [items, read]);

  const write = async (operation: Operation) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    const token = { controller: new AbortController(), sequence: ++serial.current };
    active.current = token;
    const timeout = setTimeout(() => token.controller.abort(), 10000);
    let acknowledged = false;
    try {
      const result = await request<{ job: Job }>(operation.url, token.controller.signal, operation);
      if (serial.current !== token.sequence) return;
      acknowledged = true;
      setRetry(null);
      setMessage('');
      setSelected(result.job);
      selectedId.current = result.job.id; setExecution(null);
      setEvents([]);
      setEventsNext(null);
      setItems((old) => old.some((item) => item.id === result.job.id)
        ? old.map((item) => item.id === result.job.id ? result.job : item) : [result.job, ...old]);
      // Replay is immutable; a fresh GET supplies current state and brief metadata.
      const detail = await request<{ job: Job }>(`${base}/${result.job.id}`, token.controller.signal);
      const journal = await request<Events>(`${base}/${result.job.id}/events`, token.controller.signal);
      const executionResult = await request<ExecutionDetail>(`${base}/${result.job.id}/execution`, token.controller.signal);
      if (serial.current !== token.sequence) return;
      setSelected(detail.job);
      setExecution(executionResult);
      setItems((old) => old.map((item) => item.id === detail.job.id ? detail.job : item));
      setEvents(journal.events);
      setEventsNext(journal.nextCursor);
    } catch (error) {
      if (serial.current !== token.sequence) return;
      if (!acknowledged && (!(error instanceof JobApiError) || error.code === 'INTERNAL_ERROR')) setRetry(operation);
      else setRetry(null);
      setMessage(acknowledged ? 'Запрос сохранён. Не удалось обновить журнал: откройте его повторно.' : errorMessage(error));
    } finally {
      clearTimeout(timeout);
      if (serial.current === token.sequence) { busy.current = false; setPending(false); }
    }
  };
  const create = () => {
    if (!canCreate || revision === null || retry || busy.current) return;
    void write({ url: base, body: JSON.stringify({ type: 'site_spec_validation', expectedRevision: revision }), key: crypto.randomUUID() });
  };
  const cancel = (job: Job) => {
    if (retry || busy.current) return;
    void write({ url: `${base}/${job.id}/cancel`, body: JSON.stringify({ expectedVersion: job.version }), key: crypto.randomUUID() });
  };
  const eligible = runners.filter((runner) => runner.mode === 'data_validation' && runner.projectId === projectId && runner.executionEnabled && runner.status === 'online');
  const dispatch = (job: Job) => {
    if (!canCreate || retry || busy.current || !eligible.some((runner) => runner.agentId === runnerId)) return;
    void write({ url: `${base}/${job.id}/dispatch`, body: JSON.stringify({ agentId: runnerId, expectedVersion: job.version }), key: crypto.randomUUID() });
  };

  return (
    <section aria-label="Задания" className="min-w-0 rounded-lg border border-white/10 bg-[#0b1118]/90 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><ListTodo className="size-4" />Задания</h2>
        <Button size="icon" variant="ghost" disabled={pending} aria-label="Обновить задания" title="Обновить задания" onClick={() => void read()}>
          <RefreshCw className="size-4" />
        </Button>
      </div>
      <p className="mt-2 text-xs text-slate-400">{revision === null ? 'Загрузка сохранённой версии' : `Сохранённая версия брифа: ${revision}`}</p>
      {!canCreate && <p className="mt-2 text-xs text-amber-300">Сначала сохраните бриф</p>}
      <Button className="mt-3 h-auto min-h-8 w-full whitespace-normal border-white/10 bg-white/5 text-slate-100" variant="outline" disabled={!canCreate || revision === null || pending || !!retry} onClick={create}>
        {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}Создать тестовое задание
      </Button>
      <div aria-live="polite">
        {message && <p className="mt-2 text-xs text-amber-300">{message}</p>}
        {retry && <Button className="mt-2" variant="outline" disabled={pending} onClick={() => void write(retry)}><RefreshCw className="size-4" />Повторить запрос задания</Button>}
      </div>
      {!items.length && <p className="mt-3 text-xs text-slate-500">{pending ? 'Загрузка заданий...' : 'Заданий пока нет'}</p>}
      {!!items.length && <label className="mt-3 block text-xs text-slate-400">Runner для проверки
        <select aria-label="Runner для проверки" className="mt-1 w-full min-w-0 rounded border border-white/10 bg-[#121820] p-2 text-xs text-slate-100" value={runnerId} disabled={pending || !!retry} onChange={(event) => setRunnerId(event.target.value)}>
          <option value="">Выберите устройство</option>
          {runners.map((runner) => <option key={runner.agentId} value={runner.agentId} disabled={!eligible.some((item) => item.agentId === runner.agentId)}>{runner.agentName}{runner.mode !== 'data_validation' ? ' · только связь' : runner.projectId !== projectId ? ' · другой проект' : runner.status !== 'online' ? ' · не в сети' : !runner.executionEnabled ? ' · нет совместимого разрешения' : ''}</option>)}
        </select>
        {!eligible.length && <span className="mt-1 block">Нет совместимого Runner с разрешением на этот проект</span>}
      </label>}
      <ul className="mt-3 divide-y divide-white/10">
        {items.map((job) => (
          <li key={job.id} data-job-id={job.id} className="min-w-0 py-3">
            <p className="break-all font-mono text-xs text-slate-400">{job.id}</p>
            <p className="mt-1 text-sm">Проверка SiteSpec · версия {job.siteSpec.revision}</p>
            <p className="mt-1 text-xs text-slate-400">{new Date(job.createdAt).toLocaleString('ru-RU')}</p>
            <p className="mt-2 text-xs text-cyan-200">{!job.assignment ? job.state === 'queued' ? 'В очереди — исполнитель ещё не подключён' : 'Отменено до запуска' : states[job.state]}</p>
            {job.reason === 'AGENT_REVOKED' && <p className="mt-1 text-xs text-amber-300">Доступ назначенного Runner отозван</p>}
            {job.reason === 'VALIDATOR_MISMATCH' && <p className="mt-1 text-xs text-amber-300">Версия валидатора несовместима: требуется новое разрешение</p>}
            {job.assignment && job.state === 'queued' && runners.find((runner) => runner.agentId === job.assignment?.agentId)?.status === 'offline' && <p className="mt-1 text-xs text-amber-300">Назначенный Runner не в сети</p>}
            {(job.isInputStale || (revision !== null && job.siteSpec.revision !== revision)) && <p className="mt-1 text-xs text-amber-300">Бриф обновлён: задание относится к версии {job.siteSpec.revision}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => void read(job.id)}><History className="size-4" />Журнал</Button>
              {job.state === 'queued' && !job.assignment && <Button variant="ghost" size="sm" disabled={!canCreate || pending || !!retry || !eligible.some((runner) => runner.agentId === runnerId)} onClick={() => dispatch(job)}><Play className="size-4" />Выполнить проверку</Button>}
              {['queued', 'claimed', 'running', 'validating'].includes(job.state) && <Button variant="ghost" size="sm" disabled={pending || !!retry} onClick={() => cancel(job)}><X className="size-4" />Отменить задание</Button>}
            </div>
          </li>
        ))}
      </ul>
      {next && <Button variant="ghost" disabled={pending} onClick={() => void read(undefined, next)}>Ещё задания</Button>}
      {selected && (
        <section aria-label="Журнал задания" className="mt-3 min-w-0 border-t border-white/10 pt-3">
          <h3 className="text-sm font-medium">Журнал задания</h3>
          <p className="mt-1 break-all font-mono text-xs text-slate-400">{selected.id}</p>
          <p className="mt-2 text-xs text-slate-400">Исходная версия: {selected.siteSpec.revision} · Текущая: {selected.currentRevision}</p>
          <p className="mt-1 break-all font-mono text-xs text-slate-500">SHA-256: {selected.siteSpec.sha256}</p>
          <ol className="mt-2 space-y-2 text-xs text-slate-300">
            {events.map((event) => <li key={event.sequence}>{event.sequence}. {eventNames[event.type] ?? event.type} · {new Date(event.createdAt).toLocaleString('ru-RU')}</li>)}
          </ol>
          {eventsNext && <Button variant="ghost" disabled={pending} onClick={() => void read(selected.id, eventsNext)}>Ещё события</Button>}
          {!!execution?.attempts.length && <ol aria-label="Попытки проверки" className="mt-3 space-y-1 text-xs text-slate-400">
            {execution.attempts.map((attempt) => <li key={attempt.attempt}>Попытка {attempt.attempt}: {states[attempt.state] ?? 'Срок попытки истёк'}{attempt.failure_code === 'STOP_UNCONFIRMED' ? ' · остановка не подтверждена' : attempt.failure_code ? ` · ${attempt.failure_code}` : ''}</li>)}
          </ol>}
          {execution?.report && <div aria-label="Результат проверки" className="mt-3 border-t border-white/10 pt-3 text-xs">
            <p className={execution.report.validationStatus === 'valid' ? 'text-emerald-300' : 'text-amber-300'}>{execution.report.validationStatus === 'valid' ? 'Ошибок структуры не найдено' : 'В данных найдены ошибки'}</p>
            <p className="mt-1 text-slate-400">Schema: {execution.report.counts.schema} · Семантика: {execution.report.counts.semantic}</p>
            <p className="mt-1 text-slate-400">Факты компании и готовность к публикации не подтверждены</p>
            <ul className="mt-2 space-y-1 break-all font-mono">{execution.report.details.map((item, index) => <li key={index}>{item.code} {item.path}</li>)}</ul>
            {execution.report.truncated && <p className="mt-1 text-slate-400">Показана ограниченная часть замечаний</p>}
          </div>}
        </section>
      )}
    </section>
  );
}
