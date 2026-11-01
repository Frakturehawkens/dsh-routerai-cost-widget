/**
 * Стоимость сессии по каждому провайдеру RouterAI.
 *
 * RouterAI отдаёт цены **в рублях** за токен (`pricing.prompt`,
 * `pricing.completion`, `pricing.input_cache_read`; на сайте — «вход 1,24–38 ₽
 * за 1 млн токенов»). Поэтому стоимость считается сразу в ₽:
 *
 *   costRub = (uncachedIn · priceIn + cacheRead · priceCache + out · priceOut) / 1e6
 *
 * Курс валют здесь не нужен и не запрашивается.
 *
 * Провайдер без полной цены (`in` или `out` отсутствуют) не считается
 * бесплатным: он помечается `priced: false`, выпадает из выбора минимума и
 * считается в `unpricedCount`. Минимум — среди доступных и посчитанных.
 *
 * @module routerai-cost-widget/cost
 */

/** @returns {boolean} — является ли значение простым объектом. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @returns {number | undefined} — неотрицательное конечное число либо undefined. */
function priceOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** @returns {number} — неотрицательное конечное число токенов. */
function tokensOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Стоимость одного провайдера на заданном usage.
 *
 * @param {object} provider — строка из `normalizeEndpoints` (`pricesPerM`, ₽ за 1M).
 * @param {{uncachedIn: number, cacheRead: number, out: number}} usage — свёртка из `lib/usage.js`.
 * @returns {{priced: boolean, costRub: number | null}} — стоимость в ₽ либо признак «нет цен».
 */
export function providerCost(provider, usage) {
  const prices = isRecord(provider?.pricesPerM) ? provider.pricesPerM : {};
  const input = priceOf(prices.in);
  const output = priceOf(prices.out);
  // Нет входа или выхода — считать нечего. Кэш без цены стоит как обычный вход.
  if (input === undefined || output === undefined) {
    return { priced: false, costRub: null };
  }
  const cache = priceOf(prices.cache) ?? input;
  const uncachedIn = tokensOf(usage?.uncachedIn);
  const cacheRead = tokensOf(usage?.cacheRead);
  const out = tokensOf(usage?.out);

  return { priced: true, costRub: (uncachedIn * input + cacheRead * cache + out * output) / 1e6 };
}

/**
 * Посчитать стоимость у всех провайдеров, найти минимум и разницу с ним.
 *
 * @param {object} input
 * @param {ReadonlyArray<object>} input.providers — провайдеры из `lib/routerai.js`.
 * @param {{uncachedIn?: number, cacheRead?: number, out?: number}} input.usage — свёртка usage.
 * @returns {{
 * providers: Array<object & {priced: boolean, costRub: number | null, deltaRub: number | null, deltaPercent: number | null, isCheapest: boolean}>,
 * cheapest: object | null,
 * unpricedCount: number,
 * }}
 */
export function estimateCosts({ providers, usage } = {}) {
  if (!Array.isArray(providers)) throw new TypeError('estimateCosts: providers должен быть массивом');

  const rows = providers.map((provider) => ({
    ...provider,
    ...providerCost(provider, usage),
    deltaRub: null,
    deltaPercent: null,
    isCheapest: false,
  }));

  // Посчитанные — по возрастанию стоимости; без цен — в конце, по подписи.
  rows.sort((left, right) => {
    if (left.priced !== right.priced) return left.priced ? -1 : 1;
    if (left.priced && right.priced && left.costRub !== right.costRub) return left.costRub - right.costRub;
    return String(left.label ?? left.name ?? '').localeCompare(String(right.label ?? right.name ?? ''));
  });

  const cheapest = rows.find((row) => row.priced) ?? null;
  if (cheapest !== null) {
    cheapest.isCheapest = true;
    for (const row of rows) {
      if (!row.priced) continue;
      row.deltaRub = row.costRub - cheapest.costRub;
      // При нулевом usage дешёвый провайдер стоит 0 ₽: процент разницы не определён.
      row.deltaPercent = cheapest.costRub > 0 ? row.deltaRub / cheapest.costRub : 0;
    }
  }

  return {
    providers: rows,
    cheapest,
    unpricedCount: rows.filter((row) => !row.priced).length,
  };
}
