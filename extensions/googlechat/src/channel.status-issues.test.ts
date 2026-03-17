import { describe, expect, it } from "vitest";
import { googlechatPlugin } from "./channel.js";

describe("googlechatPlugin.status.collectStatusIssues", () => {
  it("does not report missing audience fields when they are present on snapshots", () => {
    const issues = googlechatPlugin.status!.collectStatusIssues!([
      {
        accountId: "default",
        enabled: true,
        configured: true,
        audienceType: "app-url",
        audience: "https://dev1.harryapp.ai/googlechat",
      },
    ]);

    expect(issues).toEqual([]);
  });

  it("tolerates resolved account objects with audience fields nested under config", () => {
    const issues = googlechatPlugin.status!.collectStatusIssues!([
      {
        accountId: "default",
        enabled: true,
        configured: true,
        config: {
          audienceType: "app-url",
          audience: "https://dev1.harryapp.ai/googlechat",
        },
      } as never,
    ]);

    expect(issues).toEqual([]);
  });

  it("still reports genuinely missing audience fields", () => {
    const issues = googlechatPlugin.status!.collectStatusIssues!([
      {
        accountId: "default",
        enabled: true,
        configured: true,
      },
    ]);

    expect(issues.map((issue) => issue.message)).toEqual([
      "Google Chat audience is missing (set channels.googlechat.audience).",
      "Google Chat audienceType is missing (app-url or project-number).",
    ]);
  });
});
