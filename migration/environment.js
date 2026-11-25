// PM2 会把应用配置和进程状态平铺到环境变量；不能让这些字段成为新应用的配置。
const pm2Fields = new Set(`script name name_prefix filter_env namespace install_url cwd args exec_interpreter node_args
out_file error_file log_file disable_logs log_type log_date_format time env max_memory_restart pid_file restart_delay
exp_backoff_restart_delay source_map_support disable_source_map_support wait_ready instances kill_timeout
shutdown_with_message listen_timeout cron_restart merge_logs vizion autorestart stop_exit_codes watch_delay watch
ignore_watch watch_options min_uptime max_restarts execute_command exec_mode force append_env_to_name post_update
trace disable_trace v8 event_loop_inspector deep_monitoring increment_var instance_var pmx automation treekill port
username uid gid windowsHide kill_retry_time write io autostart created_at exit_code km_link node_version
prev_restart_delay restart_time status unique_id unstable_restarts version vizion_running NODE_APP_INSTANCE
NODE_OPTIONS NODE_CHANNEL_FD NODE_CHANNEL_SERIALIZATION_MODE NODE_UNIQUE_ID`.split(/\s+/u));

export function migrationEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !pm2Fields.has(key) &&
    !/^(?:PM2_|PMX_|pm_|axm_|env_|LOTUS_)/u.test(key)));
}
