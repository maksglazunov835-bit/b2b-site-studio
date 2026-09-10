import {
  ADAPTER,
  DESIGN_SETTINGS,
  expectedPages,
} from '../../server/design/contract.mjs';
export const runtime = {
  provider: 'test_stub',
  cliVersion: 'test-cli-1',
  model: DESIGN_SETTINGS.model,
  effort: DESIGN_SETTINGS.effort,
  policySha256: ADAPTER.sha256,
  status: 'ready',
  modelSelection: {
    source: 'test_fixture',
    resolvedModel: DESIGN_SETTINGS.model,
    effort: DESIGN_SETTINGS.effort,
    supportedReasoningEfforts: [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ],
  },
};
export const brief = {
  companyName: 'Synthetic catalog',
  niche: 'Stationery',
  salesRegion: '',
  businessType: 'wholesale',
  siteType: 'catalog',
  networkType: 'single',
};
// Contract fixture only. It does not assert real WSL isolation or inference.
export const officialRuntime = () => ({...runtime,provider:'codex',cliVersion:'0.153.4',
  modelSelection:{...runtime.modelSelection,source:'official_model_list'},
  admission:{transport:'wsl2',profile:'b2b-design-json',checkedAt:new Date().toISOString(),configSha256:'a'.repeat(64)}});
export function proposal(input = brief) {
  const blocks = {
    home: ['hero', 'categories', 'enquiry'],
    catalog: ['categories', 'products'],
    product: ['specifications', 'enquiry'],
    about: ['about', 'enquiry'],
    contact: ['about', 'enquiry'],
  };
  return {
    schemaVersion: '1.0.0',
    placeholderPolicy: 'labelled-neutral-no-facts',
    concepts: ['catalog-grid', 'editorial', 'compact'].map(
      (layoutVariant, i) => ({
        id: `concept-${i + 1}`,
        name: ['Grid', 'Editorial', 'Compact'][i],
        rationale: [
          'Structured categories and a clear enquiry area.',
          'Typography with a vertical composition.',
          'Dense navigation and product comparison.',
        ][i],
        layoutVariant,
        palette: [
          {
            background: '#FFFFFF',
            surface: '#F2F4F3',
            text: '#181D1A',
            accent: '#174C38',
            accentText: '#FFFFFF',
            border: '#8A9B91',
          },
          {
            background: '#FAFAFA',
            surface: '#F0EFF4',
            text: '#23212A',
            accent: '#703544',
            accentText: '#FFFFFF',
            border: '#9F949A',
          },
          {
            background: '#151719',
            surface: '#232629',
            text: '#F4F6F7',
            accent: '#F2C849',
            accentText: '#181818',
            border: '#82898F',
          },
        ][i],
        fontPreset: ['sans', 'serif', 'mono'][i],
        density: ['balanced', 'spacious', 'compact'][i],
        radius: ['subtle', 'square', 'soft'][i],
        pages: expectedPages(input).map((id) => ({
          id,
          blocks: [...blocks[id]],
        })),
        mobile: { navigation: 'stacked', columns: 1, textSize: 'readable' },
      }),
    ),
  };
}
