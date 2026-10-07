// Transcribed/synthetic, NOT captured model output. Pinned rust-v0.153.4.
// Warning text/shape comes verbatim from runtime_warning_emits_a_non_fatal_error_item.
// Other notices use collect_thread_events formatters with synthetic substitutions.
export const upstream = {
  tag: 'rust-v0.153.4',
  files: {
    'exec_events.rs':
      'c404928e0f2a463e19d1b263081c9d5e0380aec9f651a05ee0766f7bb7527f32',
    'event_processor_with_jsonl_output.rs':
      '2f71fbf8a1b0a79bd342ed3c9caa414f1c5e06d9e52d6a94461799f304a9f255',
    'event_processor_with_jsonl_output_tests.rs':
      'd022cc7cd9a778fbff6d6beb68fa467269a639f6d4ecf87d745af91a78218f73',
  },
};
export const errorItem = (message = 'invalid global instructions') => ({
  type: 'item.completed',
  item: { id: 'item_0', type: 'error', message },
});
export const noticeCases = [
  [
    'warning',
    'invalid global instructions',
    'CODEX_SAFE_PROFILE_UNVERIFIED',
    'NOTICE_CONFIG',
    'config',
  ],
  [
    'config',
    'Unknown config option (SYNTHETIC_SECRET_CONFIG)',
    'CODEX_SAFE_PROFILE_UNVERIFIED',
    'NOTICE_CONFIG',
    'config',
  ],
  [
    'reroute',
    'model rerouted: synthetic-a -> synthetic-b (RateLimit)',
    'CODEX_MODEL_CAPABILITY_MISMATCH',
    'MODEL_REROUTED',
    'config',
  ],
  [
    'auth',
    'authentication failed SYNTHETIC_SECRET_AUTH',
    'CODEX_LOGIN_REQUIRED',
    'NOTICE_AUTH',
    'auth',
  ],
  [
    'quota',
    'usage limit reached SYNTHETIC_SECRET_QUOTA',
    'CODEX_QUOTA',
    'NOTICE_QUOTA',
    'quota',
  ],
  // exec/src/lib.rs::lagged_event_warning_message, with synthetic skipped=2.
  [
    'lost',
    'in-process app-server event stream lagged; dropped 2 events',
    'CODEX_PROCESS_FAILED',
    'EVENTS_LOST',
    'protocol',
  ],
  [
    'deprecation',
    'Synthetic deprecated feature (SYNTHETIC_SECRET_DETAIL)',
    'CODEX_PROCESS_FAILED',
    'NOTICE_UNKNOWN',
    'unclassified',
  ],
  [
    'unknown',
    'SYNTHETIC_SECRET_UNKNOWN \u041f\u0440\u0438\u0432\u0435\u0442',
    'CODEX_PROCESS_FAILED',
    'NOTICE_UNKNOWN',
    'unclassified',
  ],
];
export const forbiddenItems = [
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'collab_tool_call',
  'web_search',
  'todo_list',
];
