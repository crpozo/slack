import { fileURLToPath } from "node:url";
import { Duration, Stack } from "aws-cdk-lib";
import {
  CfnApi,
  CorsHttpMethod,
  HttpApi,
  HttpMethod,
  type IHttpRouteAuthorizer,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import type { Api } from "./api";
import type { Auth } from "./auth";
import type { Data } from "./data";
import { removalPolicyFor, type Stage } from "./stage";

const HANDLERS_DIR = fileURLToPath(new URL("../../backend/src/handlers/", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Every route of the Task Manager API, all behind the JWT authorizer. */
export const TASKS_ROUTES: Array<{ method: HttpMethod; path: string }> = [
  { method: HttpMethod.GET, path: "/boards" },
  { method: HttpMethod.POST, path: "/boards" },
  { method: HttpMethod.PUT, path: "/boards/{id}" },
  { method: HttpMethod.POST, path: "/boards/{id}/members" },
  { method: HttpMethod.GET, path: "/boards/{id}/tasks" },
  { method: HttpMethod.POST, path: "/boards/{id}/tasks" },
  { method: HttpMethod.PUT, path: "/tasks/{taskId}" },
  { method: HttpMethod.DELETE, path: "/tasks/{taskId}" },
];

interface TasksApiProps {
  stage: Stage;
  auth: Auth;
  data: Data;
  /** The chat WebSocket API: board changes are pushed to members' connections. */
  wsApi: Api;
  /** Browser origins allowed to call the API (more can be added later with `allowOrigins`). */
  allowOrigins: string[];
}

/**
 * Task Manager: an HTTP API (API Gateway v2) separate from the WebSocket API.
 * Cognito id tokens are verified by API Gateway's JWT authorizer, so no
 * authorizer Lambda runs; one `tasks` Lambda serves every route.
 */
export class TasksApi extends Construct {
  readonly httpApi: HttpApi;
  readonly handler: NodejsFunction;
  /** Base URL clients call, without a trailing slash. */
  readonly url: string;
  private readonly origins: string[];

  constructor(scope: Construct, id: string, props: TasksApiProps) {
    super(scope, id);
    const { stage, auth, data, wsApi } = props;
    this.origins = [...props.allowOrigins];

    const functionName = `slack-${stage}-tasks`;
    this.handler = new NodejsFunction(this, "Fn", {
      functionName,
      entry: `${HANDLERS_DIR}tasks.ts`,
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        STAGE: stage,
        LOG_LEVEL: "info",
        BOARDS_TABLE: data.boards.tableName,
        TASKS_TABLE: data.tasks.tableName,
        USERS_TABLE: data.users.tableName,
        CONNECTIONS_TABLE: data.connections.tableName,
        WS_ENDPOINT: wsApi.webSocketStage.callbackUrl,
      },
      projectRoot: REPO_ROOT,
      depsLockFilePath: `${REPO_ROOT}pnpm-lock.yaml`,
      bundling: { minify: true, sourceMap: false, target: "node22", externalModules: [] },
      logGroup: new LogGroup(this, "Logs", {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: RetentionDays.ONE_WEEK,
        removalPolicy: removalPolicyFor(stage),
      }),
    });

    const region = Stack.of(this).region;
    const authorizer: IHttpRouteAuthorizer = new HttpJwtAuthorizer(
      "Jwt",
      `https://cognito-idp.${region}.amazonaws.com/${auth.userPool.userPoolId}`,
      { jwtAudience: [auth.userPoolClient.userPoolClientId], authorizerName: `slack-${stage}-jwt` },
    );

    this.httpApi = new HttpApi(this, "HttpApi", {
      apiName: `slack-${stage}-tasks`,
      defaultAuthorizer: authorizer,
      corsPreflight: {
        allowOrigins: this.origins,
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PUT,
          CorsHttpMethod.DELETE,
          CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["authorization", "content-type"],
        maxAge: Duration.hours(1),
      },
    });
    const integration = new HttpLambdaIntegration("TasksIntegration", this.handler);
    for (const { method, path } of TASKS_ROUTES) {
      this.httpApi.addRoutes({ path, methods: [method], integration });
    }
    this.url = this.httpApi.apiEndpoint;

    // --- Permissions: only what the handler calls ---
    data.boards.grant(
      this.handler,
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:BatchGetItem",
    );
    data.boards.grant(this.handler, "dynamodb:Query"); // table + byUser index
    data.tasks.grant(
      this.handler,
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
    );
    data.users.grant(this.handler, "dynamodb:BatchGetItem"); // invitees must exist
    // Real-time pushes: list live connections, post to members', drop stale ones (410).
    data.connections.grant(this.handler, "dynamodb:Scan", "dynamodb:DeleteItem");
    wsApi.webSocketApi.grantManageConnections(this.handler);
  }

  /**
   * Adds browser origins after construction (the CloudFront domain only exists
   * once the Web construct does, which itself needs this API's URL).
   */
  allowOrigins(origins: string[]): void {
    this.origins.push(...origins.filter((o) => !this.origins.includes(o)));
    const cfn = this.httpApi.node.defaultChild as CfnApi;
    cfn.addPropertyOverride("CorsConfiguration.AllowOrigins", this.origins);
  }
}
