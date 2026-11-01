// routerai-cost-widget — Host half.
//
// Everything that needs the session, the network, or a disk lives here: the
// client half is a plain-JS React component that only draws what this half
// computes. See README.md for the route contract.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCache, defaultCacheFile, stateDirectory } from './lib/cache.js';
import { API_BASE, createRouterai } from './lib/routerai.js';
import { createUsageReader } from './lib/usage.js';
import { createStateService } from './lib/state.js';

/** Plugin name, reused by log lines and the patch row. */
export const name = 'routerai-cost-widget';

/** Точка чтения состояния. */
export const STATE_PATH = '/routerai-cost-widget/state';

/** Точка принудительного обновления цен. */
export const REFRESH_PATH = '/routerai-cost-widget/refresh';

// schemastery даёт профилю валидацию и страницу настроек. Импорт динамический:
// сторонний плагин обязан работать и там, где пакета нет. Статический импорт
// отсутствующего пакета уронил бы загрузку всего профиля — это хуже, чем
// потерять валидацию конфига.
//
// Второй путь нужен из-за симлинка: плагин установлен как ссылка на рабочий
// каталог, поэтому `import('@deepseek-ai/schemastery')` ищет peer-зависимость
// от реального пути и не находит её. Резолвим от каталога профиля.
async function loadSchema() {
  try {
    return (await import('@deepseek-ai/schemastery')).default;
  } catch {
    /* пробуем каталог профиля */
  }
  const profile = stateDirectory();
  if (profile === undefined) return undefined;
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve('@deepseek-ai/schemastery', { paths: [join(profile, 'node_modules')] });
    return (await import(pathToFileURL(resolved).href)).default;
  } catch {
    return undefined;
  }
}

const Schema = await loadSchema();

/**
 * Валидированная конфигурация; `undefined`, если schemastery недоступен.
 *
 * `modelAliases` намеренно `Schema.any()`: YAML-объект не должен превращаться
 * в отказ загрузки плагина. Настоящая проверка — при выборе alias'а.
 */
export const Config = Schema?.object({
  apiBase: Schema.string()
    .default(API_BASE)
    .description('База API RouterAI. Меняется только для тестового стенда.'),
  modelAliases: Schema.any()
    .default({})
    .description('Ручной маппинг id модели сессии на id каталога RouterAI: `{ "deepseek/…-latest": "deepseek/…-1017" }`.'),
});

/** @returns {boolean} — является ли значение простым объектом. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON-ответ, как у штатных маршрутов. */
function sendJson(response, status, body, headers = {}) {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(payload);
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config
 */
export function apply(ctx, config) {
  const settings = isRecord(config) ? config : {};

  const cache = createCache({ file: defaultCacheFile() });
  const router = createRouterai({
    apiBase: typeof settings.apiBase === 'string' && settings.apiBase !== '' ? settings.apiBase : API_BASE,
    cache,
  });
  const service = createStateService({
    router,
    usage: createUsageReader({ projections: ctx.get('sessionProjections') }),
    aliases: isRecord(settings.modelAliases) ? settings.modelAliases : {},
    now: Date.now,
  });

  // Маршрут регистрируется через `ctx.inject`, а не разовой проверкой: строка
  // активируется, как только появился `webServer`, иначе маршрут теряется на
  // весь процесс и клиент получает 404 (проверено на `dsh-token-frugal`).
  ctx.inject(['webServer'], (webCtx) => {
    const sessions = webCtx.get('sessions');
    const defaultModel = webCtx.get('agentDefaultModel');

    /**
     * Обработчик одного маршрута.
     *
     * @param {boolean} fresh — игнорировать TTL цен.
     * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
     */
    function handler(fresh) {
      return async (request, response) => {
        const method = fresh ? 'POST' : 'GET';
        try {
          if (request.method !== method) {
            sendJson(response, 405, { error: `метод ${request.method} не поддерживается, нужен ${method}` }, { allow: method });
            return;
          }
          const url = new URL(request.url ?? '/', 'http://localhost');
          const sessionId = url.searchParams.get('sessionId');
          if (sessionId === null || sessionId === '') {
            sendJson(response, 400, { error: 'параметр sessionId обязателен' });
            return;
          }
          if (sessions === undefined || typeof sessions.get !== 'function') {
            sendJson(response, 503, { error: 'сервис сессий недоступен' });
            return;
          }
          const session = sessions.get(sessionId);
          if (session === undefined) {
            sendJson(response, 404, { error: `сессия не найдена: ${sessionId}` });
            return;
          }
          const payload = await service.build({ sessionId, session, defaultModel, fresh });
          sendJson(response, 200, payload);
        } catch (error) {
          // Сборка состояния ловит сетевые сбои сама и кладёт их в `payload.error`;
          // сюда попадают только программные ошибки. Наружу — общий текст: в
          // сообщении бывают абсолютные пути, а подробности нужны в логе.
          ctx.logger?.warn(`routerai-cost-widget: сборка состояния не удалась — ${String(error?.stack ?? error)}`);
          sendJson(response, 500, { error: 'внутренняя ошибка сборки состояния' });
        }
      };
    }

    ctx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: STATE_PATH, handler: handler(false) }),
      'routerai-cost-widget: state route',
    );
    ctx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: REFRESH_PATH, handler: handler(true) }),
      'routerai-cost-widget: refresh route',
    );
    ctx.logger?.info(`routerai-cost-widget: маршруты ${STATE_PATH} (GET) и ${REFRESH_PATH} (POST) зарегистрированы`);
  });
}
