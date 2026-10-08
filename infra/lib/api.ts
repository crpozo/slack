import { fileURLToPath } from "node:url";
import { CLIENT_ACTIONS } from "@mindfultech/shared";
import { Duration } from "aws-cdk-lib";
import { WebSocketApi, WebSocketStage } from "aws-cdk-lib/aws-apigatewayv2";
import { WebSocketLambdaAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Bucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import type { Auth } from "./auth";
import type { Data } from "./data";
import { removalPolicyFor, type Stage } from "./stage";

const HANDLERS_DIR = fileURLToPath(new URL("../../backend/src/handlers/", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

type Handler = "authorizer" | "connect" | "disconnect" | (typeof CLIENT_ACTIONS)[number];

interface ApiProps {
  stage: Stage;
  auth: Auth;
  data: Data;
  attachments: Bucket;
}

export class Api extends Construct {
  readonly webSocketApi: WebSocketApi;
  readonly webSocketStage: WebSocketStage;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    const { stage, data } = props;

    this.webSocketApi = new WebSocketApi(this, "WebSocketApi", {
      apiName: `slack-${stage}-ws`,
      routeSelectionExpression: "$request.body.action",
    });
    this.webSocketStage = new WebSocketStage(this, "Stage", {
      webSocketApi: this.webSocketApi,
      stageName: "prod",
      autoDeploy: true,
    });

    const environment = {
      STAGE: stage,
      LOG_LEVEL: "info",
      MESSAGES_TABLE: data.messages.tableName,
      CONNECTIONS_TABLE: data.connections.tableName,
      CHANNELS_TABLE: data.channels.tableName,
      ATTACHMENTS_BUCKET: props.attachments.bucketName,
      WS_ENDPOINT: this.webSocketStage.callbackUrl,
    };

    const fn = (name: Handler, extraEnv: Record<string, string> = {}) => {
      const functionName = `slack-${stage}-${name}`;
      return new NodejsFunction(this, `${name}Fn`, {
        functionName,
        entry: `${HANDLERS_DIR}${name}.ts`,
        handler: "handler",
        runtime: Runtime.NODEJS_20_X,
        architecture: Architecture.ARM_64,
        memorySize: 256,
        timeout: Duration.seconds(10),
        environment: { ...environment, ...extraEnv },
        projectRoot: REPO_ROOT,
        depsLockFilePath: `${REPO_ROOT}pnpm-lock.yaml`,
        bundling: { minify: true, sourceMap: false, target: "node20" },
        // Explicit log group (instead of the deprecated `logRetention`) so it is
        // removed together with the stack in dev.
        logGroup: new LogGroup(this, `${name}Logs`, {
          logGroupName: `/aws/lambda/${functionName}`,
          retention: RetentionDays.ONE_WEEK,
          removalPolicy: removalPolicyFor(stage),
        }),
      });
    };

    const authorizerFn = fn("authorizer", {
      USER_POOL_ID: props.auth.userPool.userPoolId,
      USER_POOL_CLIENT_ID: props.auth.userPoolClient.userPoolClientId,
    });
    const authorizer = new WebSocketLambdaAuthorizer("Authorizer", authorizerFn, {
      authorizerName: `slack-${stage}-authorizer`,
      identitySource: ["route.request.querystring.token"],
    });

    const handlers = {
      connect: fn("connect"),
      disconnect: fn("disconnect"),
      message: fn("message"),
      history: fn("history"),
      channel: fn("channel"),
      presign: fn("presign"),
      typing: fn("typing"),
    } satisfies Record<Exclude<Handler, "authorizer">, NodejsFunction>;

    const integration = (name: keyof typeof handlers) =>
      new WebSocketLambdaIntegration(`${name}Integration`, handlers[name]);

    this.webSocketApi.addRoute("$connect", { integration: integration("connect"), authorizer });
    this.webSocketApi.addRoute("$disconnect", { integration: integration("disconnect") });
    for (const action of CLIENT_ACTIONS) {
      this.webSocketApi.addRoute(action, { integration: integration(action) });
    }

    // --- Permissions -------------------------------------------------------
    const readWrite = (table: Table, ...grantees: NodejsFunction[]) =>
      grantees.forEach((g) => table.grantReadWriteData(g));

    data.connections.grantWriteData(handlers.connect);
    data.connections.grantWriteData(handlers.disconnect);

    // Broadcasters read live connections and delete stale ones (410 Gone).
    readWrite(data.connections, handlers.message, handlers.channel);
    data.messages.grantReadWriteData(handlers.message);
    data.channels.grantReadData(handlers.message);

    data.messages.grantReadData(handlers.history);
    readWrite(data.channels, handlers.channel);

    props.attachments.grantPut(handlers.presign);
    props.attachments.grantRead(handlers.presign);

    // Every handler that replies to the sender or broadcasts uses @connections.
    for (const h of [handlers.message, handlers.history, handlers.channel, handlers.presign]) {
      this.webSocketApi.grantManageConnections(h);
    }
  }
}
