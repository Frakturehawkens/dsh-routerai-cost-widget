/**
 * Каталог RouterAI: список моделей, endpoint'ы одной модели и нормализация цен.
 *
 * Модуль не знает ни про сессию, ни про валюту: на входе HTTP и кэш, на выходе
 * плоские структуры для `lib/cost.js`. Три решения задают весь код:
 *
 *  - API отдаёт цены за **один токен**, наружу уходят за 1M (×1e6). Масштаб берётся
 *    из `pricing_units`, а не из величины цены: эвристика `if (p < 0.01) p *= 1e6`
 *    из `calculator.py` ломается на дешёвом кэше и здесь не повторяется;
 *  - `status != 0` — провайдер недоступен: в выдачу не идёт, считается в `hiddenCount`;
 *  - `variable_pricings` — расписание тарифов по UTC. Кэшируется **сырой** ответ API,
 *    нормализация считается на каждом чтении: иначе значение, взятое в 09:59, ещё час
 *    отдавало бы утренний тариф.
 *
 * Идентификаторы моделей сессии и каталога не совпадают (`-latest` против `-1017`),
 * поэтому резолв идёт цепочкой: точное совпадение → alias-строка `~id` → нормализация
 * с самым свежим `created` → ручной `modelAliases` → «нет цен».
 *
 * @module routerai-cost-widget/routerai
 */

/** База API RouterAI. */
/** База API RouterAI. */
export const API_BASE = 'https://routerai.ru/api/v1';

/**
 * Таймаут одного запроса к RouterAI, мс.
 *
 * Без таймаута зависшее соединение не даёт промису осесть: `cache.resolve`
 * держит ключ в `inflight` вечно, и маршрут вместе со всеми следующими
 * запросами этой модели висит до рестарта Host'а.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/** Список моделей меняется редко: сутки. */
export const MODELS_TTL_MS = 24 * 60 * 60 * 1000;

/** Цены одной модели — не чаще раза в час. */
export const ENDPOINTS_TTL_MS = 60 * 60 * 1000;

/** Ключ списка моделей в кэше. */
export const MODELS_KEY = 'models';

/** Префикс ключа endpoint'ов в кэше. */
export const ENDPOINTS_KEY_PREFIX = 'endpoints:';

/** Поля цены в ответе API. */
const PRICE_FIELDS = ['prompt', 'completion', 'input_cache_read'];

/** Порядок дней недели в `Date.getUTCDay()`. */
const UTC_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Минут в сутках — верхняя граница окна «до полуночи». */
const MINUTES_PER_DAY = 24 * 60;

/** Минут в часе. */
const MINUTES_PER_HOUR = 60;

/** `utc_start`/`utc_end` — сотые доли часа: 1000 = 10:00, а не 1000 минут. */
const HUNDREDTHS_PER_HOUR = 100;

/** @returns {boolean} — является ли значение простым объектом. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @returns {number | undefined} — конечное число либо undefined. */
function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * Сигнал таймаута для `fetch`.
 *
 * `AbortSignal.timeout` есть с Node 17.3; на платформе без него запрос уходит
 * без сигнала — таймаут там не сработает, но виджет не падает.
 *
 * @param {number} ms — таймаут, мс.
 * @returns {AbortSignal | undefined} — сигнал либо undefined.
 */
function timeoutSignal(ms) {
  const Signal = globalThis.AbortSignal;
  return typeof Signal?.timeout === 'function' ? Signal.timeout(ms) : undefined;
}

/**
 * Подпись провайдера. `provider_name` у вариантов одного провайдера совпадает
 * (DeepInfra flex/priority), различие — в `tag`: `DeepInfra · flex`.
 *
 * @param {unknown} name — `provider_name`.
 * @param {unknown} tag — `tag`.
 * @returns {string} — подпись для пилюли и таблицы.
 */
export function providerLabel(name, tag) {
  const base = String(name ?? tag ?? '').trim();
  const text = String(tag ?? '');
  const variant = text.includes('/') ? text.split('/').slice(1).join('/') : '';
  if (variant === '' || variant === base) return base;
  return `${base} · ${variant}`;
}

