import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/googlechat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../../src/plugins/registry.js";
import { setActivePluginRegistry } from "../../../src/plugins/runtime.js";
import { createMockServerResponse } from "../../test-utils/mock-http-response.js";
import { createPluginRuntimeMock } from "../../test-utils/plugin-runtime-mock.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { verifyGoogleChatRequest } from "./auth.js";
import { handleGoogleChatWebhookRequest, registerGoogleChatWebhookTarget } from "./monitor.js";

vi.mock("./auth.js", () => ({
  verifyGoogleChatRequest: vi.fn(),
}));

vi.mock("./api.js", () => ({
  downloadGoogleChatMedia: vi.fn(),
  deleteGoogleChatMessage: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
  updateGoogleChatMessage: vi.fn(),
}));

function createWebhookRequest(params: {
  authorization?: string;
  payload: unknown;
  path?: string;
}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & {
    destroyed?: boolean;
    destroy: (error?: Error) => IncomingMessage;
    on: (event: string, listener: (...args: unknown[]) => void) => IncomingMessage;
  };
  req.method = "POST";
  req.url = params.path ?? "/googlechat";
  req.headers = {
    authorization: params.authorization ?? "",
    "content-type": "application/json",
  };
  req.destroyed = false;
  (req as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: "127.0.0.1",
  };
  req.destroy = () => {
    req.destroyed = true;
    return req;
  };

  const originalOn = req.on.bind(req);
  let bodyScheduled = false;
  req.on = ((event: string, listener: (...args: unknown[]) => void) => {
    const result = originalOn(event, listener);
    if (!bodyScheduled && event === "data") {
      bodyScheduled = true;
      void Promise.resolve().then(() => {
        req.emit("data", Buffer.from(JSON.stringify(params.payload), "utf-8"));
        if (!req.destroyed) {
          req.emit("end");
        }
      });
    }
    return result;
  }) as IncomingMessage["on"];

  return req;
}

function createHeaderOnlyWebhookRequest(params: {
  authorization?: string;
  path?: string;
}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = "POST";
  req.url = params.path ?? "/googlechat";
  req.headers = {
    authorization: params.authorization ?? "",
    "content-type": "application/json",
  };
  (req as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: "127.0.0.1",
  };
  return req;
}

const baseAccount = (accountId: string) =>
  ({
    accountId,
    enabled: true,
    credentialSource: "none",
    config: {},
  }) as ResolvedGoogleChatAccount;

function registerTwoTargets() {
  const sinkA = vi.fn();
  const sinkB = vi.fn();
  const core = {} as PluginRuntime;
  const config = {} as OpenClawConfig;

  const unregisterA = registerGoogleChatWebhookTarget({
    account: baseAccount("A"),
    config,
    runtime: {},
    core,
    path: "/googlechat",
    statusSink: sinkA,
    mediaMaxMb: 5,
  });
  const unregisterB = registerGoogleChatWebhookTarget({
    account: baseAccount("B"),
    config,
    runtime: {},
    core,
    path: "/googlechat",
    statusSink: sinkB,
    mediaMaxMb: 5,
  });

  return {
    sinkA,
    sinkB,
    unregister: () => {
      unregisterA();
      unregisterB();
    },
  };
}

async function dispatchWebhookRequest(req: IncomingMessage) {
  const res = createMockServerResponse();
  const handled = await handleGoogleChatWebhookRequest(req, res);
  expect(handled).toBe(true);
  return res;
}

async function flushAsync() {
  for (let i = 0; i < 3; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function expectVerifiedRoute(params: {
  request: IncomingMessage;
  expectedStatus: number;
  sinkA: ReturnType<typeof vi.fn>;
  sinkB: ReturnType<typeof vi.fn>;
  expectedSink: "none" | "A" | "B";
}) {
  const res = await dispatchWebhookRequest(params.request);
  expect(res.statusCode).toBe(params.expectedStatus);
  const expectedCounts =
    params.expectedSink === "A" ? [1, 0] : params.expectedSink === "B" ? [0, 1] : [0, 0];
  expect(params.sinkA).toHaveBeenCalledTimes(expectedCounts[0]);
  expect(params.sinkB).toHaveBeenCalledTimes(expectedCounts[1]);
}

function mockSecondVerifierSuccess() {
  vi.mocked(verifyGoogleChatRequest)
    .mockResolvedValueOnce({ ok: false, reason: "invalid" })
    .mockResolvedValueOnce({ ok: true });
}

function createRoutingHarness() {
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async () => ({
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  }));
  const recordSessionMetaFromInbound = vi.fn().mockResolvedValue(undefined);
  const runtimeLog = vi.fn();
  const runtimeError = vi.fn();
  const core = createPluginRuntimeMock({
    channel: {
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "main",
          accountId: "default",
          sessionKey: "agent:main:googlechat:group:spaces/AAA",
          mainSessionKey: "agent:main:main",
          matchedBy: "default",
        })),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher:
          dispatchReplyWithBufferedBlockDispatcher as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"],
      },
      session: {
        recordSessionMetaFromInbound:
          recordSessionMetaFromInbound as unknown as PluginRuntime["channel"]["session"]["recordSessionMetaFromInbound"],
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => false),
        shouldHandleTextCommands: vi.fn(() => true),
        isControlCommandMessage: vi.fn(() => false),
      },
    },
    logging: {
      shouldLogVerbose: vi.fn(() => true),
    },
  });

  return {
    core,
    runtime: {
      log: runtimeLog,
      error: runtimeError,
    },
    dispatchReplyWithBufferedBlockDispatcher,
    recordSessionMetaFromInbound,
    runtimeLog,
  };
}

