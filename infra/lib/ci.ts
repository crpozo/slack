import { Stack } from "aws-cdk-lib";
import {
  Effect,
  OpenIdConnectProvider,
  PolicyStatement,
  Role,
  WebIdentityPrincipal,
  type IOpenIdConnectProvider,
} from "aws-cdk-lib/aws-iam";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

const GITHUB_OIDC_URL = "https://token.actions.githubusercontent.com";

interface GitHubDeployRoleProps {
  /** `owner/repo` allowed to assume the role. */
  repository: string;
  /**
   * Numeric ids of the owner and the repository. GitHub may put them in the
   * token's `sub` (`repo:owner@<ownerId>/repo@<repoId>:ref:…`) instead of the
   * plain names; both forms are trusted. Leave out to trust the plain form only.
   */
  repositoryIds?: { owner: string; repo: string };
  /** Only workflows running on this branch may deploy. */
  branch: string;
  /**
   * The account's existing GitHub OIDC provider. There can only be one per
   * account; leave empty to create it here.
   */
  existingProviderArn?: string;
  /** Table the post-deploy seed script writes #general into. */
  channelsTable: Table;
}

/** The exact `sub` claims of workflows on `branch` of the repository (both GitHub formats). */
export function githubSubjects(
  props: Pick<GitHubDeployRoleProps, "repository" | "repositoryIds" | "branch">,
): string[] {
  const ref = `ref:refs/heads/${props.branch}`;
  const subjects = [`repo:${props.repository}:${ref}`];
  if (props.repositoryIds) {
    const [owner, repo] = props.repository.split("/");
    subjects.push(
      `repo:${owner}@${props.repositoryIds.owner}/${repo}@${props.repositoryIds.repo}:${ref}`,
    );
  }
  return subjects;
}

/**
 * Role assumed by `.github/workflows/deploy.yml` through OIDC (no long-lived
 * keys). It can only assume the CDK bootstrap roles, which do the actual
 * deployment, plus seed #general.
 */
export class GitHubDeployRole extends Construct {
  readonly role: Role;

  constructor(scope: Construct, id: string, props: GitHubDeployRoleProps) {
    super(scope, id);
    const { account, partition } = Stack.of(this);

    const provider: IOpenIdConnectProvider = props.existingProviderArn
      ? OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          "Provider",
          props.existingProviderArn,
        )
      : new OpenIdConnectProvider(this, "Provider", {
          url: GITHUB_OIDC_URL,
          clientIds: ["sts.amazonaws.com"],
        });

    this.role = new Role(this, "Role", {
      roleName: "slack-github-deploy",
      description: `GitHub Actions deploys from ${props.repository}@${props.branch}`,
      assumedBy: new WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": githubSubjects(props),
        },
      }),
    });

    // `cdk deploy` does its work through the bootstrap roles (deploy, file
    // publishing, lookup); this role only needs to assume them.
    this.role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: [`arn:${partition}:iam::${account}:role/cdk-*`],
      }),
    );
    props.channelsTable.grant(this.role, "dynamodb:PutItem");
  }
}
