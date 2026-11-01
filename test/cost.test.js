// Свойства расчёта: цены RouterAI уже в ₽, курс валют не участвует,
// а провайдер без цены не должен выглядеть бесплатным.
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCosts, providerCost } from '../lib/cost.js';

/** Провайдер с ценами в ₽ за 1M токенов. */
function provider(label, pricesPerM) {
  return { name: label, label, tag: label.toLowerCase(), status: 0, variable: false, pricesPerM };
}

const USAGE = { uncachedIn: 1_000_000, cacheRead: 0, out: 0 };

test('формула: некешированный вход, кэш и выход по своим ценам', () => {
  const cost = providerCost(provider('A', { in: 0.3, cache: 0.03, out: 1.2 }), {
    uncachedIn: 1_000_000,
    cacheRead: 2_000_000,
    out: 500_000,
  });

  assert.equal(cost.priced, true);
  assert.ok(Math.abs(cost.costRub - 0.96) < 1e-12, '0.3 + 0.06 + 0.6 = 0.96 ₽');
});

test('минимум и разница считаются в рублях, порядок — по возрастанию', () => {
  const { providers, cheapest, unpricedCount } = estimateCosts({
    providers: [
      provider('Дорогой', { in: 5, out: 5 }),
      provider('Средний', { in: 3, out: 3 }),
      provider('Дешёвый', { in: 1, out: 1 }),
    ],
    usage: USAGE,
  });

  assert.equal(cheapest.label, 'Дешёвый');
  assert.equal(cheapest.isCheapest, true);
  assert.equal(unpricedCount, 0);
  assert.deepEqual(providers.map((row) => row.label), ['Дешёвый', 'Средний', 'Дорогой']);
  assert.equal(providers[0].costRub, 1, '1M токенов × 1 ₽/M');
  assert.equal(providers[1].costRub, 3);
  assert.ok(Math.abs(providers[1].deltaRub - 2) < 1e-12);
  assert.ok(Math.abs(providers[1].deltaPercent - 2) < 1e-12, 'в 2 раза дороже минимума');
  assert.equal(providers[0].deltaRub, 0);
  assert.equal(providers[0].deltaPercent, 0);
});

test('провайдер без цены не бесплатный: выпадает из минимума и считается отдельно', () => {
  const { providers, cheapest, unpricedCount } = estimateCosts({
    providers: [
      provider('Без выхода', { in: 0.1 }),
      provider('Полный', { in: 0.2, cache: 0.2, out: 0.2 }),
    ],
    usage: USAGE,
  });

  const unpriced = providers.find((row) => row.label === 'Без выхода');
  assert.equal(unpriced.priced, false);
  assert.equal(unpriced.costRub, null);
  assert.equal(unpriced.deltaRub, null);
  assert.equal(unpriced.isCheapest, false);
  assert.equal(unpricedCount, 1);
  assert.equal(cheapest.label, 'Полный', 'минимум только среди посчитанных');
  assert.equal(providers[1].label, 'Без выхода', 'без цен — в конце списка');
});

test('кэш без цены стоит как обычный вход', () => {
  const cost = providerCost(provider('A', { in: 0.5, out: 1 }), { uncachedIn: 0, cacheRead: 1_000_000, out: 0 });

  assert.equal(cost.costRub, 0.5);
});

test('нулевой usage: провайдеры стоят 0, минимум всё равно выбран', () => {
  const { providers, cheapest } = estimateCosts({
    providers: [provider('B', { in: 2, out: 2 }), provider('A', { in: 1, out: 1 })],
    usage: { uncachedIn: 0, cacheRead: 0, out: 0 },
  });

  assert.equal(providers.every((row) => row.costRub === 0), true);
  assert.equal(cheapest.label, 'A', 'при равенстве решает подпись');
  assert.equal(cheapest.deltaPercent, 0, 'процент от нуля не определён — 0, а не NaN');
});

test('нет посчитанных провайдеров — cheapest null, а не выдуманный ноль', () => {
  const result = estimateCosts({
    providers: [provider('Пустой', {})],
    usage: USAGE,
  });

  assert.equal(result.cheapest, null);
  assert.equal(result.unpricedCount, 1);
});

test('providers не массив — ошибка', () => {
  assert.throws(() => estimateCosts({ providers: 'нет', usage: USAGE }), /providers/);
});
