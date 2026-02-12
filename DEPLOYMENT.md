# GraphRAG Demo - AWS Deployment Guide

Complete guide for deploying the GraphRAG Neptune Analytics demo to AWS.

## Architecture Overview

| Component | Service | Purpose |
|-----------|---------|---------|
| Frontend | S3 + CloudFront | React SPA hosting |
| Query API | Lambda (Docker) | GraphRAG and Vector queries |
| Upload API | Lambda (Docker) | Document processing and indexing |
| Graph + Vector Store | Neptune Analytics | Knowledge graph and embeddings |
| Auth | Cognito | User authentication and IAM credentials |
| Document Storage | S3 | Raw document storage |
| Document Registry | DynamoDB | User document metadata |

## Prerequisites

### Required Tools

```bash
# Check Node.js (18+ required)
node --version

# Check npm
npm --version

# Check Docker
docker --version

# Check AWS CLI
aws --version

# Install CDK CLI
npm install -g aws-cdk
cdk --version
```

### AWS Configuration

```bash
# Configure AWS credentials
aws configure

# Verify access
aws sts get-caller-identity
```

Required IAM permissions:
- CloudFormation full access
- Lambda, S3, DynamoDB, CloudFront, Cognito management
- Neptune Analytics management
- Bedrock model access
- IAM role creation

### Enable Bedrock Models

In the AWS Console, navigate to **Amazon Bedrock** → **Model access** and enable:
- **Claude 3 Sonnet** (or Claude 3.5 Sonnet) - for extraction and generation
- **Titan Text Embeddings V2** - for vector embeddings

## Deployment Steps

### 1. Clone and Install

```bash
git clone git@ssh.gitlab.aws.dev:adichap/graphrag-neptune-analytics.git
cd graphrag-neptune-analytics

# Install infrastructure dependencies
cd infra
npm install
```

### 2. Bootstrap CDK (First Time Only)

```bash
cdk bootstrap
```

### 3. Deploy the Stack

```bash
DOCKER_BUILDKIT=1 npx cdk deploy --require-approval never
```

This deploys:
- Neptune Analytics graph (128 GB, public connectivity)
- Document Processor Lambda with Function URL
- Query Handler Lambda with Function URL
- S3 buckets for documents and frontend
- DynamoDB table for document registry
- Cognito User Pool and Identity Pool
- CloudFront distribution
- IAM roles and policies

**Deployment time**: ~15-20 minutes (Neptune Analytics creation takes the longest)

### 4. Note the Outputs

After deployment, CDK outputs:

```
Outputs:
GraphRAGStack.FrontendURL = https://d1iz456wqetrpu.cloudfront.net
GraphRAGStack.QueryApiURL = https://xxx.lambda-url.us-west-2.on.aws/
GraphRAGStack.UploadApiURL = https://xxx.lambda-url.us-west-2.on.aws/
GraphRAGStack.DocumentsBucketName = graphragstack-documentsbucket-xxx
GraphRAGStack.NeptuneGraphId = g-xxxxxxxxxx
GraphRAGStack.UserPoolId = us-west-2_xxxxxxxxx
GraphRAGStack.UserPoolClientId = xxxxxxxxxxxxxxxxxxxxxxxxxx
GraphRAGStack.IdentityPoolId = us-west-2:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

## Configuration

### Frontend Configuration

The frontend is automatically configured during deployment. The `appconfig.json` file is generated and deployed to S3 with:

```json
{
  "queryApiUrl": "<QueryApiURL>",
  "uploadApiUrl": "<UploadApiURL>",
  "region": "us-west-2",
  "bucketName": "<DocumentsBucketName>",
  "auth": {
    "user_pool_id": "<UserPoolId>",
    "user_pool_client_id": "<UserPoolClientId>",
    "identity_pool_id": "<IdentityPoolId>"
  }
}
```

### Embedding Model Configuration

The stack uses Titan Text Embeddings V2 (1024 dimensions) by default. To change:

Edit `infra/bin/infra.ts`:

```typescript
new GraphRAGStack(app, 'GraphRAGStack', {
  embedding: {
    model: 'amazon.titan-embed-text-v2:0',
    size: 1024,
  },
  // ...
});
```

## Local Development

### Running the Local API

```bash
# Set environment variables
export GRAPH_STORE="neptune-graph://<NeptuneGraphId>"
export VECTOR_STORE="neptune-graph://<NeptuneGraphId>"
export S3_BUCKET="<DocumentsBucketName>"
export DOCUMENT_TABLE="<DocumentRegistryTableName>"

# Run the API
cd app
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### Running the Frontend Locally

```bash
cd ui

# Create .env file
cat > .env << EOF
VITE_QUERY_API_URL=http://localhost:8000
VITE_UPLOAD_API_URL=http://localhost:8000
EOF

npm install
npm run dev
```

## Updating the Deployment

### Code Changes

After modifying Lambda code or frontend:

```bash
cd infra
DOCKER_BUILDKIT=1 npx cdk deploy --require-approval never
```

### Infrastructure Changes

CDK handles infrastructure updates automatically. For Neptune Analytics changes that require replacement, data will be lost.

## Cleanup

### Destroy the Stack

```bash
cd infra
cdk destroy
```

This removes all resources including:
- Neptune Analytics graph (and all data)
- Lambda functions
- S3 buckets (auto-deleted with contents)
- DynamoDB table
- Cognito pools
- CloudFront distribution

### Manual Cleanup (if needed)

If `cdk destroy` fails:

1. Empty S3 buckets manually in the console
2. Delete CloudFormation stack from the console
3. Check for orphaned Neptune Analytics graphs

## Troubleshooting

### Lambda Function URL 403 Errors

Since October 2025, Lambda Function URLs require both permissions:
- `lambda:InvokeFunctionUrl`
- `lambda:InvokeFunction`

The CDK stack includes both. If you see 403 errors, verify the Cognito authenticated role has both permissions.

### CORS Errors

Lambda Function URLs handle CORS via configuration (not middleware). The stack configures:
- `allowedOrigins: ['*']`
- `allowedHeaders: ['x-amz-security-token', 'x-amz-date', 'x-amz-content-sha256', 'content-type', 'accept', 'authorization']`
- `allowCredentials: true`

### Neptune Analytics Connection Issues

Neptune Analytics is configured with `publicConnectivity: true`. Ensure:
- Your Lambda execution role has `neptune-graph:*` permissions
- The graph ID in environment variables is correct

### Bedrock Model Access

If you see "Access denied" errors for Bedrock:
1. Go to AWS Console → Bedrock → Model access
2. Enable the required models (Claude, Titan Embeddings)
3. Wait a few minutes for propagation

## Cost Optimization

### Development

- Use `cdk destroy` when not actively developing
- Neptune Analytics charges ~$12.80/hour for 128 GB minimum

### Production

- Consider reserved capacity for Neptune Analytics
- Enable CloudFront caching for static assets
- Use Bedrock batch inference for large document sets

## Security Considerations

- All API calls require Cognito authentication
- Lambda Function URLs use AWS_IAM auth type
- S3 documents are isolated per user (cognito-identity.amazonaws.com:sub)
- DynamoDB access is scoped to user's own records
- No public endpoints except CloudFront (which serves static files only)
