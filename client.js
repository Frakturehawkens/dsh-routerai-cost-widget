// routerai-cost-widget — client half.
//
// A classic script that registers a lazy-CJS factory with the web shell's module
// loader. Running it only registers the factory; the body below executes at
// materialization, where `require('react')` resolves from the shell's module
// table. There is no bundler and no JSX.
//
// Данные считает Host (`index.js` + `lib/`): здесь только отрисовка пилюли в
// `conversation.composer.dock` — рядом с нативной `usage` (`order: 1`), поэтому
// наш `order: 2`. Сеть у клиента одна: свой же маршрут состояния.

window.__ModuleLoader__.load({
  id: 'routerai-cost-widget',
  factory(require) {
    const React = require('react');
    // Панель рендерится в `document.body`: композер обрезает содержимое по
    // своим границам, и поповер внутри него был бы срезан.
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    /** Маршрут состояния: модель, usage, провайдеры с ценами и стоимостью. */
    const STATE_ENDPOINT = '/routerai-cost-widget/state';

    /** Маршрут ручного обновления цен (`fresh: true`, игнорирует TTL). */
    const REFRESH_ENDPOINT = '/routerai-cost-widget/refresh';

    /**
     * Задержка перед запросом. Сессия во время ответа меняет `tokenUsage`
     * несколько раз подряд; без склейки пилюля дёргала бы Host на каждый шаг.
     */
    const REFETCH_DELAY_MS = 250;

    /**
     * Таймаут ручного обновления. Host отвечает за ~15 с (свой таймаут запроса
     * к RouterAI), поэтому клиент ждёт чуть дольше: иначе он сдался бы первым
     * при живом запросе.
     */
    const REFRESH_TIMEOUT_MS = 20_000;

    /** Зазор между пилюлей и панелью. */
    const PANEL_GAP = 8;

    /** Отступ панели от края вьюпорта. */
    const PANEL_MARGIN = 12;

    /** Неразмещённая панель: скрыта, но измерена — иначе нечего выравнивать. */
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };

    /**
     * Тексты. Локаль берётся из `document.documentElement.lang`: сервис
     * `locale` у стороннего бандла читается не всегда, а язык страницы есть
     * всегда. Словари продублированы в `locale/*.json` для карточки плагина.
     */
    const TEXT = {
      ru: {
        title: 'Стоимость RouterAI',
        loading: '…',
        noPrice: 'нет цен',
        error: 'нет данных',
        cheapest: 'минимум',
        priceHint: '₽ за 1 млн токенов',
        input: 'вход',
        cache: 'кэш',
        output: 'выход',
        delta: 'дороже минимума',
        refresh: 'Обновить',
        refreshing: 'Обновляю…',
        refreshTimeout: 'обновление не ответило',
        updated: 'обновлено',
        stale: 'цены из кэша',
        hidden: (count) => `${count} недоступно`,
        unpriced: (count) => `${count} без цен`,
        empty: 'RouterAI не вернул провайдеров для этой модели',
      },
      en: {
        title: 'RouterAI cost',
        loading: '…',
        noPrice: 'no prices',
        error: 'unavailable',
        cheapest: 'cheapest',
        priceHint: '₽ per 1M tokens',
        input: 'in',
        cache: 'cache',
        output: 'out',
        delta: 'over the cheapest',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        refreshTimeout: 'refresh timed out',
        updated: 'updated',
        stale: 'prices from cache',
        hidden: (count) => `${count} unavailable`,
        unpriced: (count) => `${count} unpriced`,
        empty: 'RouterAI returned no providers for this model',
      },
    };

    /** Рубли с двумя знаками: `₽12,34`. */
    const RUB = new Intl.NumberFormat('ru-RU', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

    /** Цена за миллион токенов: без хвостовых нулей (`35`, `3,5`, `0,42`). */
    const PER_MILLION = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

    /** @returns {'ru' | 'en'} — язык подписей. */
    function pickLocale() {
      const declared = typeof document !== 'undefined'
        ? String(document.documentElement.getAttribute('lang') ?? '')
        : '';
      const preferred = declared !== '' ? declared : String(
        typeof navigator !== 'undefined' ? navigator.language : 'en',
      );
      return preferred.toLowerCase().startsWith('ru') ? 'ru' : 'en';
    }

    /** @returns {object} — словарь активной локали. */
    function textOf(locale) {
      return TEXT[locale] ?? TEXT.en;
    }

    /**
     * Стоимость в рублях.
     *
     * @param {unknown} value — `costRub` из ответа Host.
     * @returns {string | null} — подпись либо `null`, если считать нечего.
     */
    function formatRub(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
      // Ненулевая, но ничтожная стоимость: «₽0,00» читалось бы как «бесплатно».
      if (value > 0 && value < 0.01) return '< ₽0,01';
      return `₽${RUB.format(value)}`;
    }

    /**
     * Цена за миллион токенов.
     *
     * @param {unknown} value — `pricesPerM.*` из ответа Host.
     * @returns {string} — число либо прочерк.
     */
    function formatPrice(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
      return PER_MILLION.format(value);
    }

    /**
     * Насколько провайдер дороже самого дешёвого.
     *
     * @param {object} row — строка провайдера с `deltaRub`.
     * @returns {string} — `+₽X,XX`, `+< ₽0,01` или прочерк у минимума.
     */
    function formatDelta(row) {
      const value = row !== null && typeof row === 'object' ? row.deltaRub : null;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—';
      if (value < 0.01) return '+< ₽0,01';
      return `+₽${RUB.format(value)}`;
    }

    /**
     * Компактное число токенов: `1,2M`, `12,3k`, `987`.
     *
     * @param {unknown} value — счётчик токенов.
     * @returns {string} — подпись.
     */
    function compactTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0';
      if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
      if (value >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
      return String(Math.round(value));
    }

    /**
     * Время последнего обновления цен — только часы и минуты.
     *
     * @param {unknown} ms — `fetchedAt` (метка времени).
     * @returns {string} — `14:05` либо прочерк.
     */
    function formatClock(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
      const date = new Date(ms);
      if (Number.isNaN(date.getTime())) return '—';
      return date.toLocaleTimeString(pickLocale() === 'ru' ? 'ru-RU' : 'en-GB', {
        hour: '2-digit',
        minute: '2-digit',
      });
    }

    /**
     * Ключ usage: меняется только вместе с фактическим расходом токенов.
     *
     * Проекцию `tokenUsage` регистрирует `dsh-token-meter`; её поля — те же
     * счётчики, что и в ответе Host, поэтому ключ строится прямо по ним.
     *
     * @param {unknown} usage — значение проекции либо `undefined`.
     * @returns {string} — стабильная строка для зависимостей эффекта.
     */
    function usageKeyOf(usage) {
      if (typeof usage !== 'object' || usage === null) return '';
      return [
        usage.uncachedInputTokens,
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
        usage.outputTokens,
      ].join(':');
    }

    /**
     * Последний удачный ответ по сессии.
     *
     * Кэш модульный, а не компонентный: док пересоздаёт пилюлю при переходе
     * между сессиями, и без него виджет мигал бы пустотой на каждом возврате.
     */
    const cache = new Map();

    /** @returns {object | null} — сохранённое состояние сессии. */
    function readCache(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return null;
      const entry = cache.get(sessionId);
      return entry === undefined ? null : entry;
    }

    /** Запомнить состояние сессии; размер кэша ограничен числом сессий. */
    function writeCache(sessionId, data) {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      cache.set(sessionId, data);
      // Дольше нескольких сессий назад история не нужна: значения всё равно
      // пересчитываются на каждый запрос.
      if (cache.size > 32) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
    }

    /**
     * Разобрать ответ маршрута: тело читается до проверки статуса, потому что
     * Host кладёт причину отказа в `error`.
     *
     * @param {Response} response — ответ fetch.
     * @returns {Promise<object>} — JSON.
     */
    async function readJson(response) {
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const reason = body !== null && typeof body.error === 'string'
          ? body.error
          : `HTTP ${response.status}`;
        throw new Error(reason);
      }
      return body;
    }

    /**
     * Запросить состояние у Host.
     *
     * @param {string} sessionId — id сессии (`session-<uuid>`).
     * @param {AbortSignal} [signal] — отмена при размонтировании.
     * @returns {Promise<object>} — JSON маршрута `state`.
     */
    async function fetchState(sessionId, signal) {
      const url = `${STATE_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`;
      const response = await fetch(url, { signal, headers: { accept: 'application/json' } });
      return readJson(response);
    }

    /**
     * Принудительно обновить цены этой модели.
     *
     * @param {string} sessionId — id сессии.
     * @param {AbortSignal} [signal] — отмена при таймауте и размонтировании.
     * @returns {Promise<object>} — то же состояние, что и у `state`.
     */
    async function fetchRefresh(sessionId, signal) {
      const url = `${REFRESH_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`;
      const response = await fetch(url, { method: 'POST', signal, headers: { accept: 'application/json' } });
      return readJson(response);
    }

    /**
     * Состояние пилюли: последний ответ, ошибка сети и признак загрузки.
     *
     * @param {string | undefined} sessionId — пропс слота.
     * @param {string} usageKey — отпечаток расхода токенов.
     * @returns {{data: object | null, error: string, loading: boolean, replace: Function}}
     */
    function useCostState(sessionId, usageKey) {
      const [store, setStore] = React.useState(() => ({
        sessionId,
        data: readCache(sessionId),
      }));
      const [error, setError] = React.useState('');
      const [loading, setLoading] = React.useState(false);

      // Другая сессия — сразу подставляем её кэш, чтобы не показывать чужую
      // стоимость даже один кадр.
      const data = store.sessionId === sessionId ? store.data : readCache(sessionId);

      React.useEffect(() => {
        setError('');
        setStore({ sessionId, data: readCache(sessionId) });
      }, [sessionId]);

      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined;
        let alive = true;
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
        setLoading(true);
        const timer = setTimeout(() => {
          fetchState(sessionId, controller?.signal)
            .then((next) => {
              if (!alive) return;
              writeCache(sessionId, next);
              setStore({ sessionId, data: next });
              setError('');
            })
            .catch((failure) => {
              if (!alive) return;
              if (failure instanceof Error && failure.name === 'AbortError') return;
              setError(String(failure instanceof Error ? failure.message : failure));
            })
            .finally(() => {
              if (alive) setLoading(false);
            });
        }, REFETCH_DELAY_MS);

        return () => {
          alive = false;
          clearTimeout(timer);
          controller?.abort();
        };
      }, [sessionId, usageKey]);

      /** Принять ответ ручного обновления: он уже посчитан Host'ом. */
      const replace = React.useCallback((next) => {
        writeCache(sessionId, next);
        setStore({ sessionId, data: next });
        setError('');
      }, [sessionId]);

      return { data, error, loading, replace };
    }

    /**
     * Позиция панели над пилюлей.
     *
     * Панель сначала рендерится скрытой и неразмещённой: только после реального
     * измерения известно, влезает ли она вверх, и насколько её сдвинуть, чтобы
     * она не вышла за край. Пересчёт — при прокрутке и изменении размера окна.
     *
     * @param {object} input
     * @param {boolean} input.open — панель открыта.
     * @param {{current: HTMLElement | null}} input.anchorRef — пилюля.
     * @param {{current: HTMLElement | null}} input.panelRef — панель.
     * @param {number} input.gap — зазор до пилюли.
     * @param {number} input.margin — отступ от края вьюпорта.
     * @param {unknown} input.version — значение, при смене которого нужен пересчёт.
     * @returns {{left: number, top: number} | null} — координаты или `null` (ещё не измерено).
     */
    function useAnchoredPosition({ open, anchorRef, panelRef, gap, margin, version }) {
      const [pos, setPos] = React.useState(null);

      React.useLayoutEffect(() => {
        if (!open) {
          setPos(null);
          return undefined;
        }
        const measure = () => {
          const anchor = anchorRef.current;
          const panel = panelRef.current;
          if (anchor === null || panel === null) return;
          const a = anchor.getBoundingClientRect();
          const p = panel.getBoundingClientRect();
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          // До первого измерения панель может быть нулевой — берём запас.
          const width = p.width > 0 ? p.width : 360;
          const height = p.height > 0 ? p.height : 240;
          const centred = a.left + a.width / 2 - width / 2;
          const left = Math.max(margin, Math.min(centred, vw - width - margin));
          // По умолчанию вверх: док живёт у нижней границы окна.
          let top = a.top - gap - height;
          if (top < margin) top = Math.min(a.bottom + gap, vh - height - margin);
          setPos({ left: Math.round(left), top: Math.round(Math.max(margin, top)) });
        };
        measure();
        window.addEventListener('resize', measure);
        window.addEventListener('scroll', measure, true);
        return () => {
          window.removeEventListener('resize', measure);
          window.removeEventListener('scroll', measure, true);
        };
      }, [open, anchorRef, panelRef, gap, margin, version]);

      return pos;
    }

    /**
     * Закрытие по Escape и по клику вне пилюли и панели.
     *
     * @param {object} input
     * @param {boolean} input.open — панель открыта.
     * @param {{current: HTMLElement | null}} input.anchorRef — пилюля.
     * @param {{current: HTMLElement | null}} input.panelRef — панель.
     * @param {() => void} input.onDismiss — закрыть.
     */
    function useDismiss({ open, anchorRef, panelRef, onDismiss }) {
      React.useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onDismiss();
        };
        // Перехват на фазе захвата: панель может лежать над другими слоями, а
        // клик по ней сам себя закрывать не должен.
        const onClick = (event) => {
          const target = event.target;
          if (!(target instanceof Node)) return;
          if (anchorRef.current?.contains(target) === true) return;
          if (panelRef.current?.contains(target) === true) return;
          onDismiss();
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('click', onClick, true);
        return () => {
          document.removeEventListener('keydown', onKeyDown);
          document.removeEventListener('click', onClick, true);
        };
      }, [open, anchorRef, panelRef, onDismiss]);
    }

    /**
     * Содержимое поповера: все провайдеры модели с ценами и стоимостью сессии.
     *
     * @param {object} input
     * @param {object | null} input.data — ответ Host.
     * @param {string} input.error — ошибка сети (последний запрос).
     * @param {string} input.refreshError — ошибка ручного обновления.
     * @param {boolean} input.refreshing — идёт ручное обновление.
     * @param {{left: number, top: number} | null} input.pos — координаты панели.
     * @param {{current: HTMLElement | null}} input.panelRef — ссылка на панель.
     * @param {object} input.text — словарь локали.
     * @param {() => void} input.onRefresh — обновить цены.
     * @returns {React.ReactElement} — панель.
     */
    function renderPanel({ data, error, refreshError, refreshing, pos, panelRef, text, onRefresh }) {
      const providers = data !== null && Array.isArray(data.providers) ? data.providers : [];
      const cheapest = data !== null && data.cheapest !== null && typeof data.cheapest === 'object'
        ? data.cheapest
        : null;
      const usage = data !== null && typeof data.usage === 'object' && data.usage !== null
        ? data.usage
        : null;
      const hostError = data !== null && typeof data.error === 'string' ? data.error : '';
      const problem = refreshError !== '' ? refreshError : (error !== '' ? error : hostError);

      const title = h('div', { className: 'rcw_title', key: 'title' },
        h('span', { className: 'rcw_titleLabel' }, text.title),
        h('span', { className: 'rcw_titleValue' }, formatRub(cheapest?.costRub) ?? '—'),
      );

      const rule = h('div', { className: 'rcw_titleRule', key: 'rule', 'aria-hidden': true });

      const meta = h('div', { className: 'rcw_meta', key: 'meta' },
        typeof data?.modelLabel === 'string' && data.modelLabel !== ''
          ? h('span', {
            className: 'rcw_metaModel',
            title: typeof data.resolvedModel === 'string' ? data.resolvedModel : undefined,
          }, data.modelLabel)
          : null,
        usage !== null
          ? h('span', null, `${compactTokens(usage.billedInput)} ${text.input} · ${compactTokens(usage.out)} ${text.output}`)
          : null,
        usage !== null && typeof usage.hitRate === 'number'
          ? h('span', null, `cache ${Math.round(usage.hitRate * 100)}%`)
          : null,
        // Цены в строках — за миллион токенов: без этой подписи числа
        // читаются как стоимость сессии, а не тарифа.
        h('span', { className: 'rcw_hint', key: 'hint' }, text.priceHint),
      );

      const problemBox = problem !== ''
        ? h('div', { className: 'rcw_problem', key: 'problem' }, problem)
        : null;

      const rows = providers.map((row, index) => {
        const cachePrice = row?.pricesPerM?.cache ?? row?.pricesPerM?.in;
        return h('div', {
          className: 'rcw_row',
          key: `${row?.name ?? 'row'}|${row?.tag ?? ''}|${index}`,
          'data-cheapest': row?.isCheapest === true ? 'true' : 'false',
        },
          h('div', { className: 'rcw_rowHead' },
            h('span', { className: 'rcw_rowName' },
              String(row?.label ?? row?.name ?? '—'),
              row?.isCheapest === true ? h('span', { className: 'rcw_tag' }, text.cheapest) : null,
            ),
            h('span', { className: 'rcw_rowCost' }, formatRub(row?.costRub) ?? text.noPrice),
          ),
          h('div', { className: 'rcw_rowPrices' },
            h('span', null,
              `${text.input} ${formatPrice(row?.pricesPerM?.in)} · `
              + `${text.cache} ${formatPrice(cachePrice)} · `
              + `${text.output} ${formatPrice(row?.pricesPerM?.out)}`,
            ),
            h('span', { className: 'rcw_rowDelta', title: text.delta }, formatDelta(row)),
          ),
        );
      });

      const list = providers.length === 0
        ? h('div', { className: 'rcw_empty', key: 'empty' }, text.empty)
        : h('div', { className: 'rcw_list', key: 'list' }, rows);

      const hiddenNote = [];
      if (data !== null && Number.isFinite(data.hiddenCount) && data.hiddenCount > 0) {
        hiddenNote.push(text.hidden(data.hiddenCount));
      }
      if (data !== null && Number.isFinite(data.unpricedCount) && data.unpricedCount > 0) {
        hiddenNote.push(text.unpriced(data.unpricedCount));
      }

      const footer = h('div', { className: 'rcw_footer', key: 'footer' },
        h('span', { className: 'rcw_stamp', title: text.priceHint },
          `${text.updated} ${formatClock(data?.fetchedAt)}`,
          data?.stale === true ? ` · ${text.stale}` : '',
        ),
        h('span', { className: 'rcw_footerNote' }, hiddenNote.join(' · ')),
        h('button', {
          type: 'button',
          className: 'rcw_action',
          onClick: onRefresh,
          disabled: refreshing === true,
        }, refreshing === true ? text.refreshing : text.refresh),
      );

      return h('div', {
        ref: panelRef,
        className: 'rcw_panel',
        role: 'dialog',
        'aria-label': text.title,
        'data-rcw': 'panel',
        style: pos === null ? MEASURE_STYLE : { left: `${pos.left}px`, top: `${pos.top}px` },
      }, title, problemBox, rule, meta, list, footer);
    }

    /**
     * Пилюля дока: «₽X,XX · провайдер».
     *
     * Провайдер — самый дешёвый для активной модели сессии по фактическому
     * usage. Пока данных нет — многоточие; при ошибке — короткая подпись,
     * полный текст уходит в `title`. По клику открывается поповер со всеми
     * провайдерами модели.
     *
     * @param {{sessionId?: string, useProjection?: Function}} props — стандартные пропсы слота.
     * @returns {React.ReactElement | null}
     */
    function CostPill(props) {
      const { sessionId, useProjection } = props;
      const usage = typeof useProjection === 'function' ? useProjection('tokenUsage') : undefined;
      const usageKey = usageKeyOf(usage);
      const { data, error, loading, replace } = useCostState(sessionId, usageKey);
      const text = textOf(pickLocale());

      const [open, setOpen] = React.useState(false);
      const [refreshing, setRefreshing] = React.useState(false);
      const [refreshError, setRefreshError] = React.useState('');
      const anchorRef = React.useRef(null);
      const panelRef = React.useRef(null);
      // Компонент может исчезнуть (сменилась сессия, закрыт слот) до ответа
      // Host'а: запрос отменяется, а состояние после размонтирования не
      // обновляется — иначе React ругается на setState закрытой панели.
      const mountedRef = React.useRef(true);
      const refreshRef = React.useRef(undefined);
      React.useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
          refreshRef.current?.abort();
        };
      }, []);
      const close = React.useCallback(() => setOpen(false), []);
      const pos = useAnchoredPosition({
        open,
        anchorRef,
        panelRef,
        gap: PANEL_GAP,
        margin: PANEL_MARGIN,
        version: data?.fetchedAt,
      });

      useDismiss({ open, anchorRef, panelRef, onDismiss: close });

      // Другая сессия — другая таблица: старую панель закрываем.
      React.useEffect(() => {
        setOpen(false);
        setRefreshError('');
      }, [sessionId]);

      /** Ручное обновление: Host игнорирует TTL и возвращает свежие цены. */
      const onRefresh = React.useCallback(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return;
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
        let timedOut = false;
        const timer = controller === undefined
          ? undefined
          : setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, REFRESH_TIMEOUT_MS);
        refreshRef.current = controller;
        setRefreshing(true);
        setRefreshError('');
        fetchRefresh(sessionId, controller?.signal)
          .then((next) => {
            if (!mountedRef.current) return;
            replace(next);
          })
          .catch((failure) => {
            if (!mountedRef.current) return;
            if (failure instanceof Error && failure.name === 'AbortError') {
              // Таймаут показываем, размонтирование — нет: панели уже нет.
              if (timedOut) setRefreshError(text.refreshTimeout);
              return;
            }
            setRefreshError(String(failure instanceof Error ? failure.message : failure));
          })
          .finally(() => {
            if (timer !== undefined) clearTimeout(timer);
            if (refreshRef.current === controller) refreshRef.current = undefined;
            if (mountedRef.current) setRefreshing(false);
          });
      }, [sessionId, replace, text]);

      // Без сессии пилюле нечего считать: слот остаётся пустым.
      if (typeof sessionId !== 'string' || sessionId === '') return null;

      const cheapest = data !== null && data.cheapest !== null && typeof data.cheapest === 'object'
        ? data.cheapest
        : null;
      const hostError = data !== null && typeof data.error === 'string' ? data.error : '';
      const stale = data !== null && data.stale === true;

      let label;
      let state;
      if (data === null && error === '') {
        label = text.loading;
        state = 'loading';
      } else if (cheapest !== null) {
        const money = formatRub(cheapest.costRub);
        const provider = String(cheapest.label ?? cheapest.name ?? '').trim();
        label = money === null ? text.noPrice : (provider === '' ? money : `${money} · ${provider}`);
        state = error !== '' ? 'error' : (stale ? 'stale' : 'ready');
      } else if (error !== '') {
        label = text.error;
        state = 'error';
      } else {
        label = text.noPrice;
        state = hostError === '' ? 'ready' : 'error';
      }
      // `loading` без данных: подпись «…», повторно не мигаем, если данные есть.
      if (loading && data !== null) state = state === 'ready' ? 'refreshing' : state;

      // Полный текст ошибки — только в подсказке: пилюля должна остаться узкой.
      const title = error !== '' ? error : (hostError !== '' ? hostError : label);
      const cheapestLabel = cheapest === null ? '' : String(cheapest.label ?? cheapest.name ?? '');

      const panel = open
        ? ReactDOM.createPortal(
          renderPanel({
            data,
            error,
            refreshError,
            refreshing,
            pos,
            panelRef,
            text,
            onRefresh,
          }),
          document.body,
        )
        : null;

      return h('span', { className: 'rcw_anchor', 'data-rcw': 'pill-anchor', ref: anchorRef },
        h('button', {
          type: 'button',
          className: 'rcw_pill',
          'data-rcw': 'pill',
          'data-state': state,
          'data-session': sessionId,
          'data-cheapest': cheapestLabel,
          title,
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': `${text.title}: ${label}`,
          onClick: () => setOpen((value) => !value),
        }, h('span', { className: 'rcw_label' }, label)),
        panel,
      );
    }

    /**
     * Стили.
     *
     * Пилюля скопирована с нативной `usage` (`StatsPills.module.css` из
     * `dsh-client-ui-chat`), панель — с её поповера (`stat-dialog.module.css`):
     * те же размеры шрифта и строки, тот же радиус, те же токены цвета. Ни
     * одного «своего» цвета: светлая и тёмная темы работают сами.
     */
    const CSS = [
      '.rcw_anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}',
      '.rcw_pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;',
      'color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;',
      'line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;',
      'gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}',
      '.rcw_pill:hover,.rcw_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-secondary)}',
      '.rcw_label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
      '.rcw_pill[data-state=error]{color:var(--dsw-alias-state-error-primary)}',
      '.rcw_pill[data-state=stale]{opacity:.72}',
      '.rcw_pill[data-state=loading],.rcw_pill[data-state=refreshing]{color:var(--dsw-alias-label-tertiary)}',
      '.rcw_panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);',
      'background:var(--dsw-specific-menu);width:max-content;min-width:min(320px,100vw - 24px);',
      'max-width:min(460px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);',
      '--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);',
      'color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;',
      'font-size:12px;line-height:18px;position:fixed}',
      '.rcw_title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;',
      'margin-bottom:8px;font-weight:500;display:flex}',
      '.rcw_titleValue{font-variant-numeric:tabular-nums;flex:0 0 auto}',
      '.rcw_titleLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rcw_titleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
      '.rcw_meta{display:flex;flex-wrap:wrap;gap:4px 12px;margin-bottom:10px;',
      'color:var(--dsw-alias-label-tertiary)}',
      '.rcw_metaModel{color:var(--dsw-alias-label-secondary);min-width:0;max-width:100%;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rcw_hint{margin-left:auto;color:var(--dsw-alias-label-tertiary);opacity:.8}',
      '.rcw_list{max-height:min(52vh,420px);overflow:auto;margin:0 -6px;padding:0 6px}',
      '.rcw_row{padding:6px 0;border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.rcw_row:first-child{border-top:0;padding-top:0}',
      '.rcw_rowHead{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
      '.rcw_rowName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'color:var(--dsw-alias-label-secondary)}',
      '.rcw_row[data-cheapest=true] .rcw_rowName{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.rcw_tag{margin-left:6px;padding:0 5px;border-radius:999px;display:inline-block;',
      'border:1px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);',
      'font-size:10px;line-height:14px;vertical-align:1px}',
      '.rcw_rowCost{flex:0 0 auto;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.rcw_rowPrices{display:flex;align-items:baseline;justify-content:space-between;gap:12px;',
      'margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px}',
      '.rcw_rowDelta{flex:0 0 auto;font-variant-numeric:tabular-nums}',
      '.rcw_problem{margin:0 0 10px;padding:6px 9px;border-radius:6px;font-size:11px;line-height:16px;',
      'border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);',
      'overflow-wrap:anywhere}',
      '.rcw_empty{padding:2px 0;color:var(--dsw-alias-label-tertiary)}',
      '.rcw_footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px;',
      'padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l2);',
      'color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.rcw_stamp{font-variant-numeric:tabular-nums}',
      '.rcw_footerNote{flex:1 1 auto;min-width:0}',
      '.rcw_action{margin-left:auto;padding:2px 9px;border-radius:999px;font:inherit;font-size:11px;',
      'line-height:16px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);',
      'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}',
      '.rcw_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-primary)}',
      '.rcw_action:disabled{opacity:.6;cursor:default}',
    ].join('');

    return {
      inject: ['slots'],
      apply(ctx) {
        // Стили живут ровно столько, сколько живёт плагин: `ctx.effect` снимет
        // тег при выгрузке, и повторная загрузка не оставит дублей.
        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = 'routerai-cost-widget';
          style.dataset.pluginCss = 'routerai-cost-widget/pill.css';
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => {
            style.remove();
          };
        }, 'routerai-cost-widget: pill styles');

        // `inject` ждёт объявления слота: строка дока принадлежит чату, и он
        // может появиться позже нашего плагина.
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'routerai-cost',
          order: 2,
          label: () => textOf(pickLocale()).title,
        }, CostPill));
      },
    };
  },
});
