// Свойства свёртки usage, от которых зависит вся стоимость: `inputTokens` — только
// некешированный вход, запись в кэш тарифицируется как вход, usage ретрая лежит
// в стриме, а свёртка пересчитывается только на новом событии.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUsageReader,
  foldUsage,
  readOwnEvents,
  sessionModel,
  usageOf,
} from '../lib/usage.js';

/** Успешное assistant-сообщение с usage. */
function message(usage, turn = 1, step = 1) {
  return { type: 'assistant/message', seq: 1, time: 1, data: { turn, step, usage } };
}

/** Попытка, usage которой сохранился только в последнем чанке стрима. */
function attempt(usage, turn = 1, step = 1) {
  return {
    type: 'assistant/attempt',
    seq: 2,
    time: 2,
    data: { turn, step, stream: [{ type: 'text' }, { type: 'chunk', chunk: { type: 'usage', usage } }] },
  };
}

test('usage берётся из data.usage и главнее стрима', () => {
  const event = {
    type: 'assistant/message',
    data: {
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 },
      stream: [{ type: 'usage', usage: { inputTokens: 99, outputTokens: 99 } }],
    },
  };

  assert.deepEqual(usageOf(event), { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 });
});

test('usage ретрая читается из последнего чанка стрима', () => {
  const recordShape = {
    type: 'assistant/attempt',
    data: { stream: [{ type: 'usage', usage: { inputTokens: 7, outputTokens: 8 } }] },
  };
  const chunkShape = {
    type: 'assistant/attempt',
    data: {
      stream: [
        { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } },
        { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 6 } } },
      ],
    },
  };

  assert.deepEqual(usageOf(recordShape), { inputTokens: 7, outputTokens: 8 });
  assert.deepEqual(usageOf(chunkShape), { inputTokens: 5, outputTokens: 6 }, 'побеждает последний чанк');
  assert.equal(usageOf({ type: 'assistant/attempt', data: { stream: [] } }), undefined);
  assert.equal(usageOf({ type: 'tool/call', data: {} }), undefined);
});

test('inputTokens — некешированный вход, cacheWrite тарифицируется как вход', () => {
  const usage = foldUsage([
    message({ inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 10, outputTokens: 50 }),
  ]);

  // 100 (некешированный) + 10 (запись в кэш) = 110; вычитать кэш из inputTokens нельзя.
  assert.equal(usage.uncachedIn, 110);
  assert.equal(usage.cacheRead, 900);
  assert.equal(usage.cacheWrite, 10);
  assert.equal(usage.out, 50);
  assert.equal(usage.billedInput, 1010, 'uncachedIn + cacheRead = полный вход');
  assert.ok(Math.abs(usage.hitRate - 900 / 1010) < 1e-12, 'hitRate как у нативного счётчика');
});

test('свёртка складывает сообщения и попытки, пропуская события без usage', () => {
  const usage = foldUsage([
    message({ inputTokens: 10, outputTokens: 1 }, 1, 1),
    attempt({ inputTokens: 20, outputTokens: 2, cacheReadTokens: 30 }, 1, 2),
    { type: 'tool/call', data: {} },
    { type: 'assistant/attempt', data: { stream: [] } },
    { type: 'turn/end', data: { turn: 1 } },
    null,
  ]);

  assert.equal(usage.uncachedIn, 30);
  assert.equal(usage.cacheRead, 30);
  assert.equal(usage.out, 3);
});

test('пустой лог — нули и hitRate 0, а не NaN', () => {
  const usage = foldUsage([]);

  assert.deepEqual(usage, {
    uncachedIn: 0,
    cacheRead: 0,
    cacheWrite: 0,
    out: 0,
    hitRate: 0,
    billedInput: 0,
  });
});