/**
 * Цена за 1M токенов по одному полю.
 *
 * @param {unknown} value — цена из API (за токен).
 * @param {unknown} units — `pricing_units` (или `pricing_units_default`).
 * @param {string} field — имя поля цены.
 * @returns {number | undefined} — цена за 1M токенов.
 */
function pricePerMillion(value, units, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const unit = isRecord(units) ? units[field] : undefined;
  // Поля нет — значит "token": так отвечает живой API, и так считает фикстура.
  return unit === undefined || unit === null || unit === 'token' ? value * 1e6 : value;
}

/**
 * Цены за 1M токенов из объекта `pricing`.
 *
 * `input_cache_read` может отсутствовать — тогда кэш стоит как обычный вход.
 *
 * @param {unknown} pricing — `pricing` или `pricing_default`.
 * @param {unknown} units — `pricing_units` или `pricing_units_default`.
 * @returns {{in?: number, cache?: number, out?: number}} — цены за 1M.
 */
export function pricesPerMillion(pricing, units) {
  if (!isRecord(pricing)) return {};
  const cacheRead = pricing.input_cache_read ?? pricing.prompt;
  return {
    in: pricePerMillion(pricing.prompt, units, 'prompt'),
    cache: pricePerMillion(cacheRead, units, 'input_cache_read'),
    out: pricePerMillion(pricing.completion, units, 'completion'),
  };
}

/**
 * Попадает ли момент времени в окно тарифа `time-of-day`.
 *
 * `utc_days: []` или отсутствие поля — все дни. `utc_end: 0` при ненулевом
 * `utc_start` — до полуночи, `0`/`0` — весь день. Границы считаются в минутах:
 * `1000` — это 10:00, `1400` — 14:00, поэтому окно `[start, end)`.
 *
 * @param {unknown} entry — элемент `variable_pricings`.
 * @param {number | Date} at — момент времени.
 * @returns {boolean} — действует ли окно в этот момент.
 */
export function windowMatches(entry, at) {
  if (!isRecord(entry)) return false;
  const date = at instanceof Date ? at : new Date(at);
  const days = Array.isArray(entry.utc_days)
    ? entry.utc_days.map((day) => String(day).toLowerCase())
    : [];
  if (days.length > 0 && !days.includes(UTC_DAYS[date.getUTCDay()])) return false;
  const start = finiteNumber(entry.utc_start ?? 0);
  const end = finiteNumber(entry.utc_end ?? 0);
  if (start === undefined || end === undefined) return false;
  const minute = date.getUTCHours() * MINUTES_PER_HOUR + date.getUTCMinutes();
  const from = (start * MINUTES_PER_HOUR) / HUNDREDTHS_PER_HOUR;
  const to = end === 0 ? MINUTES_PER_DAY : (end * MINUTES_PER_HOUR) / HUNDREDTHS_PER_HOUR;
  return minute >= from && minute < to;
}

/**
 * Наложить поля одного тарифа на другой.
 *
 * @param {Record<string, unknown>} base — базовый `pricing`.
 * @param {Record<string, unknown>} overlay — окно `variable_pricings`.
 * @returns {Record<string, unknown>} — цена с наложенными полями.
 */
function mergePricing(base, overlay) {
  const merged = { ...base };
  for (const field of PRICE_FIELDS) {
    if (overlay[field] !== undefined) merged[field] = overlay[field];
  }
  return merged;
}

/**
 * Действующая цена на момент времени.
 *
 * Расписание — альтернативные окна, а не надбавки: побеждает последнее совпавшее.
 * На данных RouterAI окна не пересекаются, порядок нужен только для устойчивости.
 *
 * @param {unknown} pricing — базовый `pricing`.
 * @param {unknown} variablePricings — `variable_pricings`.
 * @param {number | Date} at — момент времени.
 * @returns {{pricing: Record<string, unknown>, variable: boolean}} — цена и признак тарифа.
 */
