'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Building2,
  Check,
  ChevronRight,
  FileText,
  Layers3,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  Network,
  Palette,
  RefreshCw,
  Rocket,
  Save,
  Search,
  ShoppingCart,
  Sparkles,
  Store,
  Upload,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress, ProgressLabel } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

const navItems = [
  ['Обзор', LayoutDashboard],
  ['Бизнес', Building2],
  ['Тип сайта', Store],
  ['Сеть сайтов', Network],
  ['Товары / услуги', ShoppingCart],
  ['Структура', Layers3],
  ['SEO', Search],
  ['Дизайн', Palette],
  ['Публикация', Rocket],
] as const;

const businessOptions = [
  {
    value: 'wholesale',
    title: 'Оптовая компания',
    description: 'Продажи партиями, прайсы, минимальный заказ, заявки от магазинов.',
  },
  {
    value: 'manufacturer',
    title: 'Производитель',
    description: 'Собственное производство, ассортимент, сроки, дилеры и регионы.',
  },
  {
    value: 'distributor',
    title: 'Дистрибьютор',
    description: 'Бренды, склады, наличие, поставки и партнерская сеть.',
  },
  {
    value: 'services',
    title: 'Услуги B2B',
    description: 'Направления услуг, кейсы, заявки, консультации и тарифы.',
  },
] as const;

const siteTypeOptions = [
  {
    value: 'landing',
    title: 'Лендинг',
    description: 'Одна страница под один оффер, быстрый запуск и заявка.',
    pages: 'Главная, преимущества, каталог/услуга, форма заявки, FAQ',
  },
  {
    value: 'multipage',
    title: 'Многостраничник',
    description: 'Отдельные разделы для компании, услуг, условий и контактов.',
    pages: 'Главная, о компании, каталог/услуги, доставка, оплата, контакты',
  },
  {
    value: 'catalog',
    title: 'Каталог с карточками',
    description: 'Категории, фильтры, карточки товаров, цены и импорт прайса.',
    pages: 'Категории, подкатегории, карточки товаров, подборки, заявки',
  },
  {
    value: 'seo-network',
    title: 'SEO-сеть страниц',
    description: 'Много посадочных под товары, услуги, регионы и запросы.',
    pages: 'Товар + город, категория + регион, услуга + сегмент, FAQ',
  },
] as const;

const networkOptions = [
  {
    value: 'single',
    title: 'Один сайт',
    description: 'Вся информация, контакты, каталог и SEO живут в одном проекте.',
  },
  {
    value: 'regions',
    title: 'Сеть по регионам',
    description: 'Например, Москва, Санкт-Петербург и другие города с разными посадочными.',
  },
  {
    value: 'niches',
    title: 'Сеть по нишам',
    description: 'Отдельные сайты или разделы под разные направления и товарные группы.',
  },
  {
    value: 'domains',
    title: 'Отдельные домены',
    description: 'У каждого сайта свой домен, контакты, региональные условия и SEO.',
  },
] as const;

const networkDataRules = [
  ['Телефон', 'один на все сайты или отдельный номер для каждого сайта'],
  ['Фотографии', 'общие фото каталога или уникальные фото под регион/нишу'],
  ['Адреса', 'один офис или разные адреса и точки присутствия'],
  ['Каталог', 'единый ассортимент или разные подборки товаров/услуг'],
  ['Цены', 'единый прайс или разные цены по региону/сайту'],
  ['Домены', 'один домен, поддомены, папки или отдельные домены'],
  ['Офферы', 'единое предложение или разные условия для каждой аудитории'],
] as const;

const followUpBlocks = [
  ['Товары / услуги', 'что продаем, какие категории, свойства, цены, остатки и фото нужны'],
  ['Структура', 'какие страницы создавать: главная, категории, карточки, услуги, города'],
  ['SEO', 'какие запросы, регионы, URL, title, description и посадочные генерировать'],
  ['Дизайн', 'какой стиль, цвета, референсы, логотип и ограничения использовать'],
  ['Публикация', 'домен, формы заявок, аналитика, интеграции и правила деплоя'],
] as const;

type EditableDraft = {
  companyName: string;
  niche: string;
  salesRegion: string;
  businessType: string;
  siteType: string;
  networkType: string;
};

type ProjectSnapshot = {
  project: {
    id: string;
  };
  siteSpec: {
    editableDraft: EditableDraft;
    noOp: boolean;
    revision: number;
  };
};

type SaveState = 'unsaved' | 'saving' | 'saved' | 'conflict' | 'unavailable' | 'error';

class ApiRequestError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.details = details;
  }
}

