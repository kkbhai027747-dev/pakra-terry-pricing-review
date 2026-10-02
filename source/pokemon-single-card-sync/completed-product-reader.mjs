const fail = code => { throw Object.assign(new Error(code), { code }); };
const productId = value => typeof value === 'string' && /^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(value);
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));
const exactIdentifier = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 1 && (Object.hasOwn(value, 'id') && productId(value.id)
    || Object.hasOwn(value, 'handle') && typeof value.handle === 'string' && /^[a-z0-9][a-z0-9-]{0,254}$/.test(value.handle));
const sameIdentifier = (left, right) => Boolean(right) && exactIdentifier(left)
  && Object.keys(left)[0] === Object.keys(right)[0] && Object.values(left)[0] === Object.values(right)[0];

/** Caches only the explicit completed prefix for one verification pass. The pending target is always read live. */
export function createCompletedProductReader({ client, completedProductIds, targetIdentifier = null, guard, itemGuard = guard, batchSize = 5 }) {
  if (typeof client?.execute !== 'function' || typeof guard !== 'function' || typeof itemGuard !== 'function'
    || !Array.isArray(completedProductIds) || completedProductIds.length > 503
    || completedProductIds.some(id => !productId(id)) || new Set(completedProductIds).size !== completedProductIds.length
    || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5
    || targetIdentifier !== null && (!exactIdentifier(targetIdentifier) || completedProductIds.includes(targetIdentifier.id))) {
    fail('invalid_completed_product_reader');
  }
  const ids = [...completedProductIds], target = targetIdentifier === null ? null : { ...targetIdentifier };
  const cache = new Map(), pending = new Map();
  const check = async (callback = guard) => { await yieldTurn(); await callback(); };
  const load = async offset => {
    await check();
    const expected = ids.slice(offset, offset + batchSize);
    const result = await client.execute('verifyMany', { ids: expected });
    await check();
    if (result?.errors?.length || result?.error || !Array.isArray(result?.nodes) || result.nodes.length !== expected.length) {
      fail('invalid_completed_product_batch');
    }
    const returned = new Map();
    for (const node of result.nodes) {
      if (!node || node.__typename !== 'Product' || !expected.includes(node.id) || returned.has(node.id)) {
        fail('invalid_completed_product_batch');
      }
      const { __typename, ...product } = node;
      returned.set(node.id, structuredClone(product));
    }
    if (returned.size !== expected.length) fail('invalid_completed_product_batch');
    for (const [id, product] of returned) cache.set(id, product);
  };
  return async identifier => {
    if (!exactIdentifier(identifier)) fail('unapproved_product_read_identifier');
    if (sameIdentifier(identifier, target)) {
      await check();
      const result = await client.execute('verify', { identifier: { ...target } });
      await check();
      if (result?.errors?.length || result?.error || !result || !Object.hasOwn(result, 'productByIdentifier')) {
        fail('invalid_target_product_read');
      }
      return structuredClone(result);
    }
    const index = ids.indexOf(identifier.id);
    if (Object.keys(identifier)[0] !== 'id' || index < 0) fail('unapproved_product_read_identifier');
    await check(itemGuard);
    if (!cache.has(identifier.id)) {
      const offset = Math.floor(index / batchSize) * batchSize;
      if (!pending.has(offset)) pending.set(offset, load(offset).finally(() => pending.delete(offset)));
      await pending.get(offset);
    }
    await itemGuard();
    return { productByIdentifier: structuredClone(cache.get(identifier.id)) };
  };
}
