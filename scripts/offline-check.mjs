// Ручная проверка шага 12: холодный старт и офлайн.
//
// Запуск из корня пакета: `node scripts/offline-check.mjs`
// Проверяет три вещи без рестарта Harness и без сети:
//  1) свежий экземпляр кэша читает цены с диска (переживает рестарт);
//  2) `fetchedAt` берётся из файла, а не «сбрасывается в 1970»;
//  3) при недоступной сети и истёкшем TTL отдаётся старое значение с
//     `stale: true` и текстом ошибки, а не исключение.
import { createCache, defaultCacheFile } from '../lib/cache.js';
import { createRouterai, ENDPOINTS_KEY_PREFIX } from '../lib/routerai.js';

const offline = () => {
  throw new Error('offline: сеть недоступна (проверка шага 12)');
};

const file = defaultCacheFile();
if (file === undefined) {
  console.error('не удалось определить каталог профиля: задайте DSH_PROFILE_DIR');
  process.exit(2);
}

// Новый экземпляр кэша = холодный старт: в памяти пусто, всё берётся с диска.
const cache = createCache({ file });
const router = createRouterai({ cache, fetch: offline });

const snapshot = await cache.snapshot();
console.log('файл кэша:', snapshot.file);
console.log('ключей на диске:', snapshot.size);

const models = await router.listModels();
console.log('каталог моделей с диска:', models.length, 'записей');

const modelKey = Object.keys(snapshot.entries).find((key) => key.startsWith(ENDPOINTS_KEY_PREFIX));
if (modelKey === undefined) {
  console.error('в кэше нет ни одного ключа цен — сначала откройте пилюлю в GUI');
  process.exit(2);
}
const modelId = modelKey.slice(ENDPOINTS_KEY_PREFIX.length);

const warm = await router.endpoints(modelId);
console.log('цены с диска:', warm.providers.length, 'провайдеров, stale =', warm.stale);
console.log('fetchedAt:', new Date(warm.fetchedAt).toISOString(), '(', warm.fetchedAt, ')');
if (warm.fetchedAt < Date.UTC(2024, 0, 1)) {
  console.error('fetchedAt выглядит сброшенным — регресс');
  process.exit(1);
}

// TTL = 0 (как у кнопки Refresh) заставляет идти в сеть; сеть сломана.
const stale = await router.endpoints(modelId, { fresh: true });
console.log('офлайн после истечения TTL: stale =', stale.stale, '| провайдеров =', stale.providers.length);
console.log('текст ошибки:', stale.error);
if (stale.stale !== true || stale.providers.length === 0 || typeof stale.error !== 'string') {
  console.error('офлайн-фолбэк не сработал');
  process.exit(1);
}
console.log('OK: кэш переживает рестарт, офлайн отдаёт stale-данные');
