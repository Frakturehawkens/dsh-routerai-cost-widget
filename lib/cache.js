/**
 * TTL-кэш для цен RouterAI.
 *
 * Три уровня, и все три нужны:
 *  - память — источник на каждом запросе, без диска и сети;
 *  - файл — переживает рестарт Host'а, пишется атомарно (tmp → rename);
 *  - single-flight — параллельные запросы одной сущности дают один поход в сеть.
 *
 * TTL задаёт вызывающий: один файл обслуживает цены модели (1 ч) и список
 * моделей (24 ч). Ошибка сети при наличии прошлого значения не роняет
 * виджет — наружу уходит старое значение с `stale: true` и `error`.
 *
 * @module routerai-cost-widget/cache
 */
import { readdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Имя пакета в `node_modules` профиля — по нему ищем профиль без переменных окружения. */
export const PACKAGE_NAME = 'routerai-cost-widget';

/** Каталог плагина внутри профиля. */
export const CACHE_DIR = '.routerai-cost-widget';

/** Имя файла кэша. */
export const CACHE_FILE = 'cache.json';

/**
 * Версия схемы файла; чужая версия читается как пустой кэш.
 *
 * 2 — из файла убран ключ `fx`: курс ЦБ больше не запрашивается (цены RouterAI
 * уже в рублях). Файл версии 1 игнорируется и перезаписывается на первом же
 * обращении, поэтому мёртвая запись не переезжает в новый кэш.
 */
export const CACHE_VERSION = 2;

/** @returns {boolean} — является ли значение простым объектом. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Профили, на которых есть следы этого плагина: установленный пакет или уже
 * записанный файл кэша.
 *
 * @param {string} profiles — каталог `<home>/profiles`.
 * @returns {string[]} — подходящие каталоги профилей.
 */
function evidenceProfiles(profiles) {
  try {
    return readdirSync(profiles, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(profiles, entry.name))
      .filter((dir) => {
        try {
          return readdirSync(join(dir, 'node_modules')).includes(PACKAGE_NAME)
            || readdirSync(dir).includes(CACHE_DIR);
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/**
 * Каталог, которому принадлежит файл кэша.
 *
 * Host объявляет профиль через `DSH_PROFILE_DIR` либо `DSH_HOME` + `DSH_PROFILE`.
 * Когда не объявлено ни то ни другое (сам процесс приложения переменных не
 * экспортирует, хотя его дочерние процессы — да), профиль ищется по следам
 * плагина. Два кандидата — значит, каталога нет: размазывать состояние по
 * профилям хуже, чем не сохранять его вовсе.
 *
 * @param {NodeJS.ProcessEnv} [env] — переменные окружения, по умолчанию свои.
 * @param {string} [home] — запасной `~/.dsh`, подменяется в тестах.
 * @returns {string | undefined} — каталог профиля либо undefined.
 */
export function stateDirectory(env = process.env, home = join(homedir(), '.dsh')) {
  const fromProfile = env.DSH_PROFILE_DIR;
  if (typeof fromProfile === 'string' && fromProfile !== '') return fromProfile;
  const advertised = env.DSH_HOME;
  if (typeof advertised === 'string' && advertised !== '') {
    return join(advertised, 'profiles', env.DSH_PROFILE ?? 'default');
  }
  const found = evidenceProfiles(join(home, 'profiles'));
  return found.length === 1 ? found[0] : undefined;
}

/**
 * Путь к файлу кэша внутри каталога профиля.
 *
 * @param {string | undefined} dir — каталог профиля.
 * @returns {string | undefined} — путь либо undefined, если профиля нет.
 */
export function cacheFile(dir) {
  return dir === undefined ? undefined : join(dir, CACHE_DIR, CACHE_FILE);
}

/**
 * Путь к файлу кэша по переменным окружения процесса.
 *
 * @param {NodeJS.ProcessEnv} [env] — переменные окружения.
 * @param {string} [home] — запасной `~/.dsh`.
 * @returns {string | undefined} — путь либо undefined.
 */
export function defaultCacheFile(env = process.env, home) {
  return cacheFile(stateDirectory(env, home));
}

/**
 * Создать кэш.
 *
 * @param {object} [options]
 * @param {string} [options.file] — файл кэша; без него кэш живёт только в памяти.
 * @param {number | string} [options.version] — версия схемы файла.
 * @param {() => number} [options.now] — часы, подменяются в тестах.
 * @returns {{
 *   persisted: boolean,
 *   read(key: string, ttlMs?: number): Promise<{value: unknown, at: number, stale: boolean} | undefined>,
 *   write(key: string, value: unknown): Promise<number | undefined>,
 *   resolve(key: string, ttlMs: number, fetcher: () => unknown | Promise<unknown>): Promise<{value: unknown, at: number, stale: boolean, error?: unknown}>,
 *   snapshot(): Promise<object>,
 * }}
 */
export function createCache({ file, version = CACHE_VERSION, now = Date.now } = {}) {
  /** @type {Map<string, {value: unknown, at: number}>} */
  const entries = new Map();
  /** @type {Map<string, Promise<{value: unknown, at: number, stale: boolean, error?: unknown}>>} */
  const inflight = new Map();
  /** @type {Promise<void> | undefined} */
  let loaded;
  /** @type {Promise<void>} */
  let persistChain = Promise.resolve();
  /** @type {unknown} */
  let lastPersistError;

  /**
   * Прочитать файл кэша один раз за жизнь экземпляра.
   *
   * Битый JSON, чужая версия схемы и недоступный файл дают пустой кэш без
   * исключения: испорченный файл не должен превращаться в падение виджета.
   *
   * @returns {Promise<void>}
   */
  async function loadFromDisk() {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(parsed) || parsed.version !== version || !isRecord(parsed.entries)) return;
    for (const [key, entry] of Object.entries(parsed.entries)) {
      if (!isRecord(entry)) continue;
      if (typeof entry.at !== 'number' || !Number.isFinite(entry.at)) continue;
      // Запись, сделанная до загрузки файла, свежее прочитанной — её не трогаем.
      if (entries.has(key)) continue;
      entries.set(key, { value: entry.value, at: entry.at });
    }
  }

  /** @returns {Promise<void>} — файл прочитан (или читать нечего). */
  function ensureLoaded() {
    if (file === undefined) return Promise.resolve();
    if (loaded === undefined) loaded = loadFromDisk();
    return loaded;
  }

  /**
   * Записать текущее состояние в файл. Ошибки диска запоминаются, но наружу не
   * летят: кэш в памяти продолжает работать.
   *
   * @returns {Promise<void>}
   */
  async function writeSnapshot() {
    if (file === undefined) return;
    try {
      const payload = `${JSON.stringify({ version, entries: Object.fromEntries(entries) }, null, 2)}\n`;
      const temporary = `${file}.tmp`;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(temporary, payload, 'utf8');
      await rename(temporary, file);
      lastPersistError = undefined;
    } catch (error) {
      lastPersistError = error;
    }
  }

  /**
   * Поставить запись в очередь: параллельные `write` не должны перетирать файл
   * друг другом, а упавшая запись не должна рвать очередь.
   *
   * @returns {Promise<void>}
   */
  function persist() {
    persistChain = persistChain.then(writeSnapshot, writeSnapshot);
    return persistChain;
  }

  /**
   * Прочитать значение из памяти (при первом обращении — предварительно с диска).
   *
   * @param {string} key — ключ.
   * @param {number} [ttlMs] — срок жизни; по умолчанию бесконечный (только для чтения).
   * @returns {Promise<{value: unknown, at: number, stale: boolean} | undefined>}
   */
  async function read(key, ttlMs = Number.POSITIVE_INFINITY) {
    await ensureLoaded();
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    return { value: entry.value, at: entry.at, stale: now() - entry.at >= ttlMs };
  }

  /**
   * Положить значение в память и в файл. `undefined` удаляет ключ.
   *
   * @param {string} key — ключ.
   * @param {unknown} value — значение (должно переживать JSON).
   * @returns {Promise<number | undefined>} — время записи либо undefined при удалении.
   */
  async function write(key, value) {
    await ensureLoaded();
    if (value === undefined) {
      entries.delete(key);
      await persist();
      return undefined;
    }
    const at = now();
    entries.set(key, { value, at });
    await persist();
    return at;
  }

  /**
   * Достать значение из кэша или сходить за ним в сеть.
   *
   * Один Promise на ключ: второй параллельный вызов ждёт первый, а не дублирует
   * запрос. Если fetcher упал, а прошлое значение есть — отдаём его со
   * `stale: true` и `error`; если прошлого значения нет — пробрасываем ошибку.
   *
   * @param {string} key — ключ.
   * @param {number} ttlMs — срок жизни значения.
   * @param {() => unknown | Promise<unknown>} fetcher — источник свежего значения.
   * @returns {Promise<{value: unknown, at: number, stale: boolean, error?: unknown}>}
   */
  async function resolve(key, ttlMs, fetcher) {
    const cached = await read(key, ttlMs);
    if (cached !== undefined && !cached.stale) return cached;

    const running = inflight.get(key);
    if (running !== undefined) return running;

    const pending = fetchAndStore(key, fetcher, cached);
    inflight.set(key, pending);
    // Ключ снимается после того, как промис осел, а не внутри операции:
    // операция выполняется синхронно до первого await, и при синхронном броске
    // fetcher'а удалила бы запись, которой в карте ещё нет, — отклонённый
    // промис остался бы там навсегда. Обработчик отказа не пробрасывает
    // ошибку дальше, поэтому производный промис не бывает необработанным.
    const forget = () => inflight.delete(key);
    pending.then(forget, forget);
    return pending;
  }

  /**
   * Один поход в сеть с записью результата в кэш.
   *
   * @param {string} key — ключ.
   * @param {() => unknown | Promise<unknown>} fetcher — источник свежего значения.
   * @param {{value: unknown, at: number, stale: boolean} | undefined} cached — прошлое значение.
   * @returns {Promise<{value: unknown, at: number, stale: boolean, error?: unknown}>}
   */
  async function fetchAndStore(key, fetcher, cached) {
    try {
      const value = await fetcher();
      if (value === undefined) throw new Error(`cache: fetcher for "${key}" returned undefined`);
      const at = await write(key, value);
      return { value, at: at ?? now(), stale: false };
    } catch (error) {
      if (cached !== undefined) return { value: cached.value, at: cached.at, stale: true, error };
      throw error;
    }
  }

  /**
   * Состояние кэша для диагностики: какие ключи есть, насколько они стары, куда
   * пишется файл. Значения не отдаются — они бывают крупными.
   *
   * @returns {Promise<{file: string | null, persisted: boolean, version: number | string, size: number, entries: Record<string, {at: number, ageMs: number}>, lastPersistError: string | null}>}
   */
  async function snapshot() {
    await ensureLoaded();
    const at = now();
    /** @type {Record<string, {at: number, ageMs: number}>} */
    const out = {};
    for (const [key, entry] of entries) out[key] = { at: entry.at, ageMs: Math.max(0, at - entry.at) };
    return {
      file: file ?? null,
      persisted: file !== undefined,
      version,
      size: entries.size,
      entries: out,
      lastPersistError: lastPersistError === undefined ? null : String(lastPersistError),
    };
  }

  return {
    persisted: file !== undefined,
    read,
    write,
    resolve,
    snapshot,
  };
}
