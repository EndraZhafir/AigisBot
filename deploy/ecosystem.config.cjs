// PM2 Ecosystem Config for Galaxy A54 MiniServer (Termux) or bare-metal Linux (Node 22+)
module.exports = {
  apps: [
    {
      name: 'aigis-api',
      script: 'dist/index.js',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1, // CRITICAL: Single-session rule for Baileys auth_info/
      autorestart: true,
      max_restarts: 10,
      min_uptime: '15s',
      restart_delay: 3000,
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Jakarta',
      },
    },
  ],
};
