// Свойства слоя RouterAI, на которых держится вся стоимость: перевод «за токен» →
// «за 1M», отсев недоступных провайдеров, расписание тарифов по UTC и резолв
// модели сессии в id каталога. Фикстура — реальный ответ `/models/{id}/endpoints`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCache } from '../lib/cache.js';
import {
  createRouterai,
  normalizeEndpoints,
  normalizeModelList,
  providerLabel,
  windowMatches,
} from '../lib/routerai.js';

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/endpoints.json', import.meta.url), 'utf8'),
);

const MODEL_ID = 'deepseek/deepseek-v4.1-flash-1017';

/** Понедельник 00:59 UTC — последняя минута дешёвого окна. */
const MONDAY_0059 = Date.UTC(2026, 9, 19, 0, 59);
/** Понедельник 01:00 UTC — начало дорогого окна. */
const MONDAY_0100 = Date.UTC(2026, 9, 19, 1, 0);
const MONDAY_0200 = Date.UTC(2026, 9, 19, 2, 0);
const MONDAY_0400 = Date.UTC(2026, 9, 19, 4, 0);
const MONDAY_0500 = Date.UTC(2026, 9, 19, 5, 0);
const MONDAY_0600 = Date.UTC(2026, 9, 19, 6, 0);
const MONDAY_1000 = Date.UTC(2026, 9, 19, 10, 0);
const MONDAY_1200 = Date.UTC(2026, 9, 19, 12, 0);
const MONDAY_1400 = Date.UTC(2026, 9, 19, 14, 0);
const SATURDAY_1200 = Date.UTC(2026, 9, 24, 12, 0);
const SUNDAY_2359 = Date.UTC(2026, 9, 25, 23, 59);

/** Каталог: alias-строка и её цель совпадают по `name` и `created`, как в живом API. */
const CATALOG = [
  { id: MODEL_ID, name: 'DeepSeek: DeepSeek V4.1 Flash 1017', created: 1792225624 },
  { id: '~deepseek/deepseek-v4-flash-latest', name: 'DeepSeek: DeepSeek V4.1 Flash 1017', created: 1792225624 },
  { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek: DeepSeek V4.1 Flash', created: 1789021285 },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek: DeepSeek V4 Flash 0423', created: 1777000666 },
];

/**
 * Временный файл кэша; каталог удаляется после теста.
 *
 * @param {import('node:test').TestContext} t — контекст теста.
 * @returns {string} — путь к файлу кэша.
 */
function temporaryFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'routerai-cost-widget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, '.routerai-cost-widget', 'cache.json');
}

/**
 * Роутер на подменённом fetch с общим поддельным временем для кэша и тарифов.
 *
 * @param {import('node:test').TestContext} t — контекст теста.
 * @param {object} [options]
 * @param {number} [options.at] — начальное время.
 * @param {Array<object>} [options.models] — каталог для `/models`.
 * @returns {{router: object, calls: string[], clock: {at: number}, failWith: (error: Error | null) => void}}
 */
function harness(t, { at = MONDAY_1200, models = CATALOG } = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @type {Error | null} */
  let failure = null;
  const fetchStub = async (url) => {
    calls.push(url);
    if (failure !== null) throw failure;
    if (url.endsWith('/models')) {
      return { ok: true, status: 200, json: async () => ({ data: models }) };
    }
    return { ok: true, status: 200, json: async () => FIXTURE };
  };
  const clock = { at };
  const cache = createCache({ file: temporaryFile(t), now: () => clock.at });
  const router = createRouterai({ cache, fetch: fetchStub, now: () => clock.at });
  return {
    router,
    calls,
    clock,
    failWith: (error) => {
      failure = error;
    },
  };
}

/**
 * Провайдер по `tag` из ответа `endpoints()`.
 *
 * @param {{providers: Array<{tag: string}>}} result — ответ.
 * @param {string} tag — `tag` провайдера.
 * @returns {any} — строка провайдера.
 */
function provider(result, tag) {
  const found = result.providers.find((item) => item.tag === tag);
  assert.ok(found !== undefined, `провайдер ${tag} есть в выдаче`);
  return found;
}

/**
 * Цена BytePlus на заданный момент. Смена времени внутри TTL не должна ходить в сеть.
 *
 * @param {ReturnType<typeof harness>} h — стенд.
 * @param {number} at — момент UTC.
 * @returns {Promise<any>} — строка BytePlus.
 */
async function byteplusAt(h, at) {
  h.clock.at = at;
  return provider(await h.router.endpoints(MODEL_ID), 'byteplus');
}

