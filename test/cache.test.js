// Свойства кэша, от которых зависит вся остальная работа плагина: один поход в
// сеть на ключ, переживание рестарта, устойчивость к битому файлу и офлайну.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CACHE_VERSION,
  cacheFile,
  createCache,
  defaultCacheFile,
  stateDirectory,
} from '../lib/cache.js';

/**
 * Путь к файлу кэша во временном каталоге; каталог удаляется после теста.
 *
 * @param {import('node:test').TestContext} t — контекст теста.
 * @returns {string} — путь к ещё не существующему файлу.
 */
function temporaryFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'routerai-cost-widget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, '.routerai-cost-widget', 'cache.json');
}

test('повторный resolve внутри TTL не зовёт fetcher', async (t) => {
  const cache = createCache({ file: temporaryFile(t) });
  let calls = 0;
  const fetcher = () => {
    calls += 1;
    return { endpoints: calls };
  };

  const first = await cache.resolve('endpoints:deepseek/x', 60_000, fetcher);
  const second = await cache.resolve('endpoints:deepseek/x', 60_000, fetcher);

  assert.equal(calls, 1, 'fetcher вызван один раз');
  assert.deepEqual(first.value, { endpoints: 1 });
  assert.equal(second.stale, false, 'второе чтение свежее');
});

test('истёкший TTL снова зовёт fetcher', async (t) => {
  let clock = 1_000;
  const cache = createCache({ file: temporaryFile(t), now: () => clock });
  let calls = 0;
  const fetcher = () => {
    calls += 1;
    return calls;
  };

  await cache.resolve('prices', 100, fetcher);
  clock += 99;
  await cache.resolve('prices', 100, fetcher);
  assert.equal(calls, 1, '99 мс — ещё внутри TTL');

  clock += 1;
  const refreshed = await cache.resolve('prices', 100, fetcher);
  assert.equal(calls, 2, 'на границе TTL значение перезапрашивается');
  assert.equal(refreshed.value, 2);
});

test('два параллельных resolve дают один вызов fetcher', async (t) => {
  const cache = createCache({ file: temporaryFile(t) });
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return 'prices';
  };

  const [left, right] = await Promise.all([
    cache.resolve('endpoints:m', 60_000, fetcher),
    cache.resolve('endpoints:m', 60_000, fetcher),
  ]);

  assert.equal(calls, 1, 'single-flight: один поход в сеть');
  assert.equal(left.value, 'prices');
  assert.equal(right.value, 'prices');
});

test('ошибка fetcher при прошлом значении даёт stale:true и error', async (t) => {
  let clock = 1_000;
  const cache = createCache({ file: temporaryFile(t), now: () => clock });
  await cache.resolve('prices', 100, () => 91.5);

  clock += 10_000;
  const failure = new Error('нет сети');
  const result = await cache.resolve('prices', 100, () => {
    throw failure;
  });

  assert.equal(result.value, 91.5, 'отдано прошлое значение');
  assert.equal(result.stale, true);
  assert.equal(result.error, failure);
});

test('ошибка fetcher без прошлого значения пробрасывается и не блокирует ключ', async (t) => {
  const cache = createCache({ file: temporaryFile(t) });

  await assert.rejects(
    cache.resolve('models', 1_000, () => {
      throw new Error('boom');
    }),
    /boom/,
  );

  const recovered = await cache.resolve('models', 1_000, () => ['deepseek/deepseek-v4.1-flash-1017']);
  assert.deepEqual(recovered.value, ['deepseek/deepseek-v4.1-flash-1017']);
});

test('битый JSON не роняет чтение', async (t) => {
  const file = temporaryFile(t);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{ это не json');

  const cache = createCache({ file });
  assert.equal(await cache.read('models', 1_000), undefined, 'битый файл — пустой кэш');

  const resolved = await cache.resolve('models', 1_000, () => 42);
  assert.equal(resolved.value, 42, 'после битого файла кэш снова работает');
});

test('чужая версия схемы читается как пустой кэш', async (t) => {
  const file = temporaryFile(t);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 99, entries: { models: { at: 1, value: ['old'] } } }));

  const cache = createCache({ file, version: CACHE_VERSION });
  assert.equal(await cache.read('models', 1_000), undefined);
});

test('значение переживает рестарт', async (t) => {
  const file = temporaryFile(t);
  await createCache({ file }).write('models', ['a', 'b']);

  const restarted = createCache({ file });
  const entry = await restarted.read('models', 60_000);

  assert.deepEqual(entry.value, ['a', 'b']);
  assert.equal(entry.stale, false);
});

test('запись атомарна: временный файл не остаётся', async (t) => {
  const file = temporaryFile(t);
  const cache = createCache({ file });
  await cache.write('prices', { in: 9.03 });

  assert.deepEqual(readdirSync(dirname(file)), ['cache.json']);
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(parsed.version, CACHE_VERSION);
  assert.deepEqual(parsed.entries.prices.value, { in: 9.03 });
});

test('write(undefined) удаляет ключ', async (t) => {
  const cache = createCache({ file: temporaryFile(t) });
  await cache.write('k', 'v');
  assert.equal(await cache.write('k', undefined), undefined);
  assert.equal(await cache.read('k', 1_000), undefined);
});

test('без каталога профиля кэш живёт только в памяти', async () => {
  const home = mkdtempSync(join(tmpdir(), 'routerai-cost-widget-home-'));
  try {
    const file = defaultCacheFile({}, home);
    assert.equal(file, undefined, 'профиль не найден — файла нет');

    const cache = createCache({ file });
    assert.equal(cache.persisted, false);

    await cache.write('models', ['a']);
    assert.deepEqual((await cache.read('models', 1_000)).value, ['a']);
    assert.equal((await cache.snapshot()).file, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('каталог профиля берётся из окружения, а без него — по следам плагина', async () => {
  assert.equal(stateDirectory({ DSH_PROFILE_DIR: 'P' }), 'P');
  assert.equal(stateDirectory({ DSH_HOME: 'H', DSH_PROFILE: 'web' }), join('H', 'profiles', 'web'));
  assert.equal(stateDirectory({ DSH_HOME: 'H' }), join('H', 'profiles', 'default'));

  const home = mkdtempSync(join(tmpdir(), 'routerai-cost-widget-home-'));
  try {
    mkdirSync(join(home, 'profiles', 'desktop', 'node_modules', 'routerai-cost-widget'), { recursive: true });
    assert.equal(stateDirectory({}, home), join(home, 'profiles', 'desktop'));
    assert.equal(
      defaultCacheFile({}, home),
      join(home, 'profiles', 'desktop', '.routerai-cost-widget', 'cache.json'),
    );

    // Два профиля с плагином — состояние не сохраняем вовсе.
    mkdirSync(join(home, 'profiles', 'web', 'node_modules', 'routerai-cost-widget'), { recursive: true });
    assert.equal(stateDirectory({}, home), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('snapshot показывает возраст ключей и путь файла', async (t) => {
  const file = temporaryFile(t);
  let clock = 10_000;
  const cache = createCache({ file, now: () => clock });
  await cache.write('prices', 9.03);

  clock += 500;
  const state = await cache.snapshot();

  assert.equal(state.file, file);
  assert.equal(state.persisted, true);
  assert.equal(state.size, 1);
  assert.equal(state.entries.prices.ageMs, 500);
  assert.equal(cacheFile(undefined), undefined);
});
