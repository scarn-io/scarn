import {
  all,
  decision,
  definePipeline,
  equal,
  fail,
  greaterThanInclusive,
  lessThan,
  reply,
  succeed,
  workItemField,
} from "@scarn/sdk/pipelines";
import {
  evaluate,
  failingTest,
  fix,
  proposeFix,
  reproduceFromLogs,
  reproduceFromSession,
} from "./bug-steps";

const askForDetails = reply("ask-for-details");
const approveFix = decision("approve-fix", {
  actions: {
    approve: { label: "Approve" },
    reject: { label: "Reject" },
  },
});
const done = succeed("done");
const insufficientDetail = fail("insufficient-detail", {
  error: "InsufficientDetail",
});
const notReproduced = fail("not-reproduced", { error: "NotReproduced" });
const fixRejected = fail("fix-rejected", { error: "FixRejected" });

export default definePipeline({
  key: "bug-pipeline",
  title: "Bug triage and fix",
  start: evaluate({
    companyNames: workItemField(
      "companyNames",
      "What are the Company Name(s):",
    ),
    employeeEmails: workItemField(
      "employeeEmails",
      "What are the Employee Email(s):",
    ),
  }),
  flow: [
    evaluate.next({
      routes: [
        {
          when: (r) => lessThan(r.result.quality, 0.1),
          to: (r) => askForDetails({ questions: r.result.missingDetails }),
        },
        {
          when: (r) => equal(r.result.hasRumSession, true),
          to: (r) =>
            reproduceFromSession({
              companyNames: r.input.companyNames,
              employeeEmails: r.input.employeeEmails,
              evaluation: r.result,
            }),
        },
      ],
      otherwise: (r) => reproduceFromLogs({ ...r.input, evaluation: r.result }),
    }),

    askForDetails
      .settings({ maxRuns: 2 })
      .catch(["Scarn.MaxRunsExceeded"], insufficientDetail)
      .next((r) =>
        evaluate({
          companyNames: r.node(evaluate).input.companyNames,
          employeeEmails: r.node(evaluate).input.employeeEmails,
        }),
      ),

    reproduceFromSession.next({
      routes: [
        {
          when: (r) =>
            all(
              greaterThanInclusive(r.result.reproductionConfidence, 0.8),
              equal(r.result.evidenceVerdict, "reproduced"),
            ),
          to: (r) =>
            failingTest({
              evaluation: r.node(evaluate).result,
              investigation: r.result,
            }),
        },
      ],
      otherwise: notReproduced,
    }),

    reproduceFromLogs.catch(["Scarn.All"], notReproduced).next({
      routes: [
        {
          when: (r) =>
            all(
              greaterThanInclusive(r.result.reproductionConfidence, 0.8),
              equal(r.result.evidenceVerdict, "reproduced"),
            ),
          to: (r) =>
            failingTest({
              evaluation: r.node(evaluate).result,
              investigation: r.result,
            }),
        },
      ],
      otherwise: notReproduced,
    }),

    failingTest.next((r) =>
      proposeFix({
        evaluation: r.node(evaluate).result,
        investigation: r.input.investigation,
        failingTest: r.result,
      }),
    ),

    proposeFix.next({
      routes: [
        {
          when: (r) => equal(r.result.requiresHumanApproval, true),
          to: (r) => approveFix({ request: r.result }),
        },
      ],
      otherwise: (r) =>
        fix({
          evaluation: r.node(evaluate).result,
          investigation: r.node(failingTest).input.investigation,
          failingTest: r.node(failingTest).result,
          plan: r.result,
        }),
    }),

    approveFix.next({
      routes: [
        {
          when: (r) => equal(r.result.action, "approve"),
          to: (r) =>
            fix({
              evaluation: r.node(evaluate).result,
              investigation: r.node(failingTest).input.investigation,
              failingTest: r.node(failingTest).result,
              plan: r.node(proposeFix).result,
            }),
        },
      ],
      otherwise: fixRejected,
    }),

    fix
      .settings({ timeoutSeconds: 3600, heartbeatSeconds: 300, maxRuns: 5 })
      .retry({ on: ["Scarn.HeartbeatTimeout"], maxAttempts: 2 })
      .next({
        routes: [{ when: (r) => equal(r.result.testsPass, true), to: done }],
        otherwise: (r) => fix({ ...r.input, previousAttempt: r.result }),
      }),
  ],
});