export function applyVariablePricing(pricing, variablePricings, at) {
  const base = isRecord(pricing) ? pricing : {};
  if (!Array.isArray(variablePricings)) return { pricing: base, variable: false };
  let effective = base;
  let variable = false;
  for (const entry of variablePricings) {
    if (!isRecord(entry) || entry.type !== 'time-of-day') continue;
    if (!windowMatches(entry, at)) continue;
    effective = mergePricing(effective, entry);
    variable = true;
  }
  return { pricing: effective, variable };
}

/**
 * Привести ответ `/models/{id}/endpoints` к списку провайдеров.
 *
 * Живой API оборачивает тело в `{data: …}`, фикстура отдаёт его напрямую —
 * принимаются оба вида.
 *
 * @param {unknown} payload — тело ответа.
 * @param {number | Date} [at] — момент, на который считается тариф.
 * @returns {{
 *   id: string | null,
 *   name: string | null,
 *   created: number | null,
 *   providers: Array<{name: string, tag: string, label: string, status: number, variable: boolean, pricesPerM: {in?: number, cache?: number, out?: number}}>,
 *   hiddenCount: number,
 *   at: number,
 * }}
 */
export function normalizeEndpoints(payload, at = Date.now()) {
  const moment = at instanceof Date ? at.getTime() : at;
  const body = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  const list = isRecord(body) && Array.isArray(body.endpoints) ? body.endpoints : [];
  const providers = [];
  let hiddenCount = 0;
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const status = finiteNumber(entry.status) ?? 0;
    const base = isRecord(entry.pricing)
      ? entry.pricing
      : isRecord(entry.pricing_default)
        ? entry.pricing_default
        : undefined;
    // Нет ни `pricing`, ни `pricing_default` — считать нечего, строка скрывается.
    if (status !== 0 || base === undefined) {
      hiddenCount += 1;
      continue;
    }
    const units = isRecord(entry.pricing_units)
      ? entry.pricing_units
      : isRecord(entry.pricing_units_default)
        ? entry.pricing_units_default
        : undefined;
    const applied = applyVariablePricing(base, entry.variable_pricings, moment);
    const name = String(entry.provider_name ?? entry.tag ?? 'unknown');
    const tag = String(entry.tag ?? '');
    providers.push({
      name,
      tag,
      label: providerLabel(name, tag),
      status,
      variable: applied.variable,
      pricesPerM: pricesPerMillion(applied.pricing, units),
    });
  }
  return {
    id: isRecord(body) && typeof body.id === 'string' ? body.id : null,
    name: isRecord(body) && typeof body.name === 'string' ? body.name : null,
    created: isRecord(body) ? (finiteNumber(body.created) ?? null) : null,
    providers,
    hiddenCount,
    at: moment,
  };
}

/**
 * Привести ответ `/models` к списку моделей.
 *
 * Три вида ответа: живой `{data: [{id, created, name}]}`, старый/фикстурный
 * `{models: [id]}` и голый массив.
 *
 * @param {unknown} payload — тело ответа.
 * @returns {Array<{id: string, name: string | null, created: number}>} — модели, свежие первыми.
 */
export function normalizeModelList(payload) {
  const source = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload) && Array.isArray(payload.models)
        ? payload.models
        : [];
  const models = [];
  for (const item of source) {
    if (typeof item === 'string') {
      if (item !== '') models.push({ id: item, name: null, created: 0 });
      continue;
    }
    if (!isRecord(item) || typeof item.id !== 'string' || item.id === '') continue;
    models.push({
      id: item.id,
      name: typeof item.name === 'string' ? item.name : null,
      created: finiteNumber(item.created) ?? 0,
    });
  }
  models.sort((left, right) => right.created - left.created || left.id.localeCompare(right.id));
  return models;
}

/**
 * Идентификатор без «версионных» украшений: `~`, `-latest`, `-NNNN`.
 *
 * @param {unknown} id — id модели.
 * @returns {string} — нормализованный id.
 */
export function normalizeModelId(id) {
  let out = String(id ?? '').trim().toLowerCase();
  if (out.startsWith('~')) out = out.slice(1);
  out = out.replace(/-latest$/, '');
  out = out.replace(/-\d{4}$/, '');
  return out;
}

