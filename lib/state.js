/**
 * Сборка ответа для клиента: модель → каталог RouterAI → цены → стоимость.
 *
 * Модуль не знает ни про HTTP, ни про Config: на входе сервисы, на выходе один
 * JSON. Поэтому сборку можно проверить без сервера и без живого профиля.
 *
 * Ни одна сетевая ошибка не вылетает наружу: клиент должен получить состояние
 * («нет цен», «каталог недоступен»), а не пустой ответ. Ошибки складываются в
 * `error`, чтобы пилюля показала их текстом.
 *
 * @module routerai-cost-widget/state
 */

import { estimateCosts } from './cost.js';
import { sessionModel } from './usage.js';

/** Пустая свёртка usage — сессия без единого запроса. */
const EMPTY_USAGE = Object.freeze({
  uncachedIn: 0,
  cacheRead: 0,
  cacheWrite: 0,
  out: 0,
  hitRate: 0,
  billedInput: 0,
});

/** @returns {string} — текст ошибки для JSON-ответа. */
function describeError(error) {
  return String(error instanceof Error ? error.message : error);
}

/**
 * Создать сборщик состояния.
 *
 * @param {object} options
 * @param {object} options.router — клиент `lib/routerai.js`.
 * @param {{read: Function}} options.usage — читатель `lib/usage.js`.
 * @param {Record<string, string>} [options.aliases] — `Config.modelAliases`.
 * @param {() => number} [options.now] — часы, подменяются в тестах.
 * @returns {{build(input: {sessionId?: string, session: object, defaultModel?: unknown, fresh?: boolean}): Promise<object>}}
 */
export function createStateService({ router, usage, aliases = {}, now = Date.now } = {}) {
  /**
   * Собрать состояние одной сессии.
   *
   * @param {object} input
   * @param {string} [input.sessionId] — id для ответа и логов.
   * @param {object} input.session — живая сессия.
   * @param {unknown} [input.defaultModel] — `ctx.agentDefaultModel` на случай сессии без запросов.
   * @param {boolean} [input.fresh] — игнорировать TTL цен (ручной refresh).
   * @returns {Promise<object>} — контракт §1.6 PLAN.
   */
  async function build({ sessionId, session, defaultModel, fresh = false } = {}) {
    const stamp = now();
    const totals = usage?.read(session) ?? { ...EMPTY_USAGE };
    const model = sessionModel(session, defaultModel);

    /** @type {object} */
    const result = {
      sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null,
      model: model ?? null,
      resolvedModel: null,
      modelLabel: null,
      usage: totals,
      providers: [],
      cheapest: null,
      hiddenCount: 0,
      unpricedCount: 0,
      fetchedAt: stamp,
      stale: false,
      error: null,
    };
    /** @type {string[]} */
    const errors = [];

    if (model === undefined) {
      errors.push('модель сессии не определена');
      result.error = errors.join('; ');
      return result;
    }

    let resolved;
    try {
      resolved = await router.resolveModel(model, aliases);
    } catch (error) {
      errors.push(describeError(error));
      result.error = errors.join('; ');
      return result;
    }
    if (resolved === undefined) {
      errors.push(`нет цен для модели ${model}`);
      result.error = errors.join('; ');
      return result;
    }
    result.resolvedModel = resolved;

    let endpoints;
    try {
      endpoints = await router.endpoints(resolved, { fresh });
    } catch (error) {
      errors.push(describeError(error));
      result.error = errors.join('; ');
      return result;
    }

    result.fetchedAt = typeof endpoints.fetchedAt === 'number' ? endpoints.fetchedAt : stamp;
    result.hiddenCount = Number.isFinite(endpoints.hiddenCount) ? endpoints.hiddenCount : 0;
    result.modelLabel = typeof endpoints.name === 'string' && endpoints.name !== '' ? endpoints.name : resolved;
    result.stale = endpoints.stale === true;
    if (typeof endpoints.error === 'string' && endpoints.error !== '') errors.push(endpoints.error);

    const costs = estimateCosts({
      providers: Array.isArray(endpoints.providers) ? endpoints.providers : [],
      usage: totals,
    });
    result.providers = costs.providers;
    result.cheapest = costs.cheapest;
    result.unpricedCount = costs.unpricedCount;
    result.error = errors.length === 0 ? null : errors.join('; ');
    return result;
  }

  return { build };
}
