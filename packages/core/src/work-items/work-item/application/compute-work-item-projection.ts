import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { WorkItemProjectionFingerprintEntity } from "../domain/work-item-projection-fingerprint-entity";
import { projectWorkItem, type WorkItemProjectionSpec } from "../domain/work-item-projection";
import type { WorkItemEntity } from "../domain/work-item-entity";
import type { WorkItemProjectionFingerprintRepo } from "./work-item-repo";

export const computeWorkItemProjectionFingerprint = async ({
  workItem,
  spec,
  fingerprintRepo,
  save = false,
  dbExecutor,
}: {
  workItem: WorkItemEntity;
  spec: WorkItemProjectionSpec;
  fingerprintRepo?: WorkItemProjectionFingerprintRepo | undefined;
  save?: boolean | undefined;
  dbExecutor?: DbExecutor;
}) => {
  const projection = projectWorkItem(workItem, spec);
  const previous =
    fingerprintRepo === undefined
      ? null
      : await fingerprintRepo.load(workItem.id, spec.id, dbExecutor);

  const current = new WorkItemProjectionFingerprintEntity({
    workItemId: workItem.id,
    specId: spec.id,
    fingerprint: projection.fingerprint,
    canonicalContent: projection.canonicalContent,
  });

  if (save && fingerprintRepo) {
    await fingerprintRepo.save(current, dbExecutor);
  }

  return {
    projection,
    previous,
    changed: previous?.fingerprint !== current.fingerprint,
    current,
  };
};
