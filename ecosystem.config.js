module.exports = {
  apps: [{
    name: 'applyapply',
    script: './server/server.js',
    cwd: '/Users/chaztyler/job-search',
    instances: 1,          // SQLite can't be safely shared across processes
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      PORT: 5000,
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
  }],
};