test('readOwnEvents предпочитает ownEvents, чтобы не считать контекст родителя', () => {
  const inherited = [message({ inputTokens: 1, outputTokens: 1 })];
  const own = [message({ inputTokens: 2, outputTokens: 2 })];
  const session = {
    ownEvents: () => own,
    snapshotEvents: () => [...inherited, ...own],
  };

  assert.deepEqual(readOwnEvents(session), own);

  const broken = { ownEvents: () => { throw new Error('нет доступа'); }, snapshotEvents: () => own };
  assert.deepEqual(readOwnEvents(broken), own, 'падение ownEvents уводит на snapshotEvents');

  assert.deepEqual(readOwnEvents({}), []);
});

test('свёртка кэшируется по seq и пересчитывается на новом событии', () => {
  const reader = createUsageReader();
  const events = [message({ inputTokens: 10, outputTokens: 1 })];
  const session = {
    id: 'session-1',
    seq: 1,
    ownEvents: () => events,
  };

  const first = reader.read(session);
  const second = reader.read(session);

  assert.equal(first, second, 'тот же seq — тот же объект, без пересчёта');
  assert.equal(reader.size(), 1);

  events.push(message({ inputTokens: 20, outputTokens: 2 }, 2, 1));
  session.seq = 2;
  const third = reader.read(session);

  assert.notEqual(third, first);
  assert.equal(third.uncachedIn, 30, 'новое событие учтено');
});

test('кэш свёртки не растёт безгранично', () => {
  const reader = createUsageReader();
  for (let index = 0; index < 200; index += 1) {
    reader.read({ id: `session-${index}`, seq: 1, ownEvents: () => [] });
  }

  assert.equal(reader.size(), 128);
});

test('проекция tokenUsage главнее свёртки и не читает лог', () => {
  const totals = {
    uncachedInputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 900,
    cacheWriteTokens: 10,
  };
  let ownEventsCalls = 0;
  const reader = createUsageReader({
    projections: { stateOf: (session, key) => (key === 'tokenUsage' ? { totals } : undefined) },
  });
  const session = {
    id: 'session-1',
    seq: 1,
    ownEvents: () => {
      ownEventsCalls += 1;
      return [];
    },
  };

  const usage = reader.read(session);

  assert.equal(usage.uncachedIn, 110, 'запись в кэш входит в некешированный вход');
  assert.equal(usage.cacheRead, 900);
  assert.equal(usage.out, 50);
  assert.equal(usage.billedInput, 1010);
  assert.ok(Math.abs(usage.hitRate - 900 / 1010) < 1e-12, 'та же формула, что у нативной пилюли');
  assert.equal(ownEventsCalls, 0, 'лог при живой проекции не читается');
});

test('без проекции или с упавшей проекцией работает свёртка событий', () => {
  const events = [message({ inputTokens: 5, outputTokens: 1 })];
  const session = { id: 's', seq: 1, ownEvents: () => events };

  const noProjection = createUsageReader().read(session);
  assert.equal(noProjection.uncachedIn, 5);

  const broken = createUsageReader({
    projections: { stateOf: () => { throw new Error('проекция недоступна'); } },
  });
  assert.equal(broken.read(session).uncachedIn, 5, 'ошибка проекции не роняет виджет');

  const empty = createUsageReader({ projections: { stateOf: () => undefined } });
  assert.equal(empty.read(session).uncachedIn, 5, 'нет ячейки — тоже fallback');
});

test('модель берётся из requestContext, затем из выбора по умолчанию', () => {
  assert.equal(
    sessionModel({ requestContext: () => ({ model: 'deepseek/deepseek-v4-flash-latest' }) }),
    'deepseek/deepseek-v4-flash-latest',
  );
  assert.equal(
    sessionModel({ requestContext: () => undefined }, { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4' }) }),
    'deepseek-v4',
  );
  assert.equal(sessionModel({}, () => ({ model: 'deepseek/from-function' })), 'deepseek/from-function');
  assert.equal(sessionModel({}, 'deepseek/from-string'), 'deepseek/from-string');
  assert.equal(sessionModel({ requestContext: () => ({}) }, {}), undefined);
  assert.equal(
    sessionModel({ requestContext: () => { throw new Error('нет контекста'); } }, { currentSelection: () => ({ model: 'deepseek/x' }) }),
    'deepseek/x',
    'падение requestContext не мешает запасному пути',
  );
});
