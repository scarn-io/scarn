import { CoreValidationError } from "@scarn/core/lib/errors";

export type WorkItemActorProps = {
  id?: string | undefined;
  displayName: string;
  email?: string | undefined;
};

export class WorkItemActor {
  public readonly id: string | undefined;
  public readonly displayName: string;
  public readonly email: string | undefined;

  constructor(props: WorkItemActorProps) {
    const displayName = props.displayName.trim();
    if (!displayName) {
      throw new CoreValidationError(
        "WorkItemActor displayName is required",
        "WORK_ITEM_ACTOR_DISPLAY_NAME_REQUIRED",
      );
    }

    this.id = props.id?.trim() || undefined;
    this.displayName = displayName;
    this.email = props.email?.trim() || undefined;
  }

  toJSON(): WorkItemActorProps {
    return {
      id: this.id,
      displayName: this.displayName,
      email: this.email,
    };
  }
}
