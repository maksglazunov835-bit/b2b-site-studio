import schema from '../../docs/contracts/design-proposal.wire.schema.json' with { type: 'json' };
import { promptFor } from './design-input.mjs';

// Fixed operator diagnostic input. No request-selected program, schema or brief.
export function preparationInput() {
  return {
    schema,
    prompt: promptFor({
      niche: 'Stationery',
      businessType: 'wholesale',
      siteType: 'catalog',
      networkType: 'single',
      salesRegion: '',
      companyName: 'Synthetic stationery catalog',
    }),
  };
}
