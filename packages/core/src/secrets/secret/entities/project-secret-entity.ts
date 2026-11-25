import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import {
  ENV_VAR_NAME_PATTERN,
  isReservedEnvVarName,
  RESERVED_ENV_VAR_NAMES,
  RESERVED_ENV_VAR_PREFIX,
} from "@scarn/sdk/env-vars";
import type { ProjectSecretOwner } from "../domain/secret-owner";
import {
  normalizeSecretName,
  SecretEntityBase,
  type SecretEntityBaseProps,
  type SecretRowProps,
  type SecretValueKind,
} from "./secret-entity-base";

export type ProjectSecretEntityProps =
  SecretEntityBaseProps<ProjectSecretOwner> & {
    valueKind: SecretValueKind;
  };

export type CreateProjectSecretEntityProps = Omit<
  ProjectSecretEntityProps,
  "id" | "lastUsedAt" | "createdAt" | "updatedAt" | "valueKind"
> & {
  id?: UuidV7 | undefined;
  now: Date;
};

/**
 * Trims a project secret name and checks it is a usable environment variable
 * name, the same rule `@scarn/sdk/env-vars` applies to step variables, since
 * environments expose it under that name. Throws `SECRET_NAME_INVALID`.
 */
export const normalizeProjectSecretName = (name: string): string => {
  const trimmed = normalizeSecretName(name);
  if (!ENV_VAR_NAME_PATTERN.test(trimmed)) {
    throw new CoreValidationError(
      "Project secret name must be uppercase letters, digits and underscores, not starting with a digit",
      "SECRET_NAME_INVALID",
    );
  }
  if (isReservedEnvVarName(trimmed)) {
    throw new CoreValidationError(
      `Project secret name is reserved (${RESERVED_ENV_VAR_PREFIX}*, ${RESERVED_ENV_VAR_NAMES.join(", ")})`,
      "SECRET_NAME_INVALID",
    );
  }
  return trimmed;
};

/**
 * A named value saved on a project, referenced by name from its
 * environments. Only a project may own one, it never expires, and it carries
 * no metadata beyond how its value is obtained (`valueKind`, always
 * `"static"` for now).
 */
export class ProjectSecretEntity extends SecretEntityBase<ProjectSecretOwner> {
  public readonly kind = "project_secret" as const;
  public readonly expiresAt = null;
  public readonly valueKind: SecretValueKind;

  private constructor(props: ProjectSecretEntityProps) {
    const { valueKind, ...baseProps } = props;
    super(baseProps, "project_secret");
    this.valueKind = valueKind;
  }

  static create(props: CreateProjectSecretEntityProps): ProjectSecretEntity {
    const { now, id, ...rest } = props;
    return new ProjectSecretEntity({
      ...rest,
      name: normalizeProjectSecretName(rest.name),
      id: id ?? createUuidV7(),
      valueKind: "static",
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static rehydrate(props: ProjectSecretEntityProps): ProjectSecretEntity {
    return new ProjectSecretEntity(props);
  }

  protected override normalizeName(name: string): string {
    return normalizeProjectSecretName(name);
  }

  protected withBaseProps(
    props: SecretEntityBaseProps<ProjectSecretOwner>,
  ): this {
    return new ProjectSecretEntity({
      ...props,
      valueKind: this.valueKind,
    }) as this;
  }

  toJSON(): SecretRowProps {
    return {
      ...this.baseJSON(),
      kind: this.kind,
      valueKind: this.valueKind,
      metadataJson: {},
      expiresAt: null,
    };
  }
}
