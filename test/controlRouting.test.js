import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function createHarness(tabs, currentWindowId = 2) {
  const deliveries = [];
  let messageListener;
  const event = () => ({ addListener() {} });
  const context = vm.createContext({
    URL,
    console,
    clearInterval() {},
    setInterval() { return 1; },
    chrome: {
      runtime: {
        onConnect: event(),
        onInstalled: event(),
        onMessage: { addListener(listener) { messageListener = listener; } },
        onStartup: event(),
        onSuspend: event(),
        onUpdateAvailable: event(),
      },
      storage: {
        local: {
          get(_keys, callback) { callback({}); },
          set() {},
        },
      },
      tabs: {
        onRemoved: event(),
        onUpdated: event(),
        query(query, callback) {
          const matchingTabs = query.currentWindow
            ? tabs.filter(tab => tab.windowId === currentWindowId)
            : tabs;
          if (callback) callback(matchingTabs);
          return Promise.resolve(matchingTabs);
        },
        sendMessage(tabId, message) {
          deliveries.push({ tabId, message });
          return Promise.resolve({});
        },
      },
    },
  });
  vm.runInContext(
    await readFile(new URL("../src/background/background.js", import.meta.url), "utf8"),
    context,
  );
  return {
    deliveries,
    async send(message) {
      messageListener(message, {}, () => {});
      await new Promise(setImmediate);
    },
  };
}

test("delivers targeted controls to a tab outside the current window", async () => {
  const harness = await createHarness([{ id: 7, windowId: 1 }, { id: 8, windowId: 2 }]);
  await harness.send({ type: "simulate-message", data: {
    tabId: 7,
    connectionId: "connection-7",
    message: "client-ping",
    direction: "outgoing",
  } });

  assert.deepEqual(JSON.parse(JSON.stringify(harness.deliveries)), [{
    tabId: 7,
    message: {
      type: "simulate-message",
      tabId: 7,
      connectionId: "connection-7",
      message: "client-ping",
      direction: "outgoing",
    },
  }]);
});

test("keeps untargeted controls limited to tabs in the current window", async () => {
  const harness = await createHarness([
    { id: 7, windowId: 1 }, { id: 8, windowId: 2 }, { id: 9, windowId: 2 },
  ]);
  await harness.send({ type: "simulate-message", data: { message: "broadcast-ping" } });

  assert.deepEqual(JSON.parse(JSON.stringify(harness.deliveries)), [
    { tabId: 8, message: { type: "simulate-message", message: "broadcast-ping" } },
    { tabId: 9, message: { type: "simulate-message", message: "broadcast-ping" } },
  ]);
});