async function projectRequest(url: string, init?: RequestInit): Promise<ProjectSnapshot> {
  const response = await fetch(url, init);
  const body = (await response.json()) as ProjectSnapshot & {
    error?: { code?: string; details?: Record<string, unknown>; message?: string };
  };
  if (!response.ok || body.error) {
    throw new ApiRequestError(
      body.error?.code ?? 'REQUEST_FAILED',
      body.error?.message ?? 'Не удалось выполнить запрос.',
      body.error?.details,
    );
  }
  return body;
}

function createIdempotencyKey() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export default function Home() {
  const [business, setBusiness] = useState<string>(businessOptions[0].value);
  const [siteType, setSiteType] = useState<string>(siteTypeOptions[0].value);
  const [network, setNetwork] = useState<string>(networkOptions[0].value);
  const [companyName, setCompanyName] = useState('');
  const [niche, setNiche] = useState('');
  const [salesRegion, setSalesRegion] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('unsaved');
  const [saveMessage, setSaveMessage] = useState('Проект ещё не создан');

  const applySnapshot = useCallback((snapshot: ProjectSnapshot) => {
    const draft = snapshot.siteSpec.editableDraft;
    setCompanyName(draft.companyName);
    setNiche(draft.niche);
    setSalesRegion(draft.salesRegion);
    setBusiness(draft.businessType);
    setSiteType(draft.siteType);
    setNetwork(draft.networkType);
    setProjectId(snapshot.project.id);
    setRevision(snapshot.siteSpec.revision);
    setSaveState('saved');
    setSaveMessage(`Сохранено, revision ${snapshot.siteSpec.revision}`);
  }, []);

  const handleFailure = useCallback((error: unknown) => {
    if (error instanceof ApiRequestError && error.code === 'REVISION_CONFLICT') {
      const currentRevision = error.details.currentRevision;
      setSaveState('conflict');
      setSaveMessage(
        typeof currentRevision === 'number'
          ? `Конфликт: на сервере revision ${currentRevision}`
          : 'Конфликт: на сервере есть более новая версия',
      );
      return;
    }
    if (error instanceof ApiRequestError && error.code === 'DATABASE_UNAVAILABLE') {
      setSaveState('unavailable');
      setSaveMessage('База данных недоступна');
      return;
    }
    setSaveState('error');
    setSaveMessage(error instanceof Error ? error.message : 'Не удалось сохранить проект');
  }, []);

  const loadProject = useCallback(
    async (id: string) => {
      setSaveState('saving');
      setSaveMessage('Загрузка проекта...');
      try {
        const snapshot = await projectRequest(`/api/v1/projects/${id}/site-spec`);
        applySnapshot(snapshot);
      } catch (error) {
        handleFailure(error);
      }
    },
    [applySnapshot, handleFailure],
  );

  useEffect(() => {
    const id = new URL(window.location.href).searchParams.get('project');
    if (!id) return undefined;
    const loadTimer = window.setTimeout(() => void loadProject(id), 0);
    return () => window.clearTimeout(loadTimer);
  }, [loadProject]);

  const editableDraft = useMemo<EditableDraft>(
    () => ({
      companyName,
      niche,
      salesRegion,
      businessType: business,
      siteType,
      networkType: network,
    }),
    [business, companyName, network, niche, salesRegion, siteType],
  );

  const markUnsaved = () => {
    if (!projectId) return;
    setSaveState('unsaved');
    setSaveMessage('Есть несохранённые изменения');
  };

  const handleCreateProject = async () => {
    if (!companyName.trim()) {
      setSaveState('error');
      setSaveMessage('Введите название проекта или компании');
      return;
    }
    setSaveState('saving');
    setSaveMessage('Создание проекта...');
    try {
      const snapshot = await projectRequest('/api/v1/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': createIdempotencyKey(),
        },
        body: JSON.stringify({ displayName: companyName, draft: editableDraft }),
      });
      applySnapshot(snapshot);
      const url = new URL(window.location.href);
      url.searchParams.set('project', snapshot.project.id);
      window.history.replaceState(null, '', url);
    } catch (error) {
      handleFailure(error);
    }
  };

  const handleSaveDraft = async () => {
    if (!projectId || revision === null) return;
    setSaveState('saving');
    setSaveMessage('Сохранение...');
    try {
      const snapshot = await projectRequest(`/api/v1/projects/${projectId}/site-spec`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': createIdempotencyKey(),
        },
        body: JSON.stringify({ expectedRevision: revision, draft: editableDraft }),
      });
      applySnapshot(snapshot);
      if (snapshot.siteSpec.noOp) setSaveMessage(`Без изменений, revision ${snapshot.siteSpec.revision}`);
    } catch (error) {
      handleFailure(error);
    }
  };

  const selectedBusiness = businessOptions.find((item) => item.value === business) ?? businessOptions[0];
  const selectedSiteType = siteTypeOptions.find((item) => item.value === siteType) ?? siteTypeOptions[0];
  const selectedNetwork = networkOptions.find((item) => item.value === network) ?? networkOptions[0];

  const readiness = useMemo(() => {
    return [business, siteType, network].filter(Boolean).length * 20;
  }, [business, network, siteType]);

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#06090d] text-slate-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_15%_5%,rgba(249,115,22,0.18),transparent_24%),radial-gradient(circle_at_75%_0%,rgba(34,211,238,0.16),transparent_28%),linear-gradient(135deg,rgba(15,23,42,0.92),rgba(2,6,23,0.98))]" />
      <div className="relative grid min-h-screen grid-cols-[230px_minmax(0,1fr)] max-lg:grid-cols-1">
        <aside className="border-r border-white/10 bg-black/35 px-4 py-4 backdrop-blur max-lg:hidden">
          <div className="mb-5 flex items-center gap-3 px-2">
            <div className="grid size-10 place-items-center rounded-md border border-orange-500/40 bg-orange-500/15 text-orange-400">
              <Sparkles className="size-5" />
            </div>
            <div>
              <p className="text-sm font-semibold">B2B Site Studio</p>
              <p className="text-xs text-slate-500">Бриф и генерация сайтов</p>
            </div>
          </div>
          <nav className="space-y-1">
            {navItems.map(([label, Icon], index) => (
              <button
                className={`flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-sm transition ${
                  index === 0
                    ? 'border border-orange-500/35 bg-orange-500/15 text-orange-300'
                    : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
                }`}
                key={label}
                type="button"
              >
                <Icon className="size-4" />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </aside>

        <section className="flex min-w-0 flex-col">
          <header className="border-b border-white/10 bg-black/25 px-5 py-4 backdrop-blur max-sm:px-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase text-orange-300">Обзор проекта</p>
                <h1 className="mt-1 text-2xl font-semibold tracking-normal">Создание сайта под клиента</h1>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
                  Первый экран собирает только реальные входные данные: кто клиент, какой сайт он
                  заказывает и нужна ли сеть сайтов. Остальные разделы подключаются после этого
                  решения.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  className="bg-orange-500 text-white hover:bg-orange-400"
                  disabled={saveState === 'saving' || Boolean(projectId)}
                  onClick={() => void handleCreateProject()}
                >
                  {saveState === 'saving' && !projectId ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : projectId ? (
                    <Check className="size-4" />
                  ) : (
                    <FileText className="size-4" />
                  )}
                  {projectId ? 'Бриф создан' : 'Создать бриф'}
                </Button>
                <Button className="border-white/10 bg-white/5 text-slate-200 hover:bg-white/10" variant="outline">
                  <Upload className="size-4" />
                  Импорт данных
                </Button>
              </div>
            </div>
          </header>

          <div className="grid min-w-0 flex-1 gap-4 overflow-hidden p-4 xl:grid-cols-[minmax(0,1fr)_380px]">
            <section className="min-w-0 overflow-hidden rounded-lg border border-white/10 bg-[#0b1118]/90 p-4 shadow-[0_20px_60px_rgba(0,0,0,0.25)]">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <Badge className="border-cyan-400/25 bg-cyan-400/10 text-cyan-200" variant="outline">
                    Шаг 1
                  </Badge>
                  <h2 className="mt-2 text-xl font-semibold">Выбор базовой модели сайта</h2>
                </div>
                <span className="text-sm text-slate-500">3 обязательные вкладки</span>
              </div>

              <Tabs defaultValue="business">
                <TabsList
                  className="!grid !h-auto w-full grid-cols-1 overflow-hidden rounded-md border border-white/10 bg-black/25 p-1 sm:grid-cols-3"
                  variant="line"
                >
                  <TabsTrigger className="h-9 w-full min-w-0 whitespace-normal px-3 text-slate-400 data-active:text-orange-300" value="business">
                    <Building2 className="size-4" />
                    Кто клиент
                  </TabsTrigger>
                  <TabsTrigger className="h-9 w-full min-w-0 whitespace-normal px-3 text-slate-400 data-active:text-orange-300" value="site">
                    <Store className="size-4" />
                    Тип сайта
                  </TabsTrigger>
                  <TabsTrigger className="h-9 w-full min-w-0 whitespace-normal px-3 text-slate-400 data-active:text-orange-300" value="network">
                    <Network className="size-4" />
                    Сеть сайтов
                  </TabsTrigger>
                </TabsList>

                <TabsContent className="mt-4" value="business">
                  <ChoiceGrid
                    activeValue={business}
                    items={businessOptions}
                    onSelect={(value) => {
                      setBusiness(value);
                      markUnsaved();
                    }}
                    title="Кто заказывает сайт"
                  />
                  <BriefFields
                    fields={[
                      ['Название компании', ''],
                      ['Ниша или направление', ''],
                      ['Регион продаж', ''],
                    ]}
                    note="Здесь фиксируем, кто клиент, кому он продает и чем отличается от конкурентов."
                    onValueChange={(index, value) => {
                      if (index === 0) setCompanyName(value);
                      if (index === 1) setNiche(value);
                      if (index === 2) setSalesRegion(value);
                      markUnsaved();
                    }}
                    values={[companyName, niche, salesRegion]}
                  />
                </TabsContent>

                <TabsContent className="mt-4" value="site">
                  <ChoiceGrid
                    activeValue={siteType}
                    items={siteTypeOptions}
                    onSelect={(value) => {
                      setSiteType(value);
                      markUnsaved();
                    }}
                    title="Какой сайт нужно создать"
                  />
                  <div className="mt-4 rounded-md border border-white/10 bg-black/25 p-4">
                    <p className="text-sm font-medium text-slate-100">Какие страницы нужны</p>
                    <p className="mt-2 text-sm leading-6 text-slate-400">{selectedSiteType.pages}</p>
                  </div>
                  <BriefFields
                    fields={[
                      ['Главная цель', 'заявка, звонок, прайс или консультация'],
                      ['Нужны цены?', 'показывать, скрывать или по запросу'],
                      ['Страницы под товары', 'каждый товар, категории или только подборки'],
                    ]}
                    note="Этот выбор определяет, будет ли генератор делать лендинг, многостраничник, каталог или SEO-сеть."
                  />
                </TabsContent>

                <TabsContent className="mt-4" value="network">
                  <ChoiceGrid
                    activeValue={network}
                    items={networkOptions}
                    onSelect={(value) => {
                      setNetwork(value);
                      markUnsaved();
                    }}
                    title="Один сайт или сеть"
                  />
                  <div className="mt-4 grid gap-2 md:grid-cols-2">
                    {networkDataRules.map(([label, rule]) => (
                      <div className="rounded-md border border-cyan-400/15 bg-cyan-400/10 p-3" key={label}>
                        <p className="text-sm font-medium text-cyan-200">{label}</p>
                        <p className="mt-1 text-sm leading-5 text-slate-400">{rule}</p>
                      </div>
                    ))}
                  </div>
                  <BriefFields
                    fields={[
                      ['Количество сайтов', '1, несколько регионов или отдельные домены'],
                      ['Контакты', 'общие или отдельные для каждого сайта'],
                      ['Медиа и каталог', 'единые или разные по сайтам'],
                    ]}
                    note="Так мы заранее понимаем, какие данные наследовать всей сетью, а какие хранить отдельно."
                  />
                </TabsContent>
              </Tabs>
            </section>

            <aside className="min-w-0 space-y-4">
              <section className="rounded-lg border border-white/10 bg-[#0b1118]/90 p-4 shadow-[0_20px_60px_rgba(0,0,0,0.25)]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">Текущий выбор</p>
                    <p className="mt-1 text-xs text-slate-500">То, что уже понятно генератору</p>
                  </div>
                  <span className="rounded-md border border-emerald-400/25 bg-emerald-400/10 px-2 py-1 text-sm text-emerald-300">
                    {readiness}%
                  </span>
                </div>
                <Progress className="mt-4" value={readiness}>
                  <ProgressLabel className="text-xs text-slate-500">База брифа</ProgressLabel>
                  <span className="ml-auto text-xs tabular-nums text-cyan-200">{readiness}%</span>
                </Progress>

                <div className="mt-5 space-y-3">
                  <SummaryRow label="Клиент" value={selectedBusiness.title} />
                  <SummaryRow label="Сайт" value={selectedSiteType.title} />
                  <SummaryRow label="Сеть" value={selectedNetwork.title} />
                </div>

                <div className="mt-4 rounded-md border border-white/10 bg-black/25 px-3 py-3" aria-live="polite">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-slate-500">{projectId ? `Проект ${projectId.slice(0, 8)}` : 'Проект не создан'}</span>
                    <span className={saveState === 'conflict' || saveState === 'error' ? 'text-rose-300' : saveState === 'unavailable' ? 'text-amber-300' : 'text-cyan-200'}>
                      {revision === null ? 'draft' : `revision ${revision}`}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-slate-300">{saveMessage}</p>
                </div>

                <Button
                  className="mt-3 w-full border-white/10 bg-white/5 text-slate-100 hover:bg-white/10"
                  disabled={!projectId || revision === null || saveState === 'saving'}
                  onClick={() => void handleSaveDraft()}
                  variant="outline"
                >
                  {saveState === 'saving' && projectId ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Save className="size-4" />
                  )}
                  Сохранить черновик
                </Button>

                {saveState === 'conflict' && projectId ? (
                  <Button
                    className="mt-2 w-full text-slate-300 hover:bg-white/5"
                    onClick={() => void loadProject(projectId)}
                    variant="ghost"
                  >
                    <RefreshCw className="size-4" />
                    Загрузить актуальную revision
                  </Button>
                ) : null}

                <Button className="mt-5 w-full bg-orange-500 text-white hover:bg-orange-400">
                  Продолжить к товарам и SEO
                  <ArrowRight className="size-4" />
                </Button>
              </section>

              <section className="rounded-lg border border-white/10 bg-[#0b1118]/90 p-4">
                <p className="text-sm font-semibold">Следующие блоки брифа</p>
                <div className="mt-3 space-y-2">
                  {followUpBlocks.map(([title, description]) => (
                    <div className="flex gap-3 rounded-md border border-white/10 bg-white/[0.035] p-3" key={title}>
                      <ChevronRight className="mt-0.5 size-4 shrink-0 text-orange-300" />
                      <div>
                        <p className="text-sm font-medium text-slate-200">{title}</p>
                        <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </aside>
          </div>
        </section>
      </div>
    </main>
  );
}

function ChoiceGrid({
  activeValue,
  items,
  onSelect,
  title,
}: {
  activeValue: string;
  items: readonly {
    description: string;
    title: string;
    value: string;
  }[];
  onSelect: (value: string) => void;
  title: string;
}) {
  return (
    <div>
      <p className="text-sm font-semibold">{title}</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {items.map((item) => {
          const active = item.value === activeValue;

          return (
            <button
              className={`min-h-[118px] min-w-0 overflow-hidden rounded-md border p-4 text-left transition ${
                active
                  ? 'border-orange-500/55 bg-orange-500/15 shadow-[0_0_0_1px_rgba(249,115,22,0.12)]'
                  : 'border-white/10 bg-white/[0.035] hover:border-cyan-400/35 hover:bg-cyan-400/10'
              }`}
              key={item.value}
              onClick={() => onSelect(item.value)}
              type="button"
            >
              <span className="flex min-w-0 items-center justify-between gap-3">
                <span className={`min-w-0 break-words ${active ? 'text-orange-200' : 'text-slate-100'}`}>{item.title}</span>
                {active ? <Check className="size-4 text-orange-300" /> : null}
              </span>
              <span className="mt-2 block break-words text-sm leading-6 text-slate-400">{item.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BriefFields({
  fields,
  note,
  onValueChange,
  values,
}: {
  fields: readonly (readonly [string, string])[];
  note: string;
  onValueChange?: (index: number, value: string) => void;
  values?: readonly string[];
}) {
  return (
    <div className="mt-4 rounded-md border border-white/10 bg-white/[0.025] p-4">
      <div className="flex items-start gap-3">
        <ListChecks className="mt-0.5 size-5 shrink-0 text-cyan-300" />
        <p className="text-sm leading-6 text-slate-400">{note}</p>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {fields.map(([label, placeholder], index) => (
          <label className="block min-w-0" key={label}>
            <span className="mb-1 block text-xs text-slate-500">{label}</span>
            <Input
              className="h-9 border-white/10 bg-black/25 text-slate-100"
              onChange={onValueChange ? (event) => onValueChange(index, event.target.value) : undefined}
              placeholder={placeholder}
              value={values?.[index]}
            />
          </label>
        ))}
      </div>
      <label className="mt-3 block" htmlFor="brief-notes">
        <span className="mb-1 block text-xs text-slate-500">Важные ограничения</span>
        <Textarea
          className="min-h-20 border-white/10 bg-black/25 text-sm text-slate-100"
          id="brief-notes"
          placeholder="Например: не выдумывать отзывы, сертификаты, сроки поставки, адреса и гарантии без подтверждения."
        />
      </label>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-white/10 bg-white/[0.035] px-3 py-2">
      <span className="text-sm text-slate-500">{label}</span>
      <span className="text-right text-sm font-medium text-slate-100">{value}</span>
    </div>
  );
}
