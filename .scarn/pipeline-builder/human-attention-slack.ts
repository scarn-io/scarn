// Created from the "human-attention-slack" pipeline template (scarn 0.0.0).
import { codeStep, Env, z } from "@scarn/sdk/definitions/steps";
import { definePipeline, equal, succeed, workItem } from "@scarn/sdk/pipelines";

// EXPERIMENTAL (disposable spike): Human attention → Slack.
//
//   assess ─ needs a human → notify (Slack via the Scarn action broker) → notified
//          └ otherwise ─────────────────────────────────────────────────→ noAttentionNeeded
//
// `assess` is a fixture: a work item whose title contains "[no-attention]"
// needs no human, anything else does. Replace it with a real check.
//
// `notify` holds no Slack credential. It sends the Scarn action broker a
// short-lived, single-use invocation capability that an authorized project
// member issued for this pipeline run. The broker runs the pinned Activepieces
// Slack `send_channel_message` action with the project's stored connection and
// adds the work-item link itself. Put these in the worker's `.scarn/.env`,
// never on the command line:
//
//   SLACK_SPIKE_BROKER_URL       https://<scarn>/api/spikes/action-connections
//   SLACK_SPIKE_CONNECTION_ID    the project's Slack connection id
//   SLACK_SPIKE_CAPABILITY       capability issued for this run (secret)
//   SLACK_SPIKE_INVOCATION_ID    invocation id issued with it

const SLACK_CHANNEL_ID = "C0CFPJWADV0";

const ACTION_REF = "activepieces/slack@0.23.1/send_channel_message";

// The scaffolded builder has no Node types; code steps read env this way.
declare const process: { env: Record<string, string | undefined> };

export const assess = codeStep({
  key: "assess-human-attention",
  name: "Assess Human Attention",
  description: "Fixture: decide whether the work item needs a human.",
  inputSchema: z.object({
    title: z.string(),
    description: z.string().nullable(),
  }),
  resultSchema: z.object({
    needsHumanAttention: z.boolean(),
    summary: z.string(),
  }),
  fn: ({ title, description }) => ({
    needsHumanAttention: !title.includes("[no-attention]"),
    summary: description?.trim() ? `${title}: ${description.trim()}` : title,
  }),
});

const brokerResult = z.object({
  status: z.enum(["sent", "failed", "rejected"]),
  replayed: z.boolean().optional(),
  actionRef: z.string(),
  channel: z.string().optional(),
  messageId: z.string().optional(),
  errorCode: z.string().optional(),
  retryAfter: z.number().optional(),
  deliveryCertainty: z.enum(["delivered", "not_delivered", "unknown"]),
});

export const notifySlack = codeStep({
  key: "notify-slack-human-attention",
  name: "Notify Slack",
  description:
    "Ask the Scarn action broker to post the summary and work-item link to Slack.",
  inputSchema: z.object({ summary: z.string() }),
  resultSchema: z.object({ httpStatus: z.number(), broker: brokerResult }),
  environment: {
    vars: () => ({
      SLACK_SPIKE_BROKER_URL: Env.inherit(),
      SLACK_SPIKE_CONNECTION_ID: Env.inherit(),
      SLACK_SPIKE_CAPABILITY: Env.inherit({ secret: true }),
      SLACK_SPIKE_INVOCATION_ID: Env.inherit(),
    }),
  },
  fn: async ({ summary }) => {
    const env = (name: string): string => {
      const value = process.env[name];
      if (!value) throw new Error(`${name} is not set`);
      return value;
    };
    const response = await fetch(
      `${env("SLACK_SPIKE_BROKER_URL").replace(/\/+$/, "")}/execute`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Capability ${env("SLACK_SPIKE_CAPABILITY")}`,
        },
        body: JSON.stringify({
          actionRef: ACTION_REF,
          connectionRef: env("SLACK_SPIKE_CONNECTION_ID"),
          invocationId: env("SLACK_SPIKE_INVOCATION_ID"),
          props: { channel: SLACK_CHANNEL_ID, summary },
        }),
        signal: AbortSignal.timeout(45_000),
      },
    );
    const parsed = brokerResult.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new Error(`Broker returned HTTP ${String(response.status)} without a result`);
    }
    if (parsed.data.status !== "sent") {
      throw new Error(
        `Slack notification ${parsed.data.status}: ${parsed.data.errorCode ?? "unknown"} (delivery ${parsed.data.deliveryCertainty})`,
      );
    }
    return { httpStatus: response.status, broker: parsed.data };
  },
});

const notified = succeed("notified");
const noAttentionNeeded = succeed("no-attention-needed");

export default definePipeline({
  key: "human-attention-slack",
  title: "Human Attention → Slack (experimental)",
  start: assess({
    title: workItem.title,
    description: workItem.description,
  }),
  flow: [
    assess.next({
      routes: [
        {
          when: (r) => equal(r.result.needsHumanAttention, true),
          to: (r) => notifySlack({ summary: r.result.summary }),
        },
      ],
      otherwise: noAttentionNeeded,
    }),
    notifySlack.next(notified),
  ],
});
