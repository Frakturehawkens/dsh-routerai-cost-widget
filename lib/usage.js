/**
 * Модель активной сессии и свёртка её usage.
 *
 * Два факта из DSH, на которых держится весь модуль:
 *
 *  - `TokenUsage.inputTokens` — это **только некешированный** вход. Кэш лежит
 *    в отдельных бакетах `cacheReadTokens` / `cacheWriteTokens`, а полный вход
 *    считается как `inputTokens + cacheReadTokens + cacheWriteTokens`
 *    (`dsh-token-meter`: «sum disjoint provider usage buckets»). Поэтому
 *    вычитать кэш из `inputTokens` нельзя — получится ноль на хорошо
 *    закэшированном ходу;
 *  - usage есть не только у `assistant/message`: неудачная или прерванная
 *    попытка оседает как `assistant/attempt` и несёт usage только в последнем
 *    чанке `data.stream`. Без этого ретраи бесплатны.
 *
 * У RouterAI нет отдельной цены записи в кэш, поэтому `cacheWriteTokens`
 * складываются в `uncachedIn` и тарифицируются как обычный вход. Тогда
 * `uncachedIn + cacheRead` совпадает с `billedInput` нативного счётчика, а
 * `hitRate` — с его процентом попаданий.
 *
 * @module routerai-cost-widget/usage
 */

/** Сколько сессий помнить в кэше свёртки. */
const MAX_SESSIONS = 128;

/** @returns {boolean} — является ли значение простым объектом. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @returns {number} — неотрицательное конечное число, иначе 0. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * События сессии без унаследованного префикса.
 *
 * `ownEvents()` предпочтительнее `snapshotEvents()`: у субагента в логе лежит
 * контекст родителя, и его assistant-сообщения уже оплачены в родительской
 * сессии. Повторный счёт удвоил бы стоимость каждого субагента.
 *
 * @param {object} session — живая сессия.
 * @returns {readonly object[]} — свои события в порядке лога.
 */
export function readOwnEvents(session) {
  try {
    if (typeof session?.ownEvents === 'function') return session.ownEvents() ?? [];
  } catch {
    /* падающее чтение не должно ронять виджет — пробуем запасной путь */
  }
  try {
    if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents() ?? [];
  } catch {
    /* сессия без читаемого лога не даёт вклада */
  }
  return [];
}

/**
 * Usage одного billed-вызова.
 *
 * Сначала `data.usage` (так оседает успешный `assistant/message`), затем
 * последний чанк `data.stream` (так оседает `assistant/attempt` и сообщение,
 * чей usage остался только в стриме).
 *
 * @param {{type?: string, data?: any}} event — событие лога.
 * @returns {object | undefined} — `TokenUsage` либо undefined.
 */
export function usageOf(event) {
  const direct = event?.data?.usage;
  if (isRecord(direct)) return direct;

  const stream = event?.data?.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record?.type === 'usage' && isRecord(record.usage)) return record.usage;
    const chunk = record?.chunk;
    if (chunk?.type === 'usage' && isRecord(chunk.usage)) return chunk.usage;
  }
  return undefined;
}

/**
 * Свести счётчики в форму, на которой работает `lib/cost.js`.
 *
 * `uncachedIn` включает `cacheWriteTokens`: отдельной цены записи у RouterAI
 * нет, а считать её бесплатной значило бы занижать стоимость. Поэтому
 * `uncachedIn + cacheRead` = `billedInput` нативного счётчика.
 *
 * @param {number} inputTokens — некешированный вход (без записи в кэш).
 * @param {number} cacheReadTokens — чтение из кэша.
 * @param {number} cacheWriteTokens — запись в кэш.
 * @param {number} outputTokens — выход.
 * @returns {{uncachedIn: number, cacheRead: number, cacheWrite: number, out: number, hitRate: number, billedInput: number}}
 */
function totalsOf(inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens) {
  const cacheWrite = count(cacheWriteTokens);
  const uncachedIn = count(inputTokens) + cacheWrite;
  const cacheRead = count(cacheReadTokens);
  const billedInput = uncachedIn + cacheRead;
  return {
    uncachedIn,
    cacheRead,
    cacheWrite,
    out: count(outputTokens),
    hitRate: billedInput === 0 ? 0 : cacheRead / billedInput,
    billedInput,
  };
}

/**
 * Свернуть события в токены и долю попаданий в кэш.
 *
 * Запасной путь: когда проекция `tokenUsage` доступна, читатель берёт её —
 * там та же арифметика, но уже с учётом замены сэмпла на повторном
 * `assistant/message` одного шага.
 *
 * @param {readonly object[]} events — события сессии.
 * @returns {{uncachedIn: number, cacheRead: number, cacheWrite: number, out: number, hitRate: number, billedInput: number}}
 */
