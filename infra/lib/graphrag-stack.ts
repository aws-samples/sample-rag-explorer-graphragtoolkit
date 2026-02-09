import {
  Stack,
  StackProps,
  RemovalPolicy,
  Duration,
  CfnOutput,
  DockerImage,
  aws_lambda as lambda,
  aws_iam as iam,
  aws_s3 as s3,
  aws_s3_deployment as s3Deploy,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_neptunegraph as neptune,
  aws_dynamodb as dynamodb,
} from 'aws-cdk-lib';
import { AmplifyAuth } from '@aws-amplify/auth-construct';
import * as path from 'path';
import { Construct } from 'constructs';
import { execSync } from 'child_process';
import * as fs from 'fs';

interface EmbeddingProps {
  model: string;
  size: number;
}

export interface GraphRAGStackProps extends StackProps {
  embedding: EmbeddingProps;
}

export class GraphRAGStack extends Stack {
  constructor(scope: Construct, id: string, props: GraphRAGStackProps) {
    super(scope, id, props);

    const { embedding } = props;

    // ==================== COGNITO AUTH ====================

    const auth = new AmplifyAuth(this, 'Auth', {
      loginWith: { email: true },
    });

    const userPoolId = auth.resources.userPool.userPoolId;
    const userPoolClientId = auth.resources.userPoolClient.userPoolClientId;
    const identityPoolId = auth.resources.cfnResources.cfnIdentityPool.ref;

    // ==================== DYNAMODB - DOCUMENT REGISTRY ====================

    const documentRegistryTable = new dynamodb.Table(this, 'DocumentRegistryTable', {
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 's3Path', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // GSI for querying by document hash (to check duplicates)
    documentRegistryTable.addGlobalSecondaryIndex({
      indexName: 'md5-index',
      partitionKey: { name: 'md5', type: dynamodb.AttributeType.STRING },
    });

    // ==================== S3 BUCKETS ====================

    const documentsBucket = new s3.Bucket(this, 'DocumentsBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.DELETE],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
        },
      ],
    });

    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // ==================== NEPTUNE ANALYTICS ====================

    const neptuneGraph = new neptune.CfnGraph(this, 'GraphRAGNeptuneGraph', {
      graphName: `graphrag-${this.stackName.toLowerCase()}`,
      provisionedMemory: 128,
      publicConnectivity: true,
      vectorSearchConfiguration: {
        vectorSearchDimension: embedding.size,
      },
      deletionProtection: false,
    });

    // ==================== DOCUMENT PROCESSOR LAMBDA (Upload + Indexing) ====================

