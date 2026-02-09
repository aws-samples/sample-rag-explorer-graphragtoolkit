# GraphRAG Demo - AWS Deployment Guide

This guide covers deploying the GraphRAG demo to AWS using CDK.

## Architecture

- **Frontend**: React app hosted on S3 + CloudFront
- **Query API**: Lambda (Docker) with Function URL
- **Document Processor**: Lambda (Docker) triggered by S3 events via SQS
- **Graph Database**: Neptune Analytics
- **Document Storage**: S3

## Prerequisites

1. AWS CLI configured with appropriate credentials
2. Node.js 18+ and npm
3. Docker (for building Lambda images)
4. CDK CLI: `npm install -g aws-cdk`

## Deployment Steps

### 1. Build the Frontend

```bash
cd ui
npm install
npm run build
cd ..
```

### 2. Deploy Infrastructure

```bash
cd infra
npm install
cdk bootstrap  # First time only
cdk deploy
```

### 3. Configure Frontend

After deployment, CDK outputs the API URL. Update `ui/.env`:

```bash
VITE_API_URL=<ApiURL from CDK output>
```

Then rebuild and redeploy:

```bash
cd ui
npm run build
cd ../infra
cdk deploy
```

## CDK Outputs

After deployment, you'll see:

- **FrontendURL**: CloudFront URL for the web app
- **ApiURL**: API Gateway URL for the backend API
- **DocumentsBucketName**: S3 bucket for document uploads
- **NeptuneGraphId**: Neptune Analytics graph ID
- **NeptuneGraphEndpoint**: Neptune Analytics endpoint

## Local Development

For local development, you can still run the original FastAPI app:

```bash
# Set environment variables
export GRAPH_STORE="neptune-graph://<NeptuneGraphId>"
export VECTOR_STORE="neptune-graph://<NeptuneGraphId>"
export S3_BUCKET="<DocumentsBucketName>"

# Run the API
cd app
uvicorn main:app --reload --port 8000
```

Then set `VITE_API_URL=http://localhost:8000` in the UI.

## Cleanup

```bash
cd infra
cdk destroy
```

## Cost Considerations

- Neptune Analytics: ~$0.10/GB-hour (128 GB minimum = ~$12.80/hour)
- Lambda: Pay per invocation
- S3: Pay per storage and requests
- CloudFront: Pay per request and data transfer

For development, consider destroying the stack when not in use.
