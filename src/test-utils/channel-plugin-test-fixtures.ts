import type { ChannelPlugin } from "../channels/plugins/types.js";

export function makeDirectPlugin(params: {
  id: string;
  label: string;
  docsPath: string;
  config: ChannelPlugin["config"];
  status?: ChannelPlugin["status"];
}): ChannelPlugin {
  return {
    id: params.id,
    meta: {
      id: params.id,
      label: params.label,
      selectionLabel: params.label,
      docsPath: params.docsPath,
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: params.config,
    status: params.status,
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
    },
  };
}