/**
 * Куда указывает alias-строка каталога.
 *
 * Alias и его цель совпадают по `name` и `created` (у DeepSeek: `~…-flash-latest`
 * и `…-v4.1-flash-1017`), поэтому связь ищется по ним, а не по таблице в коде.
 *
 * @param {{id: string, name: string | null, created: number}} alias — запись с `~`.
 * @param {Array<{id: string, name: string | null, created: number}>} models — каталог.
 * @returns {string | undefined} — id цели либо undefined.
 */
function pinnedTarget(alias, models) {
  const byNameAndCreated = models.filter(
    (model) =>
      !model.id.startsWith('~')
      && model.created === alias.created
      && model.name === alias.name,
  );
  if (byNameAndCreated.length === 1) return byNameAndCreated[0].id;
  const byCreated = models.filter(
    (model) => !model.id.startsWith('~') && model.created === alias.created,
  );
  return byCreated.length === 1 ? byCreated[0].id : undefined;
}

/**
 * Ручной маппинг из `Config.modelAliases` без учёта регистра.
 *
 * @param {unknown} aliases — `{ 'id сессии': 'id RouterAI' }`.
 * @param {string} wanted — id сессии.
 * @returns {string | undefined} — подменённый id.
 */
function lookupAlias(aliases, wanted) {
  if (!isRecord(aliases)) return undefined;
  const direct = aliases[wanted];
  if (typeof direct === 'string' && direct !== '') return direct;
  const lowered = wanted.toLowerCase();
  for (const [key, value] of Object.entries(aliases)) {
    if (key.toLowerCase() === lowered && typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** @returns {string} — текст ошибки для JSON-ответа маршрута. */
function describeError(error) {
  return String(error instanceof Error ? error.message : error);
}

/**
 * Закодировать id модели для пути запроса.
 *
 * `encodeURIComponent` на всём id сломал бы путь: id RouterAI содержит `/`
 * (`deepseek/deepseek-v4.1-flash-1017`), поэтому кодируется каждый сегмент
 * отдельно. Точки `encodeURIComponent` не экранирует, поэтому `..` и пустые
 * сегменты проверяются явно — иначе id увёл бы запрос на чужой путь API.
 *
 * @param {string} id — id модели.
 * @returns {string} — путь-безопасный id.
 */
function encodeModelPath(id) {
  const segments = id.split('/').map(encodeURIComponent);
  if (segments.some((segment) => segment === '' || segment === '..')) {
    throw new Error(`routerai: недопустимый id модели: ${id}`);
  }
  return segments.join('/');
}

/**
 * Создать клиент RouterAI.
 *
 * @param {object} options
 * @param {string} [options.apiBase] — база API.
 * @param {{resolve: Function}} options.cache — кэш из `lib/cache.js`.
 * @param {typeof fetch} [options.fetch] — подменяется в тестах.
 * @param {() => number} [options.now] — часы для тарифов, подменяются в тестах.
 * @param {number} [options.timeoutMs] — таймаут одного запроса, мс.
 * @returns {{
 *   listModels(): Promise<Array<{id: string, name: string | null, created: number}>>,
 *   endpoints(modelId: string, options?: {fresh?: boolean}): Promise<object>,
 *   resolveModel(sessionModel: string, aliases?: object): Promise<string | undefined>,
 * }}
 */
export function createRouterai({
  apiBase = API_BASE,
  cache,
  fetch: fetchImpl,
  now = Date.now,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (cache === undefined) throw new TypeError('createRouterai: нужен cache (см. lib/cache.js)');
  const base = String(apiBase).replace(/\/+$/, '');
  const request = fetchImpl ?? globalThis.fetch;

  /**
 * GET и разбор JSON. Не-2xx и таймаут — исключение с путём: в UI попадёт
 * текст ошибки, а не «нет цен».
 *
 * @param {string} path — путь от базы API.
 * @returns {Promise<unknown>} — тело ответа.
 */
  async function getJson(path) {
    if (typeof request !== 'function') throw new Error('routerai: fetch недоступен (нужен Node 20+)');
    let response;
    try {
      response = await request(`${base}${path}`, {
        headers: { accept: 'application/json' },
        signal: timeoutSignal(timeoutMs),
      });
    } catch (error) {
      // Таймаут отличается от «нет цен»: его текст уходит в UI и в `stale`-ошибку.
      if (error?.name === 'TimeoutError') {
        throw new Error(`routerai: GET ${path} → таймаут ${timeoutMs} мс`);
      }
      throw error;
    }
    if (response === null || typeof response !== 'object') {
      throw new Error(`routerai: GET ${path} — пустой ответ`);
    }
    const ok = typeof response.ok === 'boolean'
      ? response.ok
      : response.status >= 200 && response.status < 300;
    if (!ok) throw new Error(`routerai: GET ${path} → HTTP ${response.status ?? '?'}`);
    return response.json();
  }

  /**
   * Каталог моделей (кэш 24 ч). Ошибка сети пробрасывается: вызывающий решает,
   * показывать «нет цен» или ошибку.
   *
   * @returns {Promise<Array<{id: string, name: string | null, created: number}>>}
   */
  async function listModels() {
    const entry = await cache.resolve(
      MODELS_KEY,
      MODELS_TTL_MS,
      async () => normalizeModelList(await getJson('/models')),
    );
    return entry.value;
  }

  /**
   * Провайдеры и цены одной модели.
   *
   * Кэшируется сырое тело ответа (TTL 1 ч), тариф пересчитывается на каждый вызов —
   * так граница `time-of-day` не ждёт истечения TTL.
   *
   * @param {string} modelId — id в каталоге RouterAI (допускается alias-строка с `~`).
   * @param {object} [options]
   * @param {boolean} [options.fresh] — игнорировать TTL (ручной refresh).
   * @returns {Promise<object>} — `{id, requestedId, name, created, providers, hiddenCount, at, fetchedAt, stale, error}`.
   */
  async function endpoints(modelId, { fresh = false } = {}) {
    const requestedId = String(modelId ?? '').trim();
    if (requestedId === '') throw new Error('routerai: пустой id модели');
    const encoded = encodeModelPath(requestedId);
    const entry = await cache.resolve(
      `${ENDPOINTS_KEY_PREFIX}${requestedId}`,
      fresh ? 0 : ENDPOINTS_TTL_MS,
      () => getJson(`/models/${encoded}/endpoints`),
    );
    const normalized = normalizeEndpoints(entry.value, now());
    return {
      ...normalized,
      id: normalized.id ?? requestedId,
      requestedId,
      fetchedAt: entry.at,
      stale: entry.stale,
      error: entry.error === undefined ? null : describeError(entry.error),
    };
  }

  /**
   * Найти модель каталога для модели сессии.
   *
   * Порядок: точное совпадение → alias-строка `~id` → нормализация и самый свежий
   * `created` → ручной `modelAliases` → undefined («нет цен»).
   *
   * @param {string} sessionModel — id модели сессии (`deepseek/…-flash-latest`).
   * @param {Record<string, string>} [aliases] — `Config.modelAliases`.
   * @returns {Promise<string | undefined>} — id в каталоге RouterAI.
   */
  async function resolveModel(sessionModel, aliases = {}) {
    const wanted = String(sessionModel ?? '').trim();
    if (wanted === '') return undefined;
    let models;
    try {
      models = await listModels();
    } catch {
      // Каталог недоступен — ручная настройка остаётся рабочим путём.
      return lookupAlias(aliases, wanted);
    }
    const byId = new Map(models.map((model) => [model.id.toLowerCase(), model]));

    const exact = byId.get(wanted.toLowerCase());
    if (exact !== undefined) return exact.id;

    const alias = byId.get(`~${wanted.toLowerCase()}`);
    if (alias !== undefined) return pinnedTarget(alias, models) ?? alias.id;

    const normalized = normalizeModelId(wanted);
    let newest;
    for (const model of models) {
      if (model.id.startsWith('~')) continue;
      if (normalizeModelId(model.id) !== normalized) continue;
      if (newest === undefined || model.created > newest.created) newest = model;
    }
    if (newest !== undefined) return newest.id;

    return lookupAlias(aliases, wanted);
  }

  return { listModels, endpoints, resolveModel };
}
