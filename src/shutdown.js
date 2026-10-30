'use strict';
// Stop accepting HTTP on SIGTERM/SIGINT, then exit after the open requests finish.
function attachShutdown(server, log = () => {}, exit = process.exit) {
  let shutting = false;
  const shutdown = (signal) => {
    if (shutting) return;
    shutting = true;
    log('server.shutdown', { signal });
    const timer = setTimeout(() => exit(0), 10000);
    timer.unref?.();
    server.close(() => { clearTimeout(timer); exit(0); });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return shutdown;
}

module.exports = { attachShutdown };