test('фикстура: 38 строк, скрытые — только status != 0', async (t) => {
  const h = harness(t);
  const result = await h.router.endpoints(MODEL_ID);

  assert.equal(result.providers.length + result.hiddenCount, 38);
  assert.equal(
    result.hiddenCount,
    FIXTURE.endpoints.filter((entry) => entry.status !== 0).length,
  );
  assert.equal(result.id, MODEL_ID);
  assert.equal(result.requestedId, MODEL_ID);
  assert.equal(result.stale, false);
  assert.equal(result.error, null);
  for (const item of result.providers) {
    assert.equal(item.status, 0, `${item.tag} показан только при status 0`);
    assert.ok(typeof item.pricesPerM.in === 'number' && item.pricesPerM.in >= 0);
    assert.ok(typeof item.pricesPerM.cache === 'number' && item.pricesPerM.cache >= 0);
    assert.ok(typeof item.pricesPerM.out === 'number' && item.pricesPerM.out >= 0);
  }
});

test('цены переведены из «за токен» в «за 1M»', async (t) => {
  const h = harness(t);
  const byteplus = await byteplusAt(h, MONDAY_0200);
  // 0.0000345590817 за токен — дорогой тариф BytePlus.
  assert.ok(Math.abs(byteplus.pricesPerM.in - 34.5590817) < 1e-9);
  assert.ok(Math.abs(byteplus.pricesPerM.out - 138.2363268) < 1e-9);

  const deepinfra = provider(await h.router.endpoints(MODEL_ID), 'deepinfra');
  assert.ok(Math.abs(deepinfra.pricesPerM.in - 11.289300022) < 1e-9);
});

test('DeepInfra flex и priority различаются по tag и цене', async (t) => {
  const h = harness(t);
  const result = await h.router.endpoints(MODEL_ID);
  const plain = provider(result, 'deepinfra');
  const flex = provider(result, 'deepinfra/flex');
  const priority = provider(result, 'deepinfra/priority');

  assert.equal(plain.label, 'DeepInfra');
  assert.equal(flex.label, 'DeepInfra · flex');
  assert.equal(priority.label, 'DeepInfra · priority');
  assert.equal(flex.name, priority.name, 'provider_name у вариантов совпадает');
  assert.ok(flex.pricesPerM.in < plain.pricesPerM.in);
  assert.ok(priority.pricesPerM.in > plain.pricesPerM.in);
});

test('тариф time-of-day применяется по UTC и не ходит в сеть при смене часа', async (t) => {
  const h = harness(t, { at: MONDAY_0059 });
  const cheap = provider(await h.router.endpoints(MODEL_ID), 'byteplus');
  assert.equal(cheap.variable, true, 'дешёвое окно помечено как тариф');
  assert.ok(Math.abs(cheap.pricesPerM.in - 17.27954085) < 1e-9);

  // Через минуту внутри TTL цена дорожает — значит тариф считается на чтении.
  const expensive = await byteplusAt(h, MONDAY_0100);
  assert.equal(h.calls.filter((url) => url.endsWith('/endpoints')).length, 1, 'сеть не тронута');
  assert.ok(Math.abs(expensive.pricesPerM.in - 34.5590817) < 1e-9);

  const expectCheap = async (at) => {
    const item = await byteplusAt(h, at);
    assert.ok(Math.abs(item.pricesPerM.in - 17.27954085) < 1e-9, `дешёвый тариф на ${new Date(at).toISOString()}`);
  };
  const expectExpensive = async (at) => {
    const item = await byteplusAt(h, at);
    assert.ok(Math.abs(item.pricesPerM.in - 34.5590817) < 1e-9, `дорогой тариф на ${new Date(at).toISOString()}`);
  };

  await expectCheap(MONDAY_0400);
  await expectExpensive(MONDAY_0600);
  await expectCheap(MONDAY_1000);
  await expectCheap(MONDAY_1200);
  await expectCheap(SATURDAY_1200);
  await expectCheap(SUNDAY_2359);
});

test('пустой utc_days — все дни; utc_end 0 при ненулевом utc_start — до полуночи', async (t) => {
  const h = harness(t);
  // Alibaba: окна без utc_days, [0, 1400) — дорого, [1400, 2400) — дёшево.
  const alibabaAt = async (at) => {
    h.clock.at = at;
    return provider(await h.router.endpoints(MODEL_ID), 'alibaba');
  };
  const midday = await alibabaAt(MONDAY_1200);
  assert.equal(midday.variable, true);
  assert.ok(Math.abs(midday.pricesPerM.in - 38.01498987) < 1e-9);
  const evening = await alibabaAt(MONDAY_1400);
  assert.ok(Math.abs(evening.pricesPerM.in - 19.007494935) < 1e-9);
  const weekend = await alibabaAt(SATURDAY_1200);
  assert.ok(Math.abs(weekend.pricesPerM.in - 38.01498987) < 1e-9, 'дни не ограничены');

  // Окно [1000, 0) — с 10:00 до полуночи.
  assert.equal(windowMatches({ utc_start: 1000, utc_end: 0 }, MONDAY_1000), true);
  assert.equal(windowMatches({ utc_start: 1000, utc_end: 0 }, SUNDAY_2359), true);
  assert.equal(windowMatches({ utc_start: 1000, utc_end: 0 }, MONDAY_0600), false);
  // Окно 0/0 — весь день.
  assert.equal(windowMatches({ utc_start: 0, utc_end: 0 }, MONDAY_0200), true);
});

