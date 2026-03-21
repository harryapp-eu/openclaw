import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";

const resolveGoogleChatAccountMock = vi.hoisted(() => vi.fn());
const resolveGoogleChatOutboundSpaceMock = vi.hoisted(() => vi.fn());
const uploadGoogleChatAttachmentMock = vi.hoisted(() => vi.fn());
const sendGoogleChatMessageMock = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  listEnabledGoogleChatAccounts: vi.fn(() => []),
  resolveGoogleChatAccount: resolveGoogleChatAccountMock,
}));

vi.mock("./targets.js", () => ({
  resolveGoogleChatOutboundSpace: resolveGoogleChatOutboundSpaceMock,
}));

vi.mock("./api.js", () => ({
  uploadGoogleChatAttachment: uploadGoogleChatAttachmentMock,
  sendGoogleChatMessage: sendGoogleChatMessageMock,
  createGoogleChatReaction: vi.fn(),
  deleteGoogleChatReaction: vi.fn(),
  listGoogleChatReactions: vi.fn(),
}));

import { googlechatMessageActions } from "./actions.js";
import { setGoogleChatRuntime } from "./runtime.js";

function createCfg(): OpenClawConfig {
  return {
    channels: {
      googlechat: {
        enabled: true,
        serviceAccount: {
          type: "service_account",
          client_email: "bot@example.com",
          private_key: "test-key",
          token_uri: "https://oauth2.googleapis.com/token",
        },
      },
    },
  };
}

describe("googlechatMessageActions send media", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("loads local media paths via runtime media loader", async () => {
    const account = {
      accountId: "default",
      credentialSource: "inline",
      userAuth: { refreshToken: "refresh-token" },
      config: { mediaMaxMb: 20 },
    };
    resolveGoogleChatAccountMock.mockReturnValue(account);
    resolveGoogleChatOutboundSpaceMock.mockResolvedValue("spaces/AAA");
    uploadGoogleChatAttachmentMock.mockResolvedValue({ attachmentUploadToken: "token-1" });
    sendGoogleChatMessageMock.mockResolvedValue({ name: "spaces/AAA/messages/msg-1" });

    const loadWebMedia = vi.fn(async () => ({
      buffer: Buffer.from("local-bytes"),
      fileName: "local.png",
      contentType: "image/png",
    }));
    const fetchRemoteMedia = vi.fn(async () => ({
      buffer: Buffer.from("remote-bytes"),
      fileName: "remote.png",
      contentType: "image/png",
    }));

    setGoogleChatRuntime({
      media: { loadWebMedia },
      channel: {
        media: { fetchRemoteMedia },
        text: { chunkMarkdownText: (text: string) => [text] },
      },
    } as unknown as PluginRuntime);

    const result = await googlechatMessageActions.handleAction?.({
      action: "send",
      params: {
        to: "spaces/AAA",
        message: "caption",
        media: "/tmp/output/local.png",
      },
      cfg: createCfg(),
      accountId: "default",
    } as any);

    expect(loadWebMedia).toHaveBeenCalledWith("/tmp/output/local.png", {
      maxBytes: 20 * 1024 * 1024,
    });
    expect(fetchRemoteMedia).not.toHaveBeenCalled();
    expect(uploadGoogleChatAttachmentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        space: "spaces/AAA",
        filename: "local.png",
        contentType: "image/png",
      }),
    );
    expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        space: "spaces/AAA",
        text: "caption",
        attachments: [{ attachmentUploadToken: "token-1", contentName: "local.png" }],
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        details: { ok: true, to: "spaces/AAA" },
      }),
    );
  });

  it("uploads base64 attachments for sendAttachment", async () => {
    const account = {
      accountId: "default",
      credentialSource: "inline",
      userAuth: { refreshToken: "refresh-token" },
      config: { mediaMaxMb: 20 },
    };
    resolveGoogleChatAccountMock.mockReturnValue(account);
    resolveGoogleChatOutboundSpaceMock.mockResolvedValue("spaces/AAA");
    uploadGoogleChatAttachmentMock.mockResolvedValue({ attachmentUploadToken: "token-2" });
    sendGoogleChatMessageMock.mockResolvedValue({ name: "spaces/AAA/messages/msg-2" });

    const result = await googlechatMessageActions.handleAction?.({
      action: "sendAttachment",
      params: {
        to: "spaces/AAA",
        caption: "caption",
        filename: "tiny.png",
        contentType: "image/png",
        buffer: Buffer.from("png-bytes").toString("base64"),
      },
      cfg: createCfg(),
      accountId: "default",
    } as any);

    expect(uploadGoogleChatAttachmentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        space: "spaces/AAA",
        filename: "tiny.png",
        contentType: "image/png",
        buffer: Buffer.from("png-bytes"),
      }),
    );
    expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        space: "spaces/AAA",
        text: "caption",
        attachments: [{ attachmentUploadToken: "token-2", contentName: "tiny.png" }],
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        details: { ok: true, to: "spaces/AAA" },
      }),
    );
  });
});
