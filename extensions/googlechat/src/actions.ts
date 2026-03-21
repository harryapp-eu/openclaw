import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  OpenClawConfig,
} from "openclaw/plugin-sdk/googlechat";
import {
  createActionGate,
  extractToolSend,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "openclaw/plugin-sdk/googlechat";
import { listEnabledGoogleChatAccounts, resolveGoogleChatAccount } from "./accounts.js";
import {
  createGoogleChatReaction,
  deleteGoogleChatReaction,
  listGoogleChatReactions,
  sendGoogleChatMessage,
  uploadGoogleChatAttachment,
} from "./api.js";
import { getGoogleChatRuntime } from "./runtime.js";
import { resolveGoogleChatOutboundSpace } from "./targets.js";

const providerId = "googlechat";

function listEnabledAccounts(cfg: OpenClawConfig) {
  return listEnabledGoogleChatAccounts(cfg).filter(
    (account) => account.enabled && account.credentialSource !== "none",
  );
}

function isReactionsEnabled(accounts: ReturnType<typeof listEnabledAccounts>, cfg: OpenClawConfig) {
  for (const account of accounts) {
    const gate = createActionGate(
      (account.config.actions ??
        (cfg.channels?.["googlechat"] as { actions?: unknown })?.actions) as Record<
        string,
        boolean | undefined
      >,
    );
    if (gate("reactions")) {
      return true;
    }
  }
  return false;
}

function resolveAppUserNames(account: { config: { botUser?: string | null } }) {
  return new Set(["users/app", account.config.botUser?.trim()].filter(Boolean) as string[]);
}

function ensureUserAuth(account: { userAuth?: { accessToken?: string; refreshToken?: string } }) {
  if (account.userAuth?.accessToken?.trim() || account.userAuth?.refreshToken?.trim()) {
    return;
  }
  throw new Error(
    "Google Chat user OAuth is required for attachments/reactions. Configure channels.googlechat.userAuth (or accounts.<id>.userAuth).",
  );
}

export const googlechatMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledAccounts(cfg);
    if (accounts.length === 0) {
      return [];
    }
    const actions = new Set<ChannelMessageActionName>([]);
    actions.add("send");
    actions.add("sendAttachment");
    if (isReactionsEnabled(accounts, cfg)) {
      actions.add("react");
      actions.add("reactions");
    }
    return Array.from(actions);
  },
  extractToolSend: ({ args }) => {
    return extractToolSend(args, "sendMessage");
  },
  handleAction: async ({ action, params, cfg, accountId }) => {
    const account = resolveGoogleChatAccount({
      cfg: cfg,
      accountId,
    });
    if (account.credentialSource === "none") {
      throw new Error("Google Chat credentials are missing.");
    }

    if (action === "send" || action === "sendAttachment") {
      const to = readStringParam(params, "to", { required: true });
      const content =
        readStringParam(params, "message", {
          required: action === "send",
          allowEmpty: true,
        }) ??
        readStringParam(params, "caption", { allowEmpty: true }) ??
        "";
      const mediaUrl = readStringParam(params, "media", { trim: false });
      const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
      const space = await resolveGoogleChatOutboundSpace({ account, target: to });

      if (action === "sendAttachment") {
        ensureUserAuth(account);
        const base64Buffer = readStringParam(params, "buffer", { trim: false });
        const filename = readStringParam(params, "filename") ?? "attachment";
        const contentType =
          readStringParam(params, "contentType") ?? readStringParam(params, "mimeType");
        if (!base64Buffer) {
          throw new Error("Google Chat sendAttachment requires buffer (base64).");
        }
        const upload = await uploadGoogleChatAttachment({
          account,
          space,
          filename,
          buffer: Buffer.from(base64Buffer, "base64"),
          contentType: contentType ?? undefined,
        });
        await sendGoogleChatMessage({
          account,
          space,
          text: content,
          thread: threadId ?? undefined,
          attachments: upload.attachmentUploadToken
            ? [{ attachmentUploadToken: upload.attachmentUploadToken, contentName: filename }]
            : undefined,
        });
        return jsonResult({ ok: true, to: space });
      }

      if (mediaUrl) {
        ensureUserAuth(account);
        const core = getGoogleChatRuntime();
        const maxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
        const loaded = /^https?:\/\//i.test(mediaUrl)
          ? await core.channel.media.fetchRemoteMedia({ url: mediaUrl, maxBytes })
          : await core.media.loadWebMedia(mediaUrl, { maxBytes });
        const upload = await uploadGoogleChatAttachment({
          account,
          space,
          filename: loaded.fileName ?? "attachment",
          buffer: loaded.buffer,
          contentType: loaded.contentType,
        });
        await sendGoogleChatMessage({
          account,
          space,
          text: content,
          thread: threadId ?? undefined,
          attachments: upload.attachmentUploadToken
            ? [
                {
                  attachmentUploadToken: upload.attachmentUploadToken,
                  contentName: loaded.fileName,
                },
              ]
            : undefined,
        });
        return jsonResult({ ok: true, to: space });
      }

      await sendGoogleChatMessage({
        account,
        space,
        text: content,
        thread: threadId ?? undefined,
      });
      return jsonResult({ ok: true, to: space });
    }

    if (action === "react") {
      ensureUserAuth(account);
      const messageName = readStringParam(params, "messageId", { required: true });
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove a Google Chat reaction.",
      });
      if (remove || isEmpty) {
        const reactions = await listGoogleChatReactions({ account, messageName });
        const appUsers = resolveAppUserNames(account);
        const toRemove = reactions.filter((reaction) => {
          const userName = reaction.user?.name?.trim();
          if (appUsers.size > 0 && !appUsers.has(userName ?? "")) {
            return false;
          }
          if (emoji) {
            return reaction.emoji?.unicode === emoji;
          }
          return true;
        });
        for (const reaction of toRemove) {
          if (!reaction.name) {
            continue;
          }
          await deleteGoogleChatReaction({ account, reactionName: reaction.name });
        }
        return jsonResult({ ok: true, removed: toRemove.length });
      }
      const reaction = await createGoogleChatReaction({
        account,
        messageName,
        emoji,
      });
      return jsonResult({ ok: true, reaction });
    }

    if (action === "reactions") {
      ensureUserAuth(account);
      const messageName = readStringParam(params, "messageId", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true });
      const reactions = await listGoogleChatReactions({
        account,
        messageName,
        limit: limit ?? undefined,
      });
      return jsonResult({ ok: true, reactions });
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