    const documentProcessorLambda = new lambda.DockerImageFunction(this, 'DocumentProcessorLambda', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../lambda/document-processor'), {
        platform: 'linux/amd64' as any,
      }),
      architecture: lambda.Architecture.X86_64,
      memorySize: 3008,
      timeout: Duration.minutes(15),
      environment: {
        S3_BUCKET: documentsBucket.bucketName,
        NEPTUNE_GRAPH_ID: neptuneGraph.attrGraphId,
        GRAPH_STORE: `neptune-graph://${neptuneGraph.attrGraphId}`,
        VECTOR_STORE: `neptune-graph://${neptuneGraph.attrGraphId}`,
        EMBEDDING_MODEL: embedding.model,
        DOCUMENT_TABLE: documentRegistryTable.tableName,
      },
    });

    documentsBucket.grantReadWrite(documentProcessorLambda);
    documentRegistryTable.grantReadWriteData(documentProcessorLambda);

    documentProcessorLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'neptune-graph:*',
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:Converse',
          'bedrock:ConverseStream',
          'bedrock:ListFoundationModels',
          'aws-marketplace:ViewSubscriptions',
          'aws-marketplace:Subscribe',
        ],
        resources: ['*'],
      })
    );

    // Document Processor Function URL (AWS_IAM auth - requires signed requests)
    const uploadFunctionUrl = documentProcessorLambda.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      cors: {
        allowCredentials: true,
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.ALL],
        allowedHeaders: ['x-amz-security-token', 'x-amz-date', 'x-amz-content-sha256', 'content-type', 'accept', 'authorization'],
      },
    });

    // ==================== QUERY HANDLER LAMBDA ====================

    const queryHandlerLambda = new lambda.DockerImageFunction(this, 'QueryHandlerLambda', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../lambda/query-handler'), {
        platform: 'linux/amd64' as any,
      }),
      architecture: lambda.Architecture.X86_64,
      memorySize: 3008,
      timeout: Duration.minutes(5),
      environment: {
        NEPTUNE_GRAPH_ID: neptuneGraph.attrGraphId,
        GRAPH_STORE: `neptune-graph://${neptuneGraph.attrGraphId}`,
        VECTOR_STORE: `neptune-graph://${neptuneGraph.attrGraphId}`,
        EMBEDDING_MODEL: embedding.model,
      },
    });

    queryHandlerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'neptune-graph:*',
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:Converse',
          'bedrock:ConverseStream',
          'bedrock:ListFoundationModels',
          'aws-marketplace:ViewSubscriptions',
          'aws-marketplace:Subscribe',
        ],
        resources: ['*'],
      })
    );

    // Query Handler Function URL (AWS_IAM auth - requires signed requests)
    const queryFunctionUrl = queryHandlerLambda.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      cors: {
        allowCredentials: true,
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.ALL],
        allowedHeaders: ['x-amz-security-token', 'x-amz-date', 'x-amz-content-sha256', 'content-type', 'accept', 'authorization'],
      },
    });

    // ==================== IAM POLICIES FOR AUTHENTICATED USERS ====================

    // Policy to invoke Lambda Function URLs (requires both permissions since Oct 2025)
    auth.resources.authenticatedUserIamRole.attachInlinePolicy(
      new iam.Policy(this, 'AuthUserLambdaInvokePolicy', {
        statements: [
          new iam.PolicyStatement({
            actions: ['lambda:InvokeFunctionUrl', 'lambda:InvokeFunction'],
            resources: [
              documentProcessorLambda.functionArn,
              queryHandlerLambda.functionArn,
            ],
          }),
        ],
      })
    );

    // Policy for S3 access (user-isolated paths)
    auth.resources.authenticatedUserIamRole.attachInlinePolicy(
      new iam.Policy(this, 'AuthUserS3Policy', {
        statements: [
          new iam.PolicyStatement({
            actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
            resources: [
              documentsBucket.arnForObjects('private/${cognito-identity.amazonaws.com:sub}/*'),
            ],
          }),
          new iam.PolicyStatement({
            actions: ['s3:ListBucket'],
            resources: [documentsBucket.bucketArn],
            conditions: {
              StringLike: {
                's3:prefix': ['private/${cognito-identity.amazonaws.com:sub}/*'],
              },
            },
          }),
        ],
      })
    );

    // Policy for DynamoDB access (user-isolated)
    auth.resources.authenticatedUserIamRole.attachInlinePolicy(
      new iam.Policy(this, 'AuthUserDynamoDBPolicy', {
        statements: [
          new iam.PolicyStatement({
            actions: ['dynamodb:Query', 'dynamodb:GetItem'],
            resources: [documentRegistryTable.tableArn],
            conditions: {
              'ForAllValues:StringEquals': {
                'dynamodb:LeadingKeys': ['${cognito-identity.amazonaws.com:sub}'],
              },
            },
          }),
        ],
      })
    );

    // ==================== CLOUDFRONT ====================

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    // ==================== FRONTEND DEPLOYMENT WITH BUNDLING ====================

    const uiPath = path.join(__dirname, '../../ui');

    // Build UI at deploy time with bundling
    const uiAsset = s3Deploy.Source.asset(uiPath, {
      bundling: {
        image: DockerImage.fromRegistry('public.ecr.aws/sam/build-nodejs20.x:latest'),
        command: [
          'sh', '-c', [
            'npm --cache /tmp/.npm install',
            'npm --cache /tmp/.npm run build',
            'cp -aur /asset-input/dist/* /asset-output/',
          ].join(' && '),
        ],
        local: {
          tryBundle(outputDir: string): boolean {
            try {
              execSync('npm --version', { stdio: 'pipe' });
              execSync('npm install', { cwd: uiPath, stdio: 'inherit' });
              execSync('npm run build', { cwd: uiPath, stdio: 'inherit' });
              const distPath = path.join(uiPath, 'dist');
              if (fs.existsSync(distPath)) {
                execSync(`cp -r ${distPath}/* ${outputDir}`, { stdio: 'inherit' });
                return true;
              }
              return false;
            } catch {
              return false;
            }
          },
        },
      },
    });

    // Create appconfig.json with runtime configuration
    const appConfig = {
      queryApiUrl: queryFunctionUrl.url,
      uploadApiUrl: uploadFunctionUrl.url,
      region: this.region,
      bucketName: documentsBucket.bucketName,
      documentTableName: documentRegistryTable.tableName,
      auth: {
        user_pool_id: userPoolId,
        user_pool_client_id: userPoolClientId,
        identity_pool_id: identityPoolId,
      },
    };

    const configAsset = s3Deploy.Source.jsonData('appconfig.json', appConfig);

    new s3Deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [uiAsset, configAsset],
      destinationBucket: frontendBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // ==================== OUTPUTS ====================

    new CfnOutput(this, 'FrontendURL', {
      value: `https://${distribution.distributionDomainName}`,
    });

    new CfnOutput(this, 'QueryApiURL', {
      value: queryFunctionUrl.url,
      description: 'Query API endpoint (for /query and /health)',
    });

    new CfnOutput(this, 'UploadApiURL', {
      value: uploadFunctionUrl.url,
      description: 'Upload API endpoint (for /upload)',
    });

    new CfnOutput(this, 'DocumentsBucketName', {
      value: documentsBucket.bucketName,
    });

    new CfnOutput(this, 'DocumentRegistryTableName', {
      value: documentRegistryTable.tableName,
    });

    new CfnOutput(this, 'NeptuneGraphId', {
      value: neptuneGraph.attrGraphId,
    });

    new CfnOutput(this, 'UserPoolId', {
      value: userPoolId,
    });

    new CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClientId,
    });

    new CfnOutput(this, 'IdentityPoolId', {
      value: identityPoolId,
    });
  }
}
