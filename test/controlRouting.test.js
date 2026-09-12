import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function createHarness(currentWindowTabs) {
  const deliveries = [];
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
        onMessage: event(),
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
        query(_query, callback) {
          if (callback) callback(currentWindowTabs);
          return Promise.resolve(currentWindowTabs);
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
  return { notify: context.notifyAllTabs, deliveries };
}

test("delivers targeted controls to a tab outside the current window", async () => {
  const harness = await createHarness([{ id: 8, windowId: 2 }]);
  await harness.notify("simulate-message", {
    connectionId: "connection-7",
    message: "client-ping",
    direction: "outgoing",
  }, 7);

  assert.deepEqual(JSON.parse(JSON.stringify(harness.deliveries)), [{
    tabId: 7,
    message: {
      type: "simulate-message",
      connectionId: "connection-7",
      message: "client-ping",
      direction: "outgoing",
    },
  }]);
});

test("keeps untargeted controls limited to tabs in the current window", async () => {
  const harness = await createHarness([{ id: 8, windowId: 2 }, { id: 9, windowId: 2 }]);
  await harness.notify("block-outgoing", { enabled: true });

  assert.deepEqual(JSON.parse(JSON.stringify(harness.deliveries)), [
    { tabId: 8, message: { type: "block-outgoing", enabled: true } },
    { tabId: 9, message: { type: "block-outgoing", enabled: true } },
  ]);
});
