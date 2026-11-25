import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import {
  createBaseProps,
  ProjectIntegrationEntityBase,
  type CreateProjectIntegrationEntityBaseProps,
  type ProjectIntegrationEntityBaseProps,
  type ProjectIntegrationRowProps,
} from "./project-integration-entity-base";

export type JiraProjectIntegrationScope = {
  baseUrl: string;
  projectKeys: string[];
};

export type JiraProjectIntegrationProps = ProjectIntegrationEntityBaseProps & {
  scope: JiraProjectIntegrationScope;
};

export type CreateJiraProjectIntegrationProps =
  CreateProjectIntegrationEntityBaseProps & {
    scope: JiraProjectIntegrationScope;
  };

const normalizeJiraScope = (
  scope: JiraProjectIntegrationScope,
): JiraProjectIntegrationScope => {
  const baseUrl = scope.baseUrl.trim();
  if (!baseUrl) {
    throw new CoreValidationError(
      "Jira integration must have a base URL",
      "PROJECT_INTEGRATION_JIRA_BASE_URL_REQUIRED",
    );
  }
  if (!Array.isArray(scope.projectKeys) || scope.projectKeys.length === 0) {
    throw new CoreValidationError(
      "Jira integration must have at least one project key",
      "PROJECT_INTEGRATION_JIRA_PROJECT_KEYS_REQUIRED",
    );
  }
  return { baseUrl, projectKeys: [...scope.projectKeys] };
};

/**
 * A Jira site integration, scoped to a base URL and a set of project keys.
 * It authenticates with a user credential, so it has no installation.
 */
export class JiraProjectIntegration extends ProjectIntegrationEntityBase {
  public readonly kind = "jira" as const;
  public readonly platform = "jira" as const;
  public readonly authMode = "user_credential" as const;
  public readonly scope: JiraProjectIntegrationScope;

  private constructor(props: JiraProjectIntegrationProps) {
    const { scope, ...baseProps } = props;
    super(baseProps);
    this.scope = scope;
  }

  static create(
    props: CreateJiraProjectIntegrationProps,
  ): JiraProjectIntegration {
    return new JiraProjectIntegration({
      ...createBaseProps({ ...props, id: props.id ?? createUuidV7() }),
      scope: normalizeJiraScope(props.scope),
    });
  }

  static rehydrate(props: JiraProjectIntegrationProps): JiraProjectIntegration {
    return new JiraProjectIntegration(props);
  }

  protected withBaseProps(props: ProjectIntegrationEntityBaseProps): this {
    return new JiraProjectIntegration({ ...props, scope: this.scope }) as this;
  }

  withJiraScope(scope: JiraProjectIntegrationScope): this {
    return new JiraProjectIntegration({
      ...this.baseJSON(),
      scope: normalizeJiraScope(scope),
    }) as this;
  }

  toJSON(): ProjectIntegrationRowProps {
    return {
      ...this.baseJSON(),
      kind: this.kind,
      installationId: null,
      externalScopeJson: {
        baseUrl: this.scope.baseUrl,
        projectKeys: [...this.scope.projectKeys],
      },
    };
  }
}
