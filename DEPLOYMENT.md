# GraphRAG Demo — AWS Deployment Guide

## Architecture Overview

| Component | Service | Purpose |
|-----------|---------|---------|
| Frontend | S3 + CloudFront | React SPA hosting (Vite + Cloudscape) |
| Query API | Lambda (Docker) | GraphRAG and Vector RAG queries, per-query results |
| Upload API | Lambda (Docker) | Document upload, MD5 dedup, S3 storage, graph indexing |
| Graph + Vector Store | Neptune Analytics | Knowledge graph and vector embeddings (single store) |
| Auth | Cognito | User Pool + Identity Pool, SigV4 credentials |
| Document Storage | S3 | Raw documents under `private/{user_id}/{tenant_id}/documents/` |
| Document Registry | DynamoDB | Document metadata + MD5 dedup index (GSI) |

## Prerequisites

### Required Tools

```bash
node --version    # 18+ required
npm --version
docker --version  # For Lambda container images
aws --version
cdk --version     # npm install -g aws-cdk
```

### AWS Configuration

```bash
aws configure
aws sts get-caller-identity
```

Required IAM permissions: CloudFormation, Lambda, S3, DynamoDB, CloudFront, Cognito, Neptune Analytics, Bedrock, IAM role creation.

### Enable Bedrock Models

In the AWS Console → **Amazon Bedrock** → **Model access**, enable:
- **Claude 3 Sonnet** (or Claude 3.5 Sonnet) — extraction and response generation
- **Titan Text Embeddings V2** — vector embeddings (1024 dimensions)

## Deployment

### 1. Clone and Install

```bash
git clone <your-repo-url>
cd graphrag-neptune-analytics
cd infra
npm install
```

### 2. Bootstrap CDK (First Time Only)

```bash
cdk bootstrap
```

### 3. Deploy

```bash
cdk deploy
```

This deploys:
- Neptune Analytics graph (128 GB, public connectivity, vector search enabled)
- Document Processor Lambda (Docker, 3 GB RAM, 15 min timeout) with Function URL
- Query Handler Lambda (Docker, 3 GB RAM, 5 min timeout) with Function URL
- S3 buckets for documents and frontend
- DynamoDB table with MD5 GSI for document registry
- Cognito User Pool and Identity Pool
- CloudFront distribution with SPA error handling
- IAM roles: authenticated users get `lambda:InvokeFunctionUrl` + `lambda:InvokeFunction`
- Frontend built and deployed to S3 with `appconfig.json` runtime config

**Deployment time**: ~15-20 minutes (Neptune Analytics creation is the bottleneck).

### 4. Note the Outputs

```
GraphRAGStack.FrontendURL = https://xxxxxxxxxx.cloudfront.net
GraphRAGStack.QueryApiURL = https://xxx.lambda-url.us-west-2.on.aws/
GraphRAGStack.UploadApiURL = https://xxx.lambda-url.us-west-2.on.aws/
GraphRAGStack.DocumentsBucketName = graphragstack-documentsbucket-xxx
GraphRAGStack.NeptuneGraphId = g-xxxxxxxxxx
GraphRAGStack.UserPoolId = us-west-2_xxxxxxxxx
GraphRAGStack.UserPoolClientId = xxxxxxxxxxxxxxxxxxxxxxxxxx
GraphRAGStack.IdentityPoolId = us-west-2:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

## Frontend Configuration

The frontend is automatically configured during deployment. CDK generates `appconfig.json` and deploys it to S3:

```json
{
  "queryApiUrl": "<QueryApiURL>",
  "uploadApiUrl": "<UploadApiURL>",
  "region": "us-west-2",
  "bucketName": "<DocumentsBucketName>",
  "documentTableName": "<DocumentRegistryTableName>",
  "auth": {
    "user_pool_id": "<UserPoolId>",
    "user_pool_client_id": "<UserPoolClientId>",
    "identity_pool_id": "<IdentityPoolId>"
  }
}
```

No manual configuration needed for production deployments.

## API Endpoints

### Document Processor Lambda

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/upload-json` | POST | Upload document (base64 JSON body). Query params: `tenant_id`, `user_id` |
| `/documents` | GET | List user's documents. Query param: `user_id` |
| `/documents` | DELETE | Delete a document. Query params: `user_id`, `s3_path` |
| `/reset-graph` | POST | Reset Neptune graph + clean DynamoDB records. Query params: `tenant_id`, `user_id` |
| `/health` | GET | Health check |

### Query Handler Lambda

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/query` | POST | Query both Vector RAG and GraphRAG. Body: `{ query, tenant_id }`. Returns responses, vector_chunks, graph_nodes, graph_links |
| `/health` | GET | Health check |

## Supported File Types

- `.txt` — plain text, chunked with `SentenceSplitter` (512 chars, 50 overlap)
- `.md` — Markdown, parsed with `MarkdownNodeParser` then `SentenceSplitter`

PDF is not supported.

## Multi-Tenancy

- Each tenant's data is isolated via the graphrag-toolkit's `tenant_id` mechanism
- Tenant ID is hashed (`md5(tenant_id)[:10]`) before passing to the toolkit
- S3 path: `private/{user_id}/{tenant_id}/documents/`
- MD5 dedup is scoped to user + tenant + file content
- Graph reset cleans up both Neptune data and DynamoDB records for the tenant

## Updating the Deployment

After code changes (Lambda or frontend):

```bash
cd infra
cdk deploy
```

CDK rebuilds Docker images and the frontend automatically.

## Cleanup

```bash
cd infra
cdk destroy
```

This removes all resources including Neptune Analytics (and all graph data), Lambda functions, S3 buckets, DynamoDB table, Cognito pools, and CloudFront distribution.

If `cdk destroy` fails: empty S3 buckets manually in the console, then delete the CloudFormation stack.

## Troubleshooting

### Lambda Function URL 403 Errors

Since October 2025, Lambda Function URLs require both permissions:
- `lambda:InvokeFunctionUrl`
- `lambda:InvokeFunction`

The CDK stack includes both on the Cognito authenticated role. If you see 403 errors, verify the role has both permissions.

### CORS Errors

Lambda Function URLs handle CORS via their built-in configuration (not application middleware). The stack configures `allowedOrigins: ['*']` with the required SigV4 headers. Do not add custom CORS middleware in the Lambda apps.

### Neptune Analytics Connection

Neptune Analytics is configured with `publicConnectivity: true`. Lambda execution roles have `neptune-graph:*` permissions. The graph ID is passed via environment variables.

### Bedrock Access Denied

Go to AWS Console → Bedrock → Model access → enable Claude 3 Sonnet and Titan Text Embeddings V2. Wait a few minutes for propagation.

### "Already Processed" on Upload

The dedup check uses `md5(user_id + tenant_id + file_content)` against a DynamoDB GSI. If you reset the graph and want to re-upload the same files, the reset now also cleans up DynamoDB records for that tenant. If stale records remain, delete them via the UI's document list or directly in DynamoDB.

## Cost Optimization

- **Destroy the stack** when not actively using it — Neptune Analytics charges ~$12.80/hour for 128 GB minimum
- Lambda and Bedrock are pay-per-use
- S3/DynamoDB/CloudFront costs are minimal for demo usage
