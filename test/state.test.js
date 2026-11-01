// Свойства сборки ответа: модель, «нет цен» и падение каталога не должны
// превращаться в исключение или пустой JSON для клиента.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStateService } from '../lib/state.js';

const USAGE = Object.freeze({
  uncachedIn: 1_000_000,
  cacheRead: 0,
  cacheWrite: 0,
  out: 0,
  hitRate: 0,
  billedInput: 1_000_000,
});

/** Ответ `router.endpoints` с двумя посчитанными провайдерами. */
function endpointsResult(overrides = {}) {
  return {
    id: 'deepseek/x-pinned',
    requestedId: 'deepseek/x-pinned',
    name: 'DeepSeek: X',
    providers: [
      { name: 'A', tag: 'a', label: 'A', status: 0, variable: false, pricesPerM: { in: 0.2, cache: 0.2, out: 0.2 } },
      { name: 'B', tag: 'b', label: 'B', status: 0, variable: false, pricesPerM: { in: 0.1, cache: 0.1, out: 0.1 } },
    ],
    hiddenCount: 2,
    fetchedAt: 5_000,
    stale: false,
    error: null,
    ...overrides,
  };
}

/** Сессия, которая уже сделала запрос. */
function session(model = 'deepseek/x') {
  return { requestContext: () => ({ model }) };
}

/**
 * Сервис на заглушках: журнал вызовов показывает, что именно спросили.
 *
 * @returns {{state: object, calls: {resolve: unknown[], endpoints: unknown[]}}}
 */
function harness({ resolved = 'deepseek/x-pinned', noResolve = false, endpoints = endpointsResult(), resolveError, endpointsError } = {}) {
  const calls = { resolve: [], endpoints: [] };
  const router = {
    resolveModel: async (model, aliases) => {
      calls.resolve.push([model, aliases]);
      if (resolveError !== undefined) throw resolveError;
      if (noResolve) return undefined;
      return resolved;
    },
    endpoints: async (id, options) => {
      calls.endpoints.push([id, options]);
      if (endpointsError !== undefined) throw endpointsError;
      return endpoints;
    },
  };
  const usage = { read: () => USAGE };
  const state = createStateService({
    router,
    usage,
    aliases: { 'deepseek/x': 'deepseek/x-pinned' },
    now: () => 9_000,
  });
  return { state, calls };
}

test('собирает модель, провайдеров, минимум и служебные поля', async () => {
  const { state, calls } = harness();
  const result = await state.build({ sessionId: 's1', session: session() });

  assert.equal(result.sessionId, 's1');
  assert.equal(result.model, 'deepseek/x');
  assert.equal(result.resolvedModel, 'deepseek/x-pinned');
  assert.equal(result.modelLabel, 'DeepSeek: X');
  assert.equal(result.usage, USAGE);
  assert.equal(result.hiddenCount, 2);
  assert.equal(result.fetchedAt, 5_000, 'время цен, а не текущее');
  assert.equal(result.stale, false);
  assert.equal(result.error, null);
  assert.equal(result.cheapest.label, 'B', 'минимум по фактическому usage');
  assert.deepEqual(result.providers.map((row) => row.label), ['B', 'A'], 'таблица отсортирована');
  assert.equal(result.cheapest.costRub, 0.1, '1M токенов × 0.1 ₽/M');
  assert.equal(result.providers[1].deltaRub, 0.1, 'A 0.2 ₽ минус B 0.1 ₽');
  assert.deepEqual(calls.resolve[0], ['deepseek/x', { 'deepseek/x': 'deepseek/x-pinned' }]);
});

test('сессия без модели — ошибка в состоянии, а не исключение', async () => {
  const { state } = harness();
  const result = await state.build({ sessionId: 's2', session: { requestContext: () => ({}) } });

  assert.equal(result.model, null);
  assert.equal(result.resolvedModel, null);
  assert.deepEqual(result.providers, []);
  assert.equal(result.cheapest, null);
  assert.match(result.error, /модель сессии не определена/);
});

test('модель не нашлась в каталоге — «нет цен»', async () => {
  const { state } = harness({ noResolve: true });
  const result = await state.build({ session: session() });

  assert.equal(result.resolvedModel, null);
  assert.deepEqual(result.providers, []);
  assert.match(result.error, /нет цен для модели deepseek\/x/);
});

test('сеть цен упала — ошибка в состоянии, прошлые данные не выдумываются', async () => {
  const { state } = harness({ endpointsError: new Error('routerai: GET /endpoints → HTTP 502') });
  const result = await state.build({ session: session() });

  assert.equal(result.resolvedModel, 'deepseek/x-pinned');
  assert.deepEqual(result.providers, []);
  assert.match(result.error, /HTTP 502/);
});

test('refresh прокидывает fresh в цены', async () => {
  const { state, calls } = harness();
  await state.build({ session: session(), fresh: true });

  assert.deepEqual(calls.endpoints[0][1], { fresh: true });
});

test('stale цен попадает в stale состояния и в error', async () => {
  const { state } = harness({
    endpoints: endpointsResult({ stale: true, error: 'routerai: сеть недоступна' }),
  });
  const result = await state.build({ session: session() });

  assert.equal(result.stale, true);
  assert.match(result.error, /сеть недоступна/);
});

test('модель по умолчанию подхватывается до первого запроса', async () => {
  const { state } = harness();
  const result = await state.build({
    session: { requestContext: () => ({}) },
    defaultModel: { currentSelection: () => ({ model: 'deepseek/fallback' }) },
  });

  assert.equal(result.model, 'deepseek/fallback');
  assert.equal(result.resolvedModel, 'deepseek/x-pinned');
});

test('сессия без usage не даёт NaN в стоимости', async () => {
  const router = {
    resolveModel: async () => 'deepseek/x-pinned',
    endpoints: async () => endpointsResult(),
  };
  const state = createStateService({
    router,
    usage: { read: () => ({ ...USAGE, uncachedIn: 0, billedInput: 0, hitRate: 0 }) },
    now: () => 1,
  });
  const result = await state.build({ session: session() });

  assert.equal(result.cheapest.costRub, 0);
  assert.equal(result.usage.hitRate, 0);
});
