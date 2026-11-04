'use strict';
// Graceful drain on SIGTERM/SIGINT: stop taking new HTTP connections and new calls, then wait for
// live calls to end before exiting. Exits early once there are no calls and the server has closed
// (or 10 s have passed with no calls, for stuck keep-alive sockets); hard cap PA_DRAIN_MAX_MS.
// attachShutdown(server, log, exit) still works (old signature).
const DEFAULT_DRAIN_MS = 280000;
const IDLE_GRACE_MS = 10000;

function attachShutdown(server, opts = {}, legacyExit) {
  if (typeof opts === 'function') opts = { log: opts, exit: legacyExit };
  const log = opts.log || (() => {});
  const exit = opts.exit || process.exit;
  const activeCalls = opts.activeCalls || (() => 0);
  const onDrain = opts.onDrain || (() => {});
  const envMs = Number(process.env.PA_DRAIN_MAX_MS);
  const drainMs = opts.drainMs != null ? opts.drainMs : (envMs > 0 ? envMs : DEFAULT_DRAIN_MS);
  const pollMs = opts.pollMs || 1000;
  const now = opts.now || Date.now;
  const setI = opts.setInterval || setInterval;
  const clearI = opts.clearInterval || clearInterval;
  const signals = opts.signals === false ? null : process;
  let shutting = false, closed = false, done = false, timer = null, started = 0;

  const finish = (reason) => {
    if (done) return;
    done = true;
    if (timer) clearI(timer);
    log('server.drain', { phase: 'exit', reason, active_calls: activeCalls(), waited_ms: now() - started });
    exit(0);
  };
  const check = () => {
    const n = activeCalls();
    const waited = now() - started;
    if (n === 0 && (closed || waited >= IDLE_GRACE_MS)) return finish('idle');
    if (waited >= drainMs) return finish('cap');
    try { server.closeIdleConnections?.(); } catch {}
  };
  const shutdown = (signal) => {
    if (shutting) return;
    shutting = true;
    started = now();
    try { onDrain(); } catch (e) { log('server.drain_error', { err: e.message }); }
    log('server.shutdown', { signal });
    log('server.drain', { phase: 'start', active_calls: activeCalls(), max_ms: drainMs });
    server.close(() => { closed = true; check(); });
    if (!done) {
      check();
      if (!done) { timer = setI(check, pollMs); timer.unref?.(); }
    }
  };
  if (signals) {
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }
  shutdown.isDraining = () => shutting;
  return shutdown;
}

module.exports = { attachShutdown, DEFAULT_DRAIN_MS };
