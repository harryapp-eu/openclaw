import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { downloadGoogleChatMedia, sendGoogleChatMessage } from "./api.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("./auth.js", () => ({
  getGoogleChatAccessToken: vi.fn().mockResolvedValue("token"),
}));

vi.mock("openclaw/plugin-sdk/googlechat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/googlechat")>()),
  fetchWithSsrFGuard: (...args: unknown[]) =>
    fetchWithSsrFGuardMock(
      ...(args as [
        params: {
          url: string;
          init?: RequestInit;
        },
      ]),
    ),
}));

const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "inline",
  config: {},
} as ResolvedGoogleChatAccount;

function stubSuccessfulSend(name: string) {
  fetchWithSsrFGuardMock.mockResolvedValue({
    response: new Response(JSON.stringify({ name }), { status: 200 }),
    release: vi.fn(async () => undefined),
  });
  return fetchWithSsrFGuardMock;
}

async function expectDownloadToRejectForResponse(response: Response) {
  fetchWithSsrFGuardMock.mockResolvedValue({
    response,
    release: vi.fn(async () => undefined),
  });
  await expect(
    downloadGoogleChatMedia({ account, resourceName: "media/123", maxBytes: 10 }),
  ).rejects.toThrow(/max bytes/i);
}

describe("downloadGoogleChatMedia", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("rejects when content-length exceeds max bytes", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-length": "50", "content-type": "application/octet-stream" },
    });
    await expectDownloadToRejectForResponse(response);
  });

  it("rejects when streamed payload exceeds max bytes", async () => {
    const chunks = [new Uint8Array(6), new Uint8Array(6)];
    let index = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(chunks[index++]);
        } else {
          controller.close();
        }
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
    await expectDownloadToRejectForResponse(response);
  });
});

describe("sendGoogleChatMessage", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("adds messageReplyOption when sending to an existing thread", async () => {
    const fetchMock = stubSuccessfulSend("spaces/AAA/messages/123");

    await sendGoogleChatMessage({
      account,
      space: "spaces/AAA",
      text: "hello",
      thread: "spaces/AAA/threads/xyz",
    });

    const [request] = fetchMock.mock.calls[0] ?? [];
    expect(String(request?.url)).toContain(
      "messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
    ); // pragma: allowlist secret
    expect(JSON.parse(String(request?.init?.body))).toMatchObject({
      text: "hello",
      thread: { name: "spaces/AAA/threads/xyz" },
    });
  });

  it("supports synthetic thread keys for starting a new thread-backed session", async () => {
    const fetchMock = fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          name: "spaces/AAA/messages/125",
          thread: {
            name: "spaces/AAA/threads/generated",
            threadKey: "msg-1",
          },
        }),
        { status: 200 },
      ),
      release: vi.fn(async () => undefined),
    });

    const result = await sendGoogleChatMessage({
      account,
      space: "spaces/AAA",
      text: "hello",
      threadKey: "msg-1",
    });

    const [request] = fetchMock.mock.calls[0] ?? [];
    expect(String(request?.url)).toContain(
      "messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
    ); // pragma: allowlist secret
    expect(JSON.parse(String(request?.init?.body))).toMatchObject({
      text: "hello",
      thread: { threadKey: "msg-1" },
    });
    expect(result).toEqual({
      messageName: "spaces/AAA/messages/125",
      threadName: "spaces/AAA/threads/generated",
      threadKey: "msg-1",
    });
  });

  it("does not set messageReplyOption for non-thread sends", async () => {
    const fetchMock = stubSuccessfulSend("spaces/AAA/messages/124");

    await sendGoogleChatMessage({
      account,
      space: "spaces/AAA",
      text: "hello",
    });

    const [request] = fetchMock.mock.calls[0] ?? [];
    expect(String(request?.url)).not.toContain("messageReplyOption=");
  });
});
