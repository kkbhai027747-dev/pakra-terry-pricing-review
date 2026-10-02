import fs from 'node:fs';
import assert from 'node:assert/strict';
import { calculateOrderMarginPrices } from '../source/pokemon-single-card-sync/order-margin-pricing.mjs';

const { records } = JSON.parse(fs.readFileSync(new URL('../data/historical-pricing-samples-10.json', import.meta.url), 'utf8'));
assert.equal(records.length, 10);
const results = records.map(row => {
  const source = row.historical_source_asking_price_cny;
  const price = calculateOrderMarginPrices({ procurementCny: source }).reference40.saleUsd.toFixed(2);
  assert.equal(price, row.recomputed_price_usd, `${row.sample_id}: exported calculation differs`);
  assert.equal(price, row.historical_shopify_price_usd, `${row.sample_id}: saved Shopify price differs`);
  assert.equal(row.condition_filtered, false);
  assert.equal(row.verified_wrong_price_example, false);
  return {
    sample: row.sample_id, card: row.card_number, language: row.language,
    source_cny: source, observed_at_utc: row.source_quote_observed_at_utc,
    recomputed_usd: price, historical_shopify_usd: row.historical_shopify_price_usd,
    arithmetic_match: true,
  };
});
console.log(JSON.stringify({
  purpose: 'Offline reproduction of historical arithmetic; not market-value or current-price verification.',
  count: results.length, results,
}, null, 2));