test('на фикстуре ровно три провайдера с тарифом', async (t) => {
  const h = harness(t, { at: MONDAY_1200 });
  const result = await h.router.endpoints(MODEL_ID);
  const variable = result.providers.filter((item) => item.variable).map((item) => item.tag);
  assert.deepEqual(variable.sort(), ['alibaba', 'byteplus', 'deepseek']);
});

test('fallback: нет input_cache_read — берётся prompt; pricing_default и не-token единицы', () => {
  const payload = {
    data: {
      id: 'test/model',
      endpoints: [
        {
          provider_name: 'Alpha',
          tag: 'alpha',
          status: 0,
          pricing: { prompt: 0.000002, completion: 0.000004 },
        },
        {
          provider_name: 'Beta',
          tag: 'beta',
          status: -5,
          pricing: { prompt: 0.000001, completion: 0.000001 },
        },
        {
          provider_name: 'Gamma',
          tag: 'gamma',
          status: 0,
          pricing_units: { prompt: 'million', completion: 'million' },
          pricing: { prompt: 2, completion: 4 },
        },
        {
          provider_name: 'Delta',
          tag: 'delta',
          status: 0,
          pricing_default: { prompt: 0.000003, completion: 0.000003 },
        },
      ],
    },
  };
  const result = normalizeEndpoints(payload, MONDAY_1200);
  assert.equal(result.hiddenCount, 1, 'status != 0 скрыт');
  assert.equal(result.providers.length, 3);

  const alpha = provider(result, 'alpha');
  assert.equal(alpha.pricesPerM.in, 2);
  assert.equal(alpha.pricesPerM.cache, 2, 'кэш без input_cache_read стоит как вход');
  assert.equal(alpha.pricesPerM.out, 4);

  const gamma = provider(result, 'gamma');
  assert.equal(gamma.pricesPerM.in, 2, 'единицы не token — масштаб не применяется');

  const delta = provider(result, 'delta');
  assert.equal(delta.pricesPerM.in, 3, 'pricing_default вместо pricing');
});

test('providerLabel различает варианты и не дублирует slug', () => {
  assert.equal(providerLabel('DeepInfra', 'deepinfra'), 'DeepInfra');
  assert.equal(providerLabel('DeepInfra', 'deepinfra/flex'), 'DeepInfra · flex');
  assert.equal(providerLabel('Near AI', 'near-ai'), 'Near AI');
  assert.equal(providerLabel('DeepSeek', 'deepseek'), 'DeepSeek');
});

test('список моделей: живой вид, старый вид и голый массив', () => {
  const live = normalizeModelList({
    data: [
      { id: 'b/model', created: 20, name: 'B' },
      { id: 'a/model', created: 10, name: 'A' },
    ],
  });
  assert.deepEqual(live.map((item) => item.id), ['b/model', 'a/model'], 'свежие первыми');
  assert.equal(live[0].name, 'B');

  const legacy = normalizeModelList({ status: 'ok', models: ['x/model'] });
  assert.deepEqual(legacy, [{ id: 'x/model', name: null, created: 0 }]);

  const bare = normalizeModelList(['y/model']);
  assert.deepEqual(bare, [{ id: 'y/model', name: null, created: 0 }]);
});

test('резолв модели: точное совпадение, alias, нормализация, ручной маппинг', async (t) => {
  const h = harness(t);
  assert.equal(await h.router.resolveModel(MODEL_ID), MODEL_ID, 'точное совпадение');
  assert.equal(
    await h.router.resolveModel('deepseek/deepseek-v4-flash-latest'),
    MODEL_ID,
    'alias ~id указывает на pinned-снимок',
  );
  assert.equal(
    await h.router.resolveModel('deepseek/deepseek-v4.1-flash-latest'),
    MODEL_ID,
    'нормализация -latest берёт самый свежий created',
  );
  assert.equal(
    await h.router.resolveModel('custom/model', { 'custom/model': 'deepseek/deepseek-v4.1-flash' }),
    'deepseek/deepseek-v4.1-flash',
    'modelAliases из Config',
  );
  assert.equal(await h.router.resolveModel('nobody/knows'), undefined, 'нет цен');

  assert.equal(
    h.calls.filter((url) => url.endsWith('/models')).length,
    1,
    'каталог запрошен один раз на весь тест',
  );
});

