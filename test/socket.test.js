const test = require("node:test");
const assert = require("node:assert/strict");
const { createSocket } = require("../src/socket");

function harness() {
  const sockets = [];
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; this.closed = false; sockets.push(this); }
    send(d) { this.sent.push(JSON.parse(d)); }
    close() { if (this.closed) return; this.closed = true; setImmediate(() => this.onclose && this.onclose()); }
    emit(obj) { this.onmessage({ data: JSON.stringify(obj) }); }
  }
  const got = [];
  const ready = [];
  let urls = 0;
  const socket = createSocket({
    open: async () => ({ url: `wss://x/${++urls}` }),
    onMessage: (m) => got.push(m),
    onReady: (first) => ready.push(first),
    WebSocketImpl: FakeWS,
    graceMs: 5,
  });
  return { socket, sockets, got, ready };
}
const tick = () => new Promise((r) => setTimeout(r, 15));

test("acks every envelope and passes events on", async () => {
  const { socket, sockets, got, ready } = harness();
  socket.connect();
  await tick();
  sockets[0].emit({ type: "hello" });
  assert.deepEqual(ready, [true]);
  sockets[0].emit({ type: "events_api", envelope_id: "e1", payload: { event: { type: "message" } } });
  assert.deepEqual(sockets[0].sent, [{ envelope_id: "e1" }]);
  assert.equal(got.length, 1);
  socket.stop();
});

test("on Slack's refresh, the new connection is ready before the old one closes", async () => {
  const { socket, sockets, ready } = harness();
  socket.connect();
  await tick();
  sockets[0].emit({ type: "hello" });
  sockets[0].emit({ type: "disconnect", reason: "refresh_requested" });
  await tick();
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].closed, false); // still listening while the new one starts
  sockets[1].emit({ type: "hello" });
  assert.equal(socket.live, sockets[1]);
  await tick();
  assert.equal(sockets[0].closed, true);
  assert.deepEqual(ready, [true, false]);
  socket.stop();
});

test("reconnects when the live connection drops", async () => {
  const { socket, sockets } = harness();
  socket.connect();
  await tick();
  sockets[0].emit({ type: "hello" });
  sockets[0].close();
  await tick();
  assert.equal(sockets.length, 2);
  socket.stop();
});