function createMessageEvent(params: { threadKey: string; messageName?: string }) {
  return {
    type: "MESSAGE",
    eventTime: "2026-03-18T00:00:00.000Z",
    space: {
      name: "spaces/AAA",
      type: "SPACE",
      displayName: "Alpha Room",
    },
    message: {
      name: params.messageName ?? `spaces/AAA/messages/${params.threadKey}`,
      text: `hello from ${params.threadKey}`,
      thread: {
        threadKey: params.threadKey,
      },
      sender: {
        name: "users/12345",
        displayName: "Test User",
        email: "test@example.com",
        type: "HUMAN",
      },
    },
  };
}

describe("Google Chat webhook routing", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("registers and unregisters plugin HTTP route at path boundaries", () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    const unregisterA = registerGoogleChatWebhookTarget({
      account: baseAccount("A"),
      config: {} as OpenClawConfig,
      runtime: {},
      core: {} as PluginRuntime,
      path: "/googlechat",
      statusSink: vi.fn(),
      mediaMaxMb: 5,
    });
    const unregisterB = registerGoogleChatWebhookTarget({
      account: baseAccount("B"),
      config: {} as OpenClawConfig,
      runtime: {},
      core: {} as PluginRuntime,
      path: "/googlechat",
      statusSink: vi.fn(),
      mediaMaxMb: 5,
    });

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]).toEqual(
      expect.objectContaining({
        pluginId: "googlechat",
        path: "/googlechat",
        source: "googlechat-webhook",
      }),
    );

    unregisterA();
    expect(registry.httpRoutes).toHaveLength(1);
    unregisterB();
    expect(registry.httpRoutes).toHaveLength(0);
  });

  it("rejects ambiguous routing when multiple targets on the same path verify successfully", async () => {
    vi.mocked(verifyGoogleChatRequest).mockResolvedValue({ ok: true });

    const { sinkA, sinkB, unregister } = registerTwoTargets();

    try {
      await expectVerifiedRoute({
        request: createWebhookRequest({
          authorization: "Bearer test-token",
          payload: { type: "ADDED_TO_SPACE", space: { name: "spaces/AAA" } },
        }),
        expectedStatus: 401,
        sinkA,
        sinkB,
        expectedSink: "none",
      });
    } finally {
      unregister();
    }
  });

  it("routes to the single verified target when earlier targets fail verification", async () => {
    mockSecondVerifierSuccess();

    const { sinkA, sinkB, unregister } = registerTwoTargets();

    try {
      await expectVerifiedRoute({
        request: createWebhookRequest({
          authorization: "Bearer test-token",
          payload: { type: "ADDED_TO_SPACE", space: { name: "spaces/BBB" } },
        }),
        expectedStatus: 200,
        sinkA,
        sinkB,
        expectedSink: "B",
      });
    } finally {
      unregister();
    }
  });

  it("rejects invalid bearer before attempting to read the body", async () => {
    vi.mocked(verifyGoogleChatRequest).mockResolvedValue({ ok: false, reason: "invalid" });
    const { unregister } = registerTwoTargets();

    try {
      const req = createHeaderOnlyWebhookRequest({
        authorization: "Bearer invalid-token",
      });
      const onSpy = vi.spyOn(req, "on");
      const res = await dispatchWebhookRequest(req);
      expect(res.statusCode).toBe(401);
      expect(onSpy).not.toHaveBeenCalledWith("data", expect.any(Function));
    } finally {
      unregister();
    }
  });

  it("supports add-on requests that provide systemIdToken in the body", async () => {
    mockSecondVerifierSuccess();
    const { sinkA, sinkB, unregister } = registerTwoTargets();

    try {
      await expectVerifiedRoute({
        request: createWebhookRequest({
          payload: {
            commonEventObject: { hostApp: "CHAT" },
            authorizationEventObject: { systemIdToken: "addon-token" },
            chat: {
              eventTime: "2026-03-02T00:00:00.000Z",
              user: { name: "users/12345", displayName: "Test User" },
              messagePayload: {
                space: { name: "spaces/AAA" },
                message: { text: "Hello from add-on" },
              },
            },
          },
        }),
        expectedStatus: 200,
        sinkA,
        sinkB,
        expectedSink: "B",
      });
    } finally {
      unregister();
    }
  });

  it("reuses the same session key for repeated events in the same thread key", async () => {
    vi.mocked(verifyGoogleChatRequest).mockResolvedValue({ ok: true });
    const harness = createRoutingHarness();
    const unregister = registerGoogleChatWebhookTarget({
      account: {
        ...baseAccount("default"),
        config: {
          dm: { enabled: true, policy: "open" },
          groupPolicy: "open",
          requireMention: false,
          typingIndicator: "none",
        },
      },
      config: {} as OpenClawConfig,
      runtime: harness.runtime,
      core: harness.core,
      path: "/googlechat",
      statusSink: vi.fn(),
      mediaMaxMb: 5,
    });

    try {
      const first = await dispatchWebhookRequest(
        createWebhookRequest({
          authorization: "Bearer test-token",
          payload: createMessageEvent({
            threadKey: "thread-alpha",
            messageName: "spaces/AAA/messages/1",
          }),
        }),
      );
      const second = await dispatchWebhookRequest(
        createWebhookRequest({
          authorization: "Bearer test-token",
          payload: createMessageEvent({
            threadKey: "thread-alpha",
            messageName: "spaces/AAA/messages/2",
          }),
        }),
      );
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);

      await flushAsync();

      expect(harness.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
      const firstCtx = harness.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0]?.ctx as {
        SessionKey?: string;
        ParentSessionKey?: string;
      };
      const secondCtx = harness.dispatchReplyWithBufferedBlockDispatcher.mock.calls[1]?.[0]
        ?.ctx as {
        SessionKey?: string;
        ParentSessionKey?: string;
      };

      expect(firstCtx.SessionKey).toBe(
        "agent:main:googlechat:group:spaces/AAA:thread:googlechat-thread-key:thread-alpha",
      );
      expect(secondCtx.SessionKey).toBe(firstCtx.SessionKey);
      expect(firstCtx.ParentSessionKey).toBe("agent:main:googlechat:group:spaces/AAA");
      expect(secondCtx.ParentSessionKey).toBe(firstCtx.ParentSessionKey);
      expect(harness.runtimeLog).toHaveBeenCalledWith(
        expect.stringContaining(
          "thread routing source=thread-key identity=thread-alpha baseSessionKey=agent:main:googlechat:group:spaces/AAA sessionKey=agent:main:googlechat:group:spaces/AAA:thread:googlechat-thread-key:thread-alpha",
        ),
      );
    } finally {
      unregister();
    }
  });

  it("uses different session keys for different thread keys", async () => {
    vi.mocked(verifyGoogleChatRequest).mockResolvedValue({ ok: true });
    const harness = createRoutingHarness();
    const unregister = registerGoogleChatWebhookTarget({
      account: {
        ...baseAccount("default"),
        config: {
          dm: { enabled: true, policy: "open" },
          groupPolicy: "open",
          requireMention: false,
          typingIndicator: "none",
        },
      },
      config: {} as OpenClawConfig,
      runtime: harness.runtime,
      core: harness.core,
      path: "/googlechat",
      statusSink: vi.fn(),
      mediaMaxMb: 5,
    });

    try {
      const first = await dispatchWebhookRequest(
        createWebhookRequest({
          authorization: "Bearer test-token",
          payload: createMessageEvent({
            threadKey: "thread-alpha",
            messageName: "spaces/AAA/messages/1",
          }),
        }),
      );
      const second = await dispatchWebhookRequest(
        createWebhookRequest({
          authorization: "Bearer test-token",
          payload: createMessageEvent({
            threadKey: "thread-beta",
            messageName: "spaces/AAA/messages/2",
          }),
        }),
      );
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);

      await flushAsync();

      expect(harness.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
      const firstCtx = harness.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0]?.ctx as {
        SessionKey?: string;
      };
      const secondCtx = harness.dispatchReplyWithBufferedBlockDispatcher.mock.calls[1]?.[0]
        ?.ctx as {
        SessionKey?: string;
      };

      expect(firstCtx.SessionKey).toBe(
        "agent:main:googlechat:group:spaces/AAA:thread:googlechat-thread-key:thread-alpha",
      );
      expect(secondCtx.SessionKey).toBe(
        "agent:main:googlechat:group:spaces/AAA:thread:googlechat-thread-key:thread-beta",
      );
      expect(secondCtx.SessionKey).not.toBe(firstCtx.SessionKey);
    } finally {
      unregister();
    }
  });
});
