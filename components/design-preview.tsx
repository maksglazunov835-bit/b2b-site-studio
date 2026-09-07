'use client';
import { useEffect, useRef, useState } from 'react';
import {
  Monitor,
  Smartphone,
  X,
  Package,
  ArrowRight,
  Layers,
  Eye,
} from 'lucide-react';
import { Button } from './ui/button';
type Concept = {
  id: string;
  name: string;
  rationale: string;
  layoutVariant: 'catalog-grid' | 'editorial' | 'compact';
  palette: Record<
    'background' | 'surface' | 'text' | 'accent' | 'accentText' | 'border',
    string
  >;
  fontPreset: 'sans' | 'serif' | 'mono';
  density: 'compact' | 'balanced' | 'spacious';
  radius: 'square' | 'subtle' | 'soft';
  pages: { id: string; blocks: string[] }[];
};
export type DesignReport = {
  provider: string;
  cliVersion: string;
  model: string;
  providerInvocations: number;
  proposal: { concepts: Concept[] };
};
const pageNames: Record<string, string> = {
  home: 'Главная',
  catalog: 'Каталог',
  product: 'Карточка товара',
  about: 'О компании',
  contact: 'Контакты',
};
const fonts = {
  sans: 'Arial, sans-serif',
  serif: 'Georgia, serif',
  mono: 'Consolas, monospace',
};
export function DesignPreview({ report }: { report: DesignReport }) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState('home');
  const [mobile, setMobile] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);
  const concepts = report.proposal?.concepts;
  if (!Array.isArray(concepts) || concepts.length !== 3)
    return <p>Результат недоступен</p>;
  const concept = concepts[index];
  if (
    !concept ||
    Object.values(concept.palette).some(
      (color) => !/^#[0-9a-f]{6}$/i.test(color),
    )
  )
    return <p>Результат отклонён</p>;
  const palette = concept.palette;
  const radius = { square: 0, subtle: 4, soft: 8 }[concept.radius] ?? 0;
  const gap =
    { compact: 12, balanced: 20, spacious: 28 }[concept.density] ?? 20;
  const blocks = concept.pages.find((item) => item.id === page)?.blocks ?? [];
  const content = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 p-3">
        <h3 className="text-sm font-semibold">
          Три концепции ·{' '}
          {report.provider === 'test_stub'
            ? 'Тестовый CLI, не Codex'
            : `Codex ${report.cliVersion}`}
        </h3>
        {open && (
          <Button
            size="icon"
            variant="ghost"
            aria-label="Закрыть предпросмотр"
            title="Закрыть предпросмотр"
            onClick={() => setOpen(false)}
          >
            <X />
          </Button>
        )}
      </div>
      <div
        className="flex flex-wrap gap-2 p-3"
        role="tablist"
        aria-label="Концепции"
      >
        {concepts.map((item, i) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={index === i}
            className={`min-h-9 border-b-2 px-3 text-sm ${index === i ? 'border-orange-500 text-white' : 'border-transparent text-gray-400'}`}
            onClick={() => {
              setIndex(i);
              setPage('home');
            }}
          >
            {item.name}
          </button>
        ))}
      </div>
      <p className="px-4 text-sm text-gray-300">{concept.rationale}</p>
      <div className="flex flex-wrap items-center justify-between gap-2 p-3">
        <div
          className="flex flex-wrap gap-2"
          role="tablist"
          aria-label="Страницы концепции"
        >
          {concept.pages.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={page === item.id}
              className="border-b border-gray-600 px-2 py-2 text-xs"
              onClick={() => setPage(item.id)}
            >
              {pageNames[item.id]}
            </button>
          ))}
        </div>
        <div className="flex">
          <Button
            size="icon"
            variant="ghost"
            title="Desktop"
            aria-label="Desktop"
            aria-pressed={!mobile}
            onClick={() => setMobile(false)}
          >
            <Monitor />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title="Mobile"
            aria-label="Mobile"
            aria-pressed={mobile}
            onClick={() => setMobile(true)}
          >
            <Smartphone />
          </Button>
        </div>
      </div>
      <div className="overflow-auto bg-[#202426] p-3">
        <article
          data-design-preview={concept.id}
          data-preview-page={page}
          className="mx-auto min-w-0"
          style={{
            maxWidth: mobile ? 390 : 1040,
            background: palette.background,
            color: palette.text,
            fontFamily: fonts[concept.fontPreset] ?? fonts.sans,
            letterSpacing: 0,
            padding: gap,
          }}
        >
          <p
            className="mb-4 border-b pb-2 text-xs"
            style={{ borderColor: palette.border }}
          >
            МАКЕТ · Нейтральные заполнители, не факты компании
          </p>
          <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <strong className="flex items-center gap-2 text-lg">
              <Layers size={24} />
              Название компании
            </strong>
            <span className="text-sm">{pageNames[page]}</span>
          </header>
          <div style={{ display: 'grid', gap }}>
            {blocks.map((block) => (
              <section
                key={block}
                style={{
                  borderTop: `1px solid ${palette.border}`,
                  paddingTop: gap,
                }}
              >
                {block === 'hero' && (
                  <>
                    <p className="mb-2 text-xs">КОНЦЕПЦИЯ СТРУКТУРЫ</p>
                    <h2 className="mb-3 text-2xl font-semibold">
                      {concept.pages.some((item) => item.id === 'catalog')
                        ? 'Каталог вашей компании'
                        : 'Ваша компания'}
                    </h2>
                    <p className="mb-4 text-sm">
                      Место для подтверждённого описания бизнеса
                    </p>
                    <span
                      className="inline-flex items-center gap-2 px-4 py-3 text-sm"
                      style={{
                        background: palette.accent,
                        color: palette.accentText,
                        borderRadius: radius,
                      }}
                    >
                      Подробнее <ArrowRight size={16} />
                    </span>
                  </>
                )}
                {(block === 'categories' || block === 'products') && (
                  <>
                    <h3 className="mb-3 text-lg font-semibold">
                      {block === 'categories' ? 'Категории' : 'Товары'}
                    </h3>
                    <div
                      className={
                        mobile || concept.layoutVariant === 'editorial'
                          ? 'grid grid-cols-1 gap-3'
                          : 'grid grid-cols-1 gap-3 sm:grid-cols-3'
                      }
                    >
                      {[1, 2, 3].map((n) => (
                        <div
                          key={n}
                          style={{
                            background: palette.surface,
                            border: `1px solid ${palette.border}`,
                            borderRadius: radius,
                            padding: gap,
                          }}
                        >
                          <div className="mb-3 flex aspect-[4/3] items-center justify-center">
                            <Package
                              size={
                                concept.layoutVariant === 'compact' ? 36 : 64
                              }
                              strokeWidth={1}
                            />
                          </div>
                          <p className="text-sm font-semibold">
                            {block === 'categories' ? 'Категория' : 'Товар'} {n}
                          </p>
                          <p className="mt-1 text-xs">Макетный заполнитель</p>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {block === 'specifications' && (
                  <>
                    <div
                      className="mb-3 flex aspect-[3/1] items-center justify-center"
                      style={{ background: palette.surface }}
                    >
                      <Package size={80} strokeWidth={1} />
                    </div>
                    <h3 className="text-lg font-semibold">Название товара</h3>
                    <p className="mt-2 text-sm">
                      Характеристики будут взяты из каталога. Цена и наличие не
                      указаны.
                    </p>
                  </>
                )}
                {block === 'about' && (
                  <>
                    <h3 className="text-lg font-semibold">
                      Информация компании
                    </h3>
                    <p className="mt-2 text-sm">
                      Место для подтверждённых сведений. Контакты не указаны.
                    </p>
                  </>
                )}
                {block === 'enquiry' && (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm">
                      Место для согласованной формы заявки
                    </p>
                    <span
                      className="px-4 py-3 text-sm"
                      style={{
                        background: palette.accent,
                        color: palette.accentText,
                        borderRadius: radius,
                      }}
                    >
                      Форма · макет
                    </span>
                  </div>
                )}
              </section>
            ))}
          </div>
          <footer
            className="mt-6 border-t pt-3 text-xs"
            style={{ borderColor: palette.border }}
          >
            Концепция дизайна · не опубликованный сайт
          </footer>
        </article>
      </div>
    </>
  );
  return (
    <div className="mt-3 min-w-0 border-t border-white/10 pt-3">
      <p className="text-xs text-gray-400">
        {report.provider === 'test_stub'
          ? 'Тестовый результат, не модельная генерация'
          : `Провайдер: Codex · ${report.model}`}{' '}
        · вызовов: {report.providerInvocations}
      </p>
      <Button
        variant="ghost"
        className="mt-2 h-auto whitespace-normal"
        onClick={() => setOpen(true)}
      >
        <Eye className="size-4" />
        Открыть три концепции
      </Button>
      {open && (
        <dialog
          ref={dialog}
          aria-label="Предпросмотр дизайна"
          className="fixed inset-0 z-50 m-0 h-full max-h-none w-full max-w-none overflow-auto bg-black/90 p-2 sm:p-6"
          onCancel={() => setOpen(false)}
        >
          <div className="mx-auto max-w-6xl rounded border border-white/20 bg-[#101416] text-white">
            {content}
          </div>
        </dialog>
      )}
    </div>
  );
}
