'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { History, ListTodo, LoaderCircle, Plus, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Job = {
  id: string; type: string; state: 'queued' | 'cancelled'; version: number;
  siteSpec: { revision: number; sha256: string }; currentRevision: number;
  isInputStale: boolean; createdAt: string;
};
type JobEvent = { sequence: number; type: string; createdAt: string };
type Operation = { url: string; body: string; key: string };
type JobList = { jobs: Job[]; nextCursor: string | null };
type Events = { events: JobEvent[]; nextCursor: string | null };

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
  const active = useRef<{ controller: AbortController; sequence: number } | null>(null);
  const serial = useRef(0);
  const busy = useRef(false);

  const read = useCallback(async (id?: string, cursor?: string) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    const token = { controller: new AbortController(), sequence: ++serial.current };
    active.current = token;
    try {
      if (id) {
        const detail = await request<{ job: Job }>(`${base}/${id}`, token.controller.signal);
        const journal = await request<Events>(`${base}/${id}/events${cursor ? `?cursor=${cursor}` : ''}`, token.controller.signal);
        if (serial.current !== token.sequence) return;
        setSelected(detail.job);
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

  const write = async (operation: Operation) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    const token = { controller: new AbortController(), sequence: ++serial.current };
    active.current = token;
    let acknowledged = false;
    try {
      const result = await request<{ job: Job }>(operation.url, token.controller.signal, operation);
      if (serial.current !== token.sequence) return;
      acknowledged = true;
      setRetry(null);
      setMessage('');
      setSelected(result.job);
      setEvents([]);
      setEventsNext(null);
      setItems((old) => old.some((item) => item.id === result.job.id)
        ? old.map((item) => item.id === result.job.id ? result.job : item) : [result.job, ...old]);
      // Replay is immutable; a fresh GET supplies current state and brief metadata.
      const detail = await request<{ job: Job }>(`${base}/${result.job.id}`, token.controller.signal);
      const journal = await request<Events>(`${base}/${result.job.id}/events`, token.controller.signal);
      if (serial.current !== token.sequence) return;
      setSelected(detail.job);
      setItems((old) => old.map((item) => item.id === detail.job.id ? detail.job : item));
      setEvents(journal.events);
      setEventsNext(journal.nextCursor);
    } catch (error) {
      if (token.controller.signal.aborted) return;
      if (!acknowledged && (!(error instanceof JobApiError) || error.code === 'INTERNAL_ERROR')) setRetry(operation);
      else setRetry(null);
      setMessage(acknowledged ? 'Запрос сохранён. Не удалось обновить журнал: откройте его повторно.' : errorMessage(error));
    } finally {
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
      <ul className="mt-3 divide-y divide-white/10">
        {items.map((job) => (
          <li key={job.id} data-job-id={job.id} className="min-w-0 py-3">
            <p className="break-all font-mono text-xs text-slate-400">{job.id}</p>
            <p className="mt-1 text-sm">Проверка SiteSpec · версия {job.siteSpec.revision}</p>
            <p className="mt-1 text-xs text-slate-400">{new Date(job.createdAt).toLocaleString('ru-RU')}</p>
            <p className="mt-2 text-xs text-cyan-200">{job.state === 'queued' ? 'В очереди — исполнитель ещё не подключён' : 'Отменено до запуска'}</p>
            {(job.isInputStale || (revision !== null && job.siteSpec.revision !== revision)) && <p className="mt-1 text-xs text-amber-300">Бриф обновлён: задание относится к версии {job.siteSpec.revision}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => void read(job.id)}><History className="size-4" />Журнал</Button>
              {job.state === 'queued' && <Button variant="ghost" size="sm" disabled={pending || !!retry} onClick={() => cancel(job)}><X className="size-4" />Отменить задание</Button>}
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
            {events.map((event) => <li key={event.sequence}>{event.sequence}. {event.type === 'job_queued' ? 'Заявка сохранена в очереди' : 'Задание отменено'} · {new Date(event.createdAt).toLocaleString('ru-RU')}</li>)}
          </ol>
          {eventsNext && <Button variant="ghost" disabled={pending} onClick={() => void read(selected.id, eventsNext)}>Ещё события</Button>}
        </section>
      )}
    </section>
  );
}
