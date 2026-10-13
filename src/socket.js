// Socket Mode connection that never gives up. A replacement connection is opened BEFORE the old one is closed
// (on Slack's routine refreshes and on the watchdog), so there is no gap in which a lead could be missed.
function createSocket({
  open, // async () => ({ url })
  onMessage,
  onReady = () => {},
  log = () => {},
  WebSocketImpl = globalThis.WebSocket,
  staleMs = 180000, // nothing heard for this long: the connection may be dead without saying so
  helloTimeoutMs = 15000,
  graceMs = 2000, // the old connection stays up this long after the new one is ready
}) {
  let live = null; // the connection events are expected on
  let pending = null; // a replacement that hasn't said hello yet
  let backoff = 1000;
  let retryTimer = null;
  let watchdog = null;
  let lastHeard = Date.now();
  let readyCount = 0;
  let stopped = false;

  function retryLater() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, backoff);
    backoff = Math.min(backoff * 2, 30000);
  }

  async function connect() {
    if (stopped || pending) return;
    const attempt = { sock: null, timer: null };
    pending = attempt;
    const fail = (why) => {
      if (pending !== attempt) return;
      pending = null;
      clearTimeout(attempt.timer);
      try { attempt.sock && attempt.sock.close(); } catch {}
      log("Connect failed:", why);
      retryLater();
    };

    let url;
    try {
      ({ url } = await open());
    } catch (e) {
      return fail(e.message);
    }
    if (pending !== attempt || stopped) return;
    let sock;
    try {
      sock = new WebSocketImpl(url);
    } catch (e) {
      return fail(e.message);
    }
    attempt.sock = sock;
    attempt.timer = setTimeout(() => fail("Slack did not say hello in time"), helloTimeoutMs);

    sock.onmessage = (m) => {
      let msg;
      try {
        msg = JSON.parse(m.data);
      } catch {
        return;
      }
      if (msg.envelope_id) {
        try { sock.send(JSON.stringify({ envelope_id: msg.envelope_id })); } catch {} // ack immediately
      }
      if (sock === live) lastHeard = Date.now();
      if (msg.type === "hello") return promote(attempt);
      if (msg.type === "disconnect") {
        log(`Slack asked for a fresh connection (${msg.reason || "no reason given"}).`);
        if (sock === live) connect(); // this one stays up until the new one is ready
        return;
      }
      try {
        onMessage(msg);
      } catch (e) {
        log("message error:", e.message);
      }
    };
    sock.onclose = () => {
      if (pending === attempt) return fail("closed before Slack said hello");
      if (sock !== live) return; // an old connection we retired on purpose
      live = null;
      log("Disconnected, reconnecting...");
      connect();
    };
    sock.onerror = (e) => log("WebSocket error:", (e && e.message) || "unknown");
  }

  function promote(attempt) {
    if (pending !== attempt) return;
    pending = null;
    clearTimeout(attempt.timer);
    const old = live;
    live = attempt.sock;
    lastHeard = Date.now();
    backoff = 1000;
    if (old) setTimeout(() => { try { old.close(); } catch {} }, graceMs); // let anything already sent on it arrive
    log("Connected.");
    onReady(readyCount++ === 0);
  }

  function check() {
    if (stopped || pending || retryTimer) return;
    if (!live) return connect();
    if (Date.now() - lastHeard > staleMs) {
      log(`Nothing heard for ${Math.round(staleMs / 60000)} minutes, opening a fresh connection...`);
      connect();
    }
  }

  function start(checkEveryMs = 30000) {
    stopped = false;
    connect();
    watchdog = setInterval(check, checkEveryMs);
  }

  function stop() {
    stopped = true;
    clearInterval(watchdog);
    clearTimeout(retryTimer);
    for (const s of [live, pending && pending.sock]) try { s && s.close(); } catch {}
    live = pending = null;
  }

  return { start, stop, connect, check, get live() { return live; } };
}

module.exports = { createSocket };
