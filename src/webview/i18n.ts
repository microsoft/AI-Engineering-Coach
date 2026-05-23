/*---------------------------------------------------------------------------------------------
 *  UI strings — English / Russian (sidebar, dashboard shell, commands).
 *--------------------------------------------------------------------------------------------*/

export type Locale = 'en' | 'ru';

const MESSAGES = {
  en: {
    'nav.observe': 'Observe',
    'nav.measure': 'Measure',
    'nav.improve': 'Improve',
    'nav.levelUp': 'Level Up',
    'nav.dashboard': 'Dashboard',
    'nav.timeline': 'Timeline',
    'nav.codingMoments': 'Coding Moments',
    'nav.output': 'Output',
    'nav.burndown': 'Burndown',
    'nav.patterns': 'Patterns',
    'nav.antiPatterns': 'Anti-Patterns',
    'nav.skillFinder': 'Skill Finder',
    'nav.contextHealth': 'Context Health',
    'nav.levelUpPage': 'Level Up',
    'filter.workspace': 'Workspace',
    'filter.current': 'Current',
    'filter.all': 'All',
    'filter.searchWs': 'Search workspaces...',
    'filter.harness': 'Harness',
    'filter.allHarnesses': 'All Harnesses',
    'sidebar.title': 'AI Engineer Coach',
    'sidebar.noData': 'No data yet — sync your sessions to get started.',
    'sidebar.harnesses': 'Detected harnesses',
    'sidebar.lastSync': 'Last synced',
    'sidebar.explore': 'Explore AI Insights',
    'sidebar.sync': 'Sync Sessions',
    'dash.calibrating': 'Calibrating the dashboard vibes...',
    'dash.vibes': 'Dashboard vibes sampled across {n} dimensions',
    'dash.requests': 'Requests',
    'dash.sessions': 'Sessions',
    'dash.loc': 'AI LoC',
    'dash.workspaces': 'Workspaces',
    'dash.tokenHidden': 'Token Usage & Burndown temporarily hidden',
    'dash.tokenHiddenDesc':
      'These features are disabled until we can verify that reported numbers align with GitHub billing data.',
    'dash.apSummary': 'Anti-Patterns Summary',
    'dash.viewAllAp': 'View All Anti-Patterns →',
    'dash.skillFinder': 'Skill Finder',
    'dash.openSkills': 'Open Full View →',
    'dash.skillDesc':
      'Scans your prompt history for repeated patterns that waste time re-explaining the same tasks.',
    'dash.skillAnalyze': 'Analyze your prompt history to discover skill opportunities.',
    'dash.scanSkills': 'Scan for Skills',
    'dash.dailyActivity': 'Daily Activity',
    'dash.topWs': 'Top Workspaces by Requests',
    'dash.byHarness': 'Requests by Harness',
    'dash.close': 'Close',
    'score.mergeWizard': 'Merge Wizard',
    'score.shipGoblin': 'Ship Goblin Deluxe',
    'score.vibeGremlin': 'Vibe Refactor Gremlin',
    'score.rubberDuck': 'Rubber Duck Ringleader',
    'score.stackTrace': 'Stack Trace Survivor',
    'langBanner':
      'Main menu is in Russian. Some inner pages are still in English — we are translating them gradually.',
  },
  ru: {
    'nav.observe': 'Наблюдение',
    'nav.measure': 'Метрики',
    'nav.improve': 'Улучшение',
    'nav.levelUp': 'Развитие',
    'nav.dashboard': 'Обзор',
    'nav.timeline': 'Таймлайн',
    'nav.codingMoments': 'Моменты кода',
    'nav.output': 'Выработка',
    'nav.burndown': 'Расход токенов',
    'nav.patterns': 'Паттерны',
    'nav.antiPatterns': 'Антипаттерны',
    'nav.skillFinder': 'Поиск навыков',
    'nav.contextHealth': 'Контекст',
    'nav.levelUpPage': 'Обучение',
    'filter.workspace': 'Проект',
    'filter.current': 'Текущий',
    'filter.all': 'Все',
    'filter.searchWs': 'Поиск проектов...',
    'filter.harness': 'Среда ИИ',
    'filter.allHarnesses': 'Все среды',
    'sidebar.title': 'AI Engineer Coach',
    'sidebar.noData': 'Пока нет данных — синхронизируйте сессии.',
    'sidebar.harnesses': 'Обнаруженные среды',
    'sidebar.lastSync': 'Обновлено',
    'sidebar.explore': 'Открыть аналитику',
    'sidebar.sync': 'Синхронизировать',
    'dash.calibrating': 'Считаем сводку…',
    'dash.vibes': 'Сводка по {n} направлениям',
    'dash.requests': 'Запросы',
    'dash.sessions': 'Сессии',
    'dash.loc': 'Строк ИИ',
    'dash.workspaces': 'Проекты',
    'dash.tokenHidden': 'Токены и Burndown временно скрыты',
    'dash.tokenHiddenDesc':
      'Раздел отключён, пока не сверим цифры с биллингом GitHub.',
    'dash.apSummary': 'Сводка антипаттернов',
    'dash.viewAllAp': 'Все антипаттерны →',
    'dash.skillFinder': 'Поиск навыков',
    'dash.openSkills': 'Полный вид →',
    'dash.skillDesc':
      'Ищет повторяющиеся промпты, чтобы оформить их в навыки и не объяснять одно и то же.',
    'dash.skillAnalyze': 'Проанализируйте историю промптов и найдите полезные навыки.',
    'dash.scanSkills': 'Сканировать навыки',
    'dash.dailyActivity': 'Активность по дням',
    'dash.topWs': 'Топ проектов по запросам',
    'dash.byHarness': 'Запросы по среде ИИ',
    'dash.close': 'Закрыть',
    'score.mergeWizard': 'Мастер слияний',
    'score.shipGoblin': 'Гоблин релизов',
    'score.vibeGremlin': 'Гремлин рефакторинга',
    'score.rubberDuck': 'Утконаводитель',
    'score.stackTrace': 'Выживший в стектрейсе',
    'langBanner':
      'Меню на русском. Часть внутренних страниц пока на английском — перевод добавляется постепенно.',
  },
} as const;

export type MessageKey = keyof typeof MESSAGES.en;

let activeLocale: Locale = 'en';

export function resolveLocale(vscodeLanguage: string): Locale {
  const lang = (vscodeLanguage || 'en').toLowerCase();
  return lang.startsWith('ru') ? 'ru' : 'en';
}

export function setActiveLocale(locale: Locale): void {
  activeLocale = locale;
}

export function getActiveLocale(): Locale {
  return activeLocale;
}

export function setLocaleFromDocument(): void {
  const lang = document.documentElement.getAttribute('lang') || 'en';
  activeLocale = resolveLocale(lang);
}

export function t(key: MessageKey, locale?: Locale): string {
  const loc = locale ?? activeLocale;
  return MESSAGES[loc][key] ?? MESSAGES.en[key];
}

export function tFormat(key: MessageKey, vars: Record<string, string | number>, locale?: Locale): string {
  let s = t(key, locale);
  for (const [k, v] of Object.entries(vars)) {
    s = s.replace(`{${k}}`, String(v));
  }
  return s;
}

export function funScoreLabel(score: number, locale?: Locale): string {
  if (score >= 90) return t('score.mergeWizard', locale);
  if (score >= 75) return t('score.shipGoblin', locale);
  if (score >= 60) return t('score.vibeGremlin', locale);
  if (score >= 40) return t('score.rubberDuck', locale);
  return t('score.stackTrace', locale);
}
