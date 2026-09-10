export const designMessages: Record<string, string> = {
  CODEX_NOT_AVAILABLE: 'Codex не найден на выбранном устройстве',
  CODEX_UNSUPPORTED_VERSION: 'Версия Codex или адаптера несовместима',
  CODEX_LOGIN_REQUIRED: 'Нужен локальный вход в официальный Codex',
  CODEX_AUTH_UNSUPPORTED: 'Нужен вход через ChatGPT; API key не используется',
  CODEX_SAFE_PROFILE_UNVERIFIED:
    'Запуск заблокирован: прежний профиль безопасности не подтверждён',
  CODEX_ISOLATION_UNVERIFIED:
    'Запуск заблокирован: изоляция файлов и сети не подтверждена',
  CODEX_MODEL_NOT_AVAILABLE:
    'GPT-6 Astra недоступна текущему ChatGPT-входу; замены модели нет',
  CODEX_MODEL_QUERY_FAILED: 'Не удалось проверить доступность GPT-6 Astra',
  CODEX_MODEL_CAPABILITY_MISMATCH:
    'GPT-6 Astra не поддерживает закреплённый quality-профиль ultra',
  CODEX_QUOTA: 'Лимит Codex исчерпан; автоматического повтора не будет',
  CODEX_TIMEOUT: 'Время запроса истекло; автоматического повтора не будет',
  CODEX_INVALID_OUTPUT: 'Ответ не соответствует безопасному формату концепций',
  CODEX_OUTPUT_LIMIT: 'Ответ превышает допустимый размер',
  CODEX_PROCESS_FAILED: 'Процесс Codex завершился с ошибкой',
  INVOCATION_UNCERTAIN:
    'Результат неизвестен. Проверьте историю до нового запроса',
  INVOCATION_REPLY_UNAVAILABLE:
    'Подтверждение запуска потеряно. Второй вызов не разрешён',
  STOP_UNCONFIRMED: 'Остановка не подтверждена',
  DESIGN_BRIEF_INCOMPLETE:
    'Заполните и сохраните нишу, тип бизнеса и тип сайта',
  TEST_PROVIDER_DISABLED: 'Тестовый провайдер недоступен в обычном режиме',
};
