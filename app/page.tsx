'use client';

import type { ReactNode } from 'react';
import {
  Activity,
  BarChart3,
  Bot,
  Box,
  Boxes,
  Check,
  ChevronDown,
  CircleDollarSign,
  FileText,
  Gauge,
  Globe2,
  Layers3,
  LayoutDashboard,
  Link2,
  Rocket,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

const navItems = [
  ['Обзор', LayoutDashboard],
  ['Проекты', Boxes],
  ['Ниши и товары', Search],
  ['Шаблоны', Layers3],
  ['Структура сайта', FileText],
  ['SEO и семантика', BarChart3],
  ['Контент', Bot],
  ['Каталог товаров', Box],
  ['Публикация', Rocket],
  ['Аналитика', Activity],
  ['Настройки', Settings],
] as const;

const stats = [
  ['Проектов', '128', '+12%'],
  ['Сайтов опубликовано', '24', '+8%'],
  ['Органический трафик', '248.6K', '+18%'],
  ['Семантика', '89.3K', '+21%'],
  ['Оптимизация', '68%', '+9%'],
];

const niches = [
  'Одежда и текстиль',
  'Меховые изделия',
  'Воздушные шары',
  'Обувь',
  'Сумки и аксессуары',
  'Электроника',
  'Товары для дома',
  'Автозапчасти',
  'Косметика',
  'Игрушки',
  'Стройматериалы',
  'Другое',
];

const templates = [
  ['Fashion Wholesale', 'B2B fashion catalog', '89%'],
  ['Nordic Fur', 'Premium winter goods', '93%'],
  ['Balloon Wholesale', 'Events and party supply', '86%'],
  ['Clean B2B', 'Minimal distributor site', '91%'],
];

const pages = [
  ['Главная', 'Лендинг + каталог', 'Готово'],
  ['Каталог', '4 раздела, фильтры', 'Готово'],
  ['Платья оптом', 'SEO-страница', 'В работе'],
  ['Куртки женские', 'SEO-страница', 'Готово'],
  ['Доставка и оплата', 'Сервисная', 'Готово'],
  ['Контакты', 'Форма заявки', 'Готово'],
];

const traffic = [
  { day: '1 мая', organic: 780, ads: 520 },
  { day: '7 мая', organic: 940, ads: 580 },
  { day: '13 мая', organic: 1110, ads: 700 },
  { day: '19 мая', organic: 1360, ads: 840 },
  { day: '25 мая', organic: 1290, ads: 790 },
  { day: '31 мая', organic: 1580, ads: 920 },
];

const semantics = [
  { page: '/platya-optom', queries: 243 },
  { page: '/kostyumy-optom', queries: 198 },
  { page: '/kurтki-optom', queries: 156 },
  { page: '/yubki-optom', queries: 142 },
  { page: '/zhenskaya-odezhda-optom', queries: 118 },
];

const channels = [
  { name: 'Органика', value: 68, color: '#10b981' },
  { name: 'Прямые', value: 18, color: '#22d3ee' },
  { name: 'Рефералы', value: 7, color: '#f97316' },
  { name: 'Соцсети', value: 5, color: '#a78bfa' },
  { name: 'Реклама', value: 2, color: '#f43f5e' },
];

const products = [
  ['Платье вечернее черное', 'Женские платья', 'PL-1001', '1 650 ₽', 'В наличии'],
  ['Платье летнее цветное', 'Женские платья', 'PL-1002', '1 250 ₽', 'В наличии'],
  ['Куртка экокожа', 'Женские куртки', 'JK-2001', '2 990 ₽', 'В наличии'],
  ['Блуза шелковая белая', 'Женские блузы', 'BL-3001', '980 ₽', 'Служебное'],
];

const aiFeatures = [
  [Bot, 'AI-генерация сайтов под ключ'],
  [CircleDollarSign, 'SEO и семантика из тысяч запросов'],
  [Link2, 'Интеграции и импорт данных'],
  [Gauge, 'Масштабирование сети сайтов'],
  [ShieldCheck, 'Контроль уникальности и качества'],
] as const;

export default function Home() {
  return (
    <main className="min-h-screen bg-[#06090d] text-slate-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_15%_5%,rgba(249,115,22,0.18),transparent_24%),radial-gradient(circle_at_75%_0%,rgba(34,211,238,0.16),transparent_28%),linear-gradient(135deg,rgba(15,23,42,0.92),rgba(2,6,23,0.98))]" />
      <div className="relative grid min-h-screen grid-cols-[230px_minmax(0,1fr)] max-lg:grid-cols-1">
        <aside className="border-r border-white/10 bg-black/35 px-4 py-4 backdrop-blur max-lg:hidden">
          <div className="mb-5 flex items-center gap-3 px-2">
            <div className="grid size-10 place-items-center rounded-md border border-orange-500/40 bg-orange-500/15 text-orange-400">
              <Sparkles className="size-5" />
            </div>
            <div>
              <p className="text-sm font-semibold">B2B Site Studio</p>
              <p className="text-xs text-slate-500">SEO-сайты оптовиков</p>
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
          <header className="border-b border-white/10 bg-black/25 px-5 py-4 backdrop-blur">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase text-orange-300">
                  Вариант 2
                </p>
                <h1 className="text-2xl font-semibold tracking-normal">
                  B2B Site Studio
                </h1>
                <p className="mt-1 max-w-2xl text-sm text-slate-400">
                  Платформа для автоматического создания SEO-оптимизированных
                  сайтов оптовых компаний.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button className="bg-orange-500 text-white hover:bg-orange-400">
                  <Rocket className="size-4" />
                  Создать проект
                </Button>
                <Button
                  className="border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"
                  variant="outline"
                >
                  <Upload className="size-4" />
                  Импорт
                </Button>
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {stats.map(([label, value, delta]) => (
                <div
                  className="rounded-lg border border-white/10 bg-white/[0.045] p-4"
                  key={label}
                >
                  <p className="text-xs text-slate-500">{label}</p>
                  <div className="mt-2 flex items-end justify-between">
                    <strong className="text-2xl font-semibold">{value}</strong>
                    <span className="text-xs font-medium text-emerald-400">
                      {delta}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </header>

          <div className="grid flex-1 gap-4 p-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.65fr)]">
            <div className="space-y-4">
              <section className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(340px,0.9fr)]">
                <Panel title="Аналитика трафика" action="30 дней">
                  <div className="h-[250px] min-w-0">
                    <TrafficChart />
                  </div>
                </Panel>

                <Panel title="Выбор ниши и товаров" action="Шаг 1 из 3">
                  <div className="relative mb-3">
                    <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
                    <Input
                      className="h-10 border-white/10 bg-black/30 pl-9 text-slate-100"
                      placeholder="Поиск ниши"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {niches.map((niche, index) => (
                      <button
                        className={`min-h-12 rounded-md border px-3 text-left text-sm transition ${
                          index === 0
                            ? 'border-orange-500 bg-orange-500/15 text-orange-200'
                            : 'border-white/10 bg-white/[0.035] text-slate-300 hover:bg-white/[0.07]'
                        }`}
                        key={niche}
                        type="button"
                      >
                        {niche}
                      </button>
                    ))}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {['Женская одежда', 'Платья', 'Куртки', 'Блузы'].map((tag) => (
                      <span
                        className="rounded-md border border-cyan-400/20 bg-cyan-400/10 px-2 py-1 text-xs text-cyan-200"
                        key={tag}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </Panel>
              </section>

              <section className="grid gap-4 lg:grid-cols-2">
                <Panel title="Библиотека шаблонов" action="4 из 28">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {templates.map(([name, desc, match], index) => (
                      <article
                        className="overflow-hidden rounded-lg border border-white/10 bg-black/25"
                        key={name}
                      >
                        <div className="h-24 bg-[linear-gradient(135deg,rgba(249,115,22,0.2),rgba(34,211,238,0.12)),repeating-linear-gradient(90deg,rgba(255,255,255,0.08)_0_1px,transparent_1px_24px)]" />
                        <div className="p-3">
                          <div className="flex items-center justify-between gap-2">
                            <h3 className="text-sm font-medium">{name}</h3>
                            {index === 1 ? (
                              <Check className="size-4 text-emerald-400" />
                            ) : null}
                          </div>
                          <p className="mt-1 text-xs text-slate-500">{desc}</p>
                          <p className="mt-3 text-xs text-orange-300">
                            Совпадение: {match}
                          </p>
                        </div>
                      </article>
                    ))}
                  </div>
                </Panel>

                <Panel title="Структура сайта и страницы" action="Добавить страницу">
                  <div className="space-y-2">
                    {pages.map(([name, detail, status], index) => (
                      <div
                        className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-white/10 bg-white/[0.035] p-3"
                        key={name}
                      >
                        <span className="grid size-6 place-items-center rounded bg-white/5 text-xs text-slate-400">
                          {index + 1}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{name}</p>
                          <p className="truncate text-xs text-slate-500">{detail}</p>
                        </div>
                        <span
                          className={`rounded px-2 py-1 text-xs ${
                            status === 'Готово'
                              ? 'bg-emerald-400/10 text-emerald-300'
                              : 'bg-orange-400/10 text-orange-300'
                          }`}
                        >
                          {status}
                        </span>
                      </div>
                    ))}
                  </div>
                </Panel>
              </section>

              <section className="grid gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                <Panel title="Уникализация контента" action="AI-генерация">
                  <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_230px]">
                    <div>
                      <p className="text-sm font-medium">Платья оптом от производителя</p>
                      <p className="mt-3 text-sm leading-6 text-slate-400">
                        Система собирает структуру страницы, распределяет
                        ключевые запросы и готовит уникальный текст под
                        выбранную нишу, регион и шаблон сайта.
                      </p>
                      <div className="mt-5 grid gap-2">
                        {['Уникальность', 'FAQ', 'Призыв к действию'].map((item) => (
                          <label
                            className="flex items-center justify-between rounded-md border border-white/10 bg-white/[0.035] px-3 py-2 text-sm"
                            key={item}
                          >
                            <span>{item}</span>
                            <Switch defaultChecked />
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-black/25 p-4">
                      <p className="text-xs uppercase text-slate-500">Готовность</p>
                      <strong className="mt-2 block text-3xl text-emerald-300">96%</strong>
                      <div className="mt-4 h-2 rounded-full bg-white/10">
                        <div className="h-full w-[96%] rounded-full bg-emerald-400" />
                      </div>
                      <Button className="mt-5 w-full bg-orange-500 text-white hover:bg-orange-400">
                        Сгенерировать
                      </Button>
                    </div>
                  </div>
                </Panel>

                <Panel title="Каталог товаров / импорт" action="Загрузить файл">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-left text-sm">
                      <thead className="text-xs text-slate-500">
                        <tr>
                          <th className="pb-3 font-medium">Товар</th>
                          <th className="pb-3 font-medium">Категория</th>
                          <th className="pb-3 font-medium">Артикул</th>
                          <th className="pb-3 font-medium">Цена</th>
                          <th className="pb-3 font-medium">Статус</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/10">
                        {products.map((product) => (
                          <tr key={product[2]}>
                            {product.map((cell, index) => (
                              <td
                                className={`py-3 ${
                                  index === 4 ? 'text-emerald-300' : 'text-slate-300'
                                }`}
                                key={cell}
                              >
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              </section>
            </div>

            <div className="space-y-4">
              <Panel title="SEO и семантика" action="Экспорт">
                <div className="grid grid-cols-2 gap-3">
                  {[
                    ['Запросов', '45.7K'],
                    ['Потенциал трафика', '18.2K'],
                    ['Страниц в кластере', '32'],
                    ['Оптимизация', '68%'],
                  ].map(([label, value]) => (
                    <div className="rounded-lg border border-white/10 bg-black/25 p-3" key={label}>
                      <p className="text-xs text-slate-500">{label}</p>
                      <strong className="mt-1 block text-xl">{value}</strong>
                    </div>
                  ))}
                </div>
                <div className="mt-5">
                  <SemanticBars />
                </div>
              </Panel>

              <Panel title="Публикация / домены / аналитика" action="Опубликовать">
                <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-4">
                  <p className="text-xs text-emerald-300">Сайт готов к публикации</p>
                  <div className="mt-3 flex items-center justify-between gap-4">
                    <div>
                      <p className="font-medium">opt-odezhda.ru</p>
                      <p className="text-xs text-slate-400">SSL, sitemap, robots.txt</p>
                    </div>
                    <Globe2 className="size-8 text-emerald-300" />
                  </div>
                </div>
                <div className="mt-5 grid grid-cols-[120px_minmax(0,1fr)] gap-4 max-sm:grid-cols-1">
                  <div className="grid h-[140px] place-items-center">
                    <div
                      aria-label="Каналы трафика"
                      className="relative size-28 rounded-full"
                      style={{
                        background:
                          'conic-gradient(#10b981 0 68%, #22d3ee 68% 86%, #f97316 86% 93%, #a78bfa 93% 98%, #f43f5e 98% 100%)',
                      }}
                    >
                      <span className="absolute inset-6 rounded-full bg-[#0b1118]" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    {channels.map((channel) => (
                      <div className="flex items-center justify-between text-sm" key={channel.name}>
                        <span className="flex items-center gap-2 text-slate-400">
                          <span
                            className="size-2 rounded-full"
                            style={{ backgroundColor: channel.color }}
                          />
                          {channel.name}
                        </span>
                        <span>{channel.value}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              </Panel>

              <Panel title="AI-ядро проекта" action="Ключи">
                <div className="space-y-3">
                  {aiFeatures.map(([Icon, label]) => (
                    <div
                      className="flex items-center gap-3 rounded-md border border-white/10 bg-white/[0.035] p-3 text-sm"
                      key={label}
                    >
                      <Icon className="size-4 text-cyan-300" />
                      <span>{label}</span>
                    </div>
                  ))}
                </div>
              </Panel>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function TrafficChart() {
  const max = Math.max(...traffic.flatMap((point) => [point.organic, point.ads]));
  const linePoints = (key: 'organic' | 'ads') =>
    traffic
      .map((point, index) => {
        const x = 48 + index * 124;
        const y = 206 - (point[key] / max) * 156;
        return `${x},${y}`;
      })
      .join(' ');

  return (
    <svg aria-label="Динамика трафика" className="h-full w-full" viewBox="0 0 720 250">
      <defs>
        <linearGradient id="trafficFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#22d3ee" stopOpacity="0.24" />
          <stop offset="1" stopColor="#22d3ee" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[50, 90, 130, 170, 210].map((y) => (
        <line key={y} stroke="#1f2937" strokeDasharray="4 6" x1="34" x2="690" y1={y} y2={y} />
      ))}
      <polygon fill="url(#trafficFill)" points={`48,206 ${linePoints('organic')} 668,206`} />
      <polyline fill="none" points={linePoints('organic')} stroke="#22d3ee" strokeLinecap="round" strokeWidth="4" />
      <polyline fill="none" points={linePoints('ads')} stroke="#f97316" strokeLinecap="round" strokeWidth="4" />
      {traffic.map((point, index) => (
        <text fill="#64748b" fontSize="18" key={point.day} textAnchor="middle" x={48 + index * 124} y="236">
          {point.day}
        </text>
      ))}
    </svg>
  );
}

function SemanticBars() {
  const max = Math.max(...semantics.map((item) => item.queries));

  return (
    <div className="space-y-3">
      {semantics.map((item) => (
        <div className="grid grid-cols-[150px_minmax(0,1fr)_36px] items-center gap-3 text-sm" key={item.page}>
          <span className="truncate text-slate-400">{item.page}</span>
          <div className="h-8 rounded-md bg-white/[0.055]">
            <div
              className="h-full rounded-md bg-cyan-400/75"
              style={{ width: `${Math.round((item.queries / max) * 100)}%` }}
            />
          </div>
          <span className="text-right text-slate-300">{item.queries}</span>
        </div>
      ))}
    </div>
  );
}

function Panel({
  action,
  children,
  title,
}: {
  action: string;
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="rounded-lg border border-white/10 bg-[#0b1118]/90 p-4 shadow-[0_20px_60px_rgba(0,0,0,0.25)]">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <button
          className="flex h-8 items-center gap-1 rounded-md border border-white/10 bg-white/[0.035] px-2.5 text-xs text-slate-300 transition hover:bg-white/[0.07]"
          type="button"
        >
          {action}
          <ChevronDown className="size-3" />
        </button>
      </div>
      {children}
    </section>
  );
}