test('endpoints: single-flight, TTL и fresh', async (t) => {
  const h = harness(t);
  const [first, second] = await Promise.all([
    h.router.endpoints(MODEL_ID),
    h.router.endpoints(MODEL_ID),
  ]);
  assert.equal(h.calls.filter((url) => url.endsWith('/endpoints')).length, 1, 'один поход на два вызова');
  assert.equal(first.providers.length, second.providers.length);

  h.clock.at += 60 * 60 * 1000;
  const refreshed = await h.router.endpoints(MODEL_ID);
  assert.equal(h.calls.filter((url) => url.endsWith('/endpoints')).length, 2, 'на границе TTL — новый запрос');
  assert.equal(refreshed.stale, false);

  await h.router.endpoints(MODEL_ID, { fresh: true });
  assert.equal(h.calls.filter((url) => url.endsWith('/endpoints')).length, 3, 'fresh обходит TTL');
});

test('ошибка сети после успеха отдаёт stale с прошлыми ценами', async (t) => {
  const h = harness(t);
  const fresh = await h.router.endpoints(MODEL_ID);
  h.failWith(new Error('сеть недоступна'));
  h.clock.at += 2 * 60 * 60 * 1000;
  const stale = await h.router.endpoints(MODEL_ID);

  assert.equal(stale.stale, true);
  assert.match(stale.error, /сеть недоступна/);
  assert.equal(stale.providers.length, fresh.providers.length, 'цены не пропали');
});

test('ошибка без прошлого значения пробрасывается', async (t) => {
  const h = harness(t);
  h.failWith(new Error('сеть недоступна'));
  await assert.rejects(() => h.router.endpoints(MODEL_ID), /сеть недоступна/);
});

test('таймаут запроса: текст ошибки и ключ снят из inflight', async () => {
  /** @type {string[]} */
  const calls = [];
  // Зависшее соединение: промис не оседает, пока не истечёт signal.
  const fetchStub = (url, options = {}) => new Promise((resolve, reject) => {
    calls.push(url);
    const signal = options.signal;
    assert.ok(signal instanceof AbortSignal, 'getJson передаёт signal в fetch');
    signal.addEventListener('abort', () => reject(new DOMException('', 'TimeoutError')));
  });
  const router = createRouterai({ cache: createCache(), fetch: fetchStub, timeoutMs: 10 });

  await assert.rejects(() => router.endpoints(MODEL_ID), /таймаут 10 мс/);
  // Второй вызов идёт в сеть заново: ключ снят из `inflight`, а не висит.
  await assert.rejects(() => router.endpoints(MODEL_ID), /таймаут 10 мс/);
  assert.equal(calls.length, 2, 'после таймаута ключ снят из inflight');
});

test('таймаут при наличии кэша отдаёт stale и прошлые цены', async (t) => {
  const clock = { at: MONDAY_1200 };
  let mode = 'ok';
  const fetchStub = (url, options = {}) => {
    if (mode === 'ok') {
      return Promise.resolve(
        url.endsWith('/models')
          ? { ok: true, status: 200, json: async () => ({ data: CATALOG }) }
          : { ok: true, status: 200, json: async () => FIXTURE },
      );
    }
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('', 'TimeoutError')));
    });
  };
  const cache = createCache({ file: temporaryFile(t), now: () => clock.at });
  const router = createRouterai({ cache, fetch: fetchStub, now: () => clock.at, timeoutMs: 10 });

  const fresh = await router.endpoints(MODEL_ID);
  mode = 'timeout';
  clock.at += 2 * 60 * 60 * 1000; // TTL истёк — кэш обязан пойти в сеть

  const stale = await router.endpoints(MODEL_ID);
  assert.equal(stale.stale, true);
  assert.match(stale.error, /таймаут 10 мс/);
  assert.equal(stale.providers.length, fresh.providers.length, 'цены не пропали');
});

test('id модели кодируется посегментно, `..` и пустой сегмент отвергаются', async () => {
  /** @type {string[]} */
  const calls = [];
  const fetchStub = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => FIXTURE };
  };
  const router = createRouterai({ cache: createCache(), fetch: fetchStub });

  await router.endpoints('deepseek/deepseek-v4.1-flash-1017');
  assert.equal(
    calls[0],
    'https://routerai.ru/api/v1/models/deepseek/deepseek-v4.1-flash-1017/endpoints',
    'слеш в id не ломает путь',
  );

  await router.endpoints('vendor/model name');
  assert.equal(
    calls[1],
    'https://routerai.ru/api/v1/models/vendor/model%20name/endpoints',
    'пробел в id экранируется',
  );

  await assert.rejects(() => router.endpoints('../admin'), /недопустимый id модели/);
  await assert.rejects(() => router.endpoints('vendor//model'), /недопустимый id модели/);
  assert.equal(calls.length, 2, 'недопустимый id не уходит в сеть');
});
