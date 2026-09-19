import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.readyState = FakeWebSocket.OPEN;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener() {}

  send() {}

  close() {}

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener.call(this, event);
    }
  }
}

async function loadInjectedScript() {
  const injectedSource = await readFile(
    new URL("../src/content/injected.js", import.meta.url),
    "utf8",
  );
  const postedMessages = [];
  const pendingTimers = [];
  const fakeWindow = {
    WebSocket: FakeWebSocket,
    location: { href: "https://example.com/app" },
    addEventListener() {},
    postMessage(message) {
      postedMessages.push(message);
    },
  };
  fakeWindow.top = fakeWindow;

  const context = vm.createContext({
    ArrayBuffer,
    Blob,
    Date,
    JSON,
    Map,
    Math,
    TextDecoder,
    URL,
    Uint8Array,
    atob,
    btoa,
    clearInterval() {},
    clearTimeout() {},
    console,
    history: { pushState() {}, replaceState() {} },
    queueMicrotask(callback) {
      callback();
    },
    setInterval() {
      return 1;
    },
    setTimeout(callback) {
      pendingTimers.push(callback);
      return pendingTimers.length;
    },
    window: fakeWindow,
  });

  vm.runInContext(injectedSource, context);

  const flushTimers = () => {
    while (pendingTimers.length > 0) {
      const callback = pendingTimers.shift();
      callback();
    }
  };

  return { fakeWindow, postedMessages, flushTimers };
}

function wrapInLengthDelimitedField(payload) {
  const lengthBytes = [];
  let remaining = payload.length;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) byte |= 0x80;
    lengthBytes.push(byte);
  } while (remaining > 0);

  const wrapped = new Uint8Array(1 + lengthBytes.length + payload.length);
  wrapped[0] = 0x0a;
  wrapped.set(lengthBytes, 1);
  wrapped.set(payload, 1 + lengthBytes.length);
  return wrapped;
}

function buildNestedPayload(levels, leaf = new Uint8Array([0x08, 0x01])) {
  let payload = leaf;
  for (let index = 0; index < levels; index += 1) {
    payload = wrapInLengthDelimitedField(payload);
  }
  return payload;
}

function decodeDepth(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;

  return Object.values(value).reduce((deepest, child) => {
    return Math.max(deepest, decodeDepth(child));
  }, 0) + 1;
}

function emitBinaryMessage(fakeWindow, bytes) {
  const socket = new fakeWindow.WebSocket("wss://example.com/socket");
  socket.emit("open", {});
  const startedAt = Date.now();
  socket.emit("message", { data: bytes.buffer });
  return Date.now() - startedAt;
}

function readCapturedEvent(postedMessages, flushTimers) {
  flushTimers();
  const batch = postedMessages.find(
    (message) => message.type === "websocket-event-batch",
  );
  assert.ok(batch, "expected the injected script to report a captured batch");

  const event = batch.payload.find((item) => item.type === "message" && item.isProtobuf);
  assert.ok(event, "expected a decoded protobuf event");
  return event;
}

test("keeps nested protobuf decoding up to a bounded depth", async () => {
  const { fakeWindow, postedMessages, flushTimers } = await loadInjectedScript();

  // A deeply nested payload is what unbounded schema-less decoding used to
  // follow all the way down, which blocked the page on binary audio traffic.
  const payload = buildNestedPayload(2000);
  emitBinaryMessage(fakeWindow, payload);
  const event = readCapturedEvent(postedMessages, flushTimers);

  const decoded = JSON.parse(event.protobufDecoded);
  const depth = decodeDepth(decoded);

  assert.ok(depth > 1, "expected at least one level of nested decoding");
  assert.ok(depth <= 6, `expected decode depth to stay bounded, got ${depth}`);
});

test("decodes a large binary payload without stalling", async () => {
  const { fakeWindow, postedMessages, flushTimers } = await loadInjectedScript();

  const payload = new Uint8Array(100 * 1024);
  let seed = 123456789;
  for (let index = 0; index < payload.length; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    payload[index] = seed & 0xff;
  }

  const elapsedMs = emitBinaryMessage(fakeWindow, payload);
  const event = readCapturedEvent(postedMessages, flushTimers);

  assert.equal(typeof event.protobufDecoded, "string");
  assert.ok(
    elapsedMs < 250,
    `expected a 100KB binary payload to decode quickly, took ${elapsedMs}ms`,
  );
});

test("still surfaces nested messages for small protobuf payloads", async () => {
  const { fakeWindow, postedMessages, flushTimers } = await loadInjectedScript();

  // { field_1: { field_2: 7 } }
  const inner = new Uint8Array([0x10, 0x07]);
  emitBinaryMessage(fakeWindow, wrapInLengthDelimitedField(inner));
  const event = readCapturedEvent(postedMessages, flushTimers);

  const decoded = JSON.parse(event.protobufDecoded);
  assert.equal(decoded.field_1.field_2, 7);
});