export function foldUsage(events) {
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;

  for (const event of events ?? []) {
    if (!isRecord(event)) continue;
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue;
    const usage = usageOf(event);
    if (usage === undefined) continue;
    inputTokens += count(usage.inputTokens);
    cacheReadTokens += count(usage.cacheReadTokens);
    cacheWriteTokens += count(usage.cacheWriteTokens);
    outputTokens += count(usage.outputTokens);
  }

  return totalsOf(inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens);
}
/** @returns {string | undefined} — id сессии, если он есть и непустой. */
function sessionIdOf(session) {
  try {
    const id = session?.id;
    return typeof id === 'string' && id !== '' ? id : undefined;
  } catch {
    return undefined;
  }
}

/** @returns {number | undefined} — длина лога сессии (следующий seq). */
function seqOf(session) {
  try {
    const seq = Number(session?.seq);
    return Number.isFinite(seq) ? seq : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Прочитать usage из нативной проекции `tokenUsage`.
 *
 * Проекцию регистрирует `dsh-token-meter`, и её же читает нативная пилюля
 * `usage` (`dsh-client-ui-chat`). Поэтому hit-rate здесь совпадает с
 * токен-каунтером по построению, а не по совпадению формул.
 *
 * @param {object | undefined} projections — `ctx.sessionProjections`.
 * @param {object} session — живая сессия.
 * @returns {object | undefined} — сводка либо undefined, если проекции нет.
 */
function projectedUsage(projections, session) {
  try {
    const totals = projections?.stateOf?.(session, 'tokenUsage')?.totals;
    if (!isRecord(totals)) return undefined;
    return totalsOf(
      totals.uncachedInputTokens,
      totals.cacheReadTokens,
      totals.cacheWriteTokens,
      totals.outputTokens,
    );
  } catch {
    return undefined;
  }
}

/**
 * Создать читатель usage.
 *
 * Источники по приоритету: проекция `tokenUsage` (точная копия нативного
 * счётчика), затем свёртка событий с кэшем по `(sessionId, seq)`.
 *
 * @param {object} [options]
 * @param {object} [options.projections] — `ctx.sessionProjections`; без него работает свёртка.
 * @returns {{read(session: object): object, size(): number}}
 */
export function createUsageReader({ projections } = {}) {
  /** @type {Map<string, {seq: number, usage: object}>} */
  const entries = new Map();

  /**
   * @param {object} session — живая сессия.
   * @returns {{uncachedIn: number, cacheRead: number, cacheWrite: number, out: number, hitRate: number, billedInput: number}}
   */
  function read(session) {
    const projected = projectedUsage(projections, session);
    if (projected !== undefined) return projected;

    const id = sessionIdOf(session);
    const seq = seqOf(session);
    if (id !== undefined && seq !== undefined) {
      const known = entries.get(id);
      if (known !== undefined && known.seq === seq) {
        // Освежаем порядок Map: давно не виденная сессия вылетает первой.
        entries.delete(id);
        entries.set(id, known);
        return known.usage;
      }
    }

    const usage = foldUsage(readOwnEvents(session));
    if (id !== undefined && seq !== undefined) {
      entries.delete(id);
      entries.set(id, { seq, usage });
      while (entries.size > MAX_SESSIONS) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
      }
    }
    return usage;
  }

  return {
    read,
    size: () => entries.size,
  };
}

/**
 * Модель, на которой идёт сессия.
 *
 * `requestContext()` — последний `request/context` из лога: он есть, как только
 * сессия сделала запрос. До первого запроса берётся выбор по умолчанию.
 *
 * @param {object} session — живая сессия.
 * @param {object | (() => object | string) | string} [fallback] — `ctx.agentDefaultModel`,
 *   функция или готовый id.
 * @returns {string | undefined} — id модели вида `deepseek/…`.
 */
export function sessionModel(session, fallback) {
  let fromContext;
  try {
    fromContext = session?.requestContext?.()?.model;
  } catch {
    fromContext = undefined;
  }
  if (typeof fromContext === 'string' && fromContext !== '') return fromContext;

  let source = fallback;
  try {
    if (typeof source === 'function') source = source();
    if (typeof source === 'string') return source === '' ? undefined : source;
    if (isRecord(source)) {
      const selection = typeof source.currentSelection === 'function' ? source.currentSelection() : source;
      const model = selection?.model;
      if (typeof model === 'string' && model !== '') return model;
    }
  } catch {
    /* выбор по умолчанию недоступен — модель неизвестна, это не ошибка */
  }
  return undefined;
}
