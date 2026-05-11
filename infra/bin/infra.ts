#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { GraphRAGStack } from '../lib/graphrag-stack';

// Load .env from the repo root so model overrides can live alongside other settings
dotenv.config({ path: path.join(__dirname, '../../.env') });

const app = new cdk.App();

// Defaults point at current GA Bedrock cross-region inference profiles. Override via env
// vars (EXTRACTION_MODEL, RESPONSE_MODEL, EMBEDDINGS_MODEL, EMBEDDINGS_DIMENSIONS) if needed.
const extractionModel = process.env.EXTRACTION_MODEL || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const responseModel = process.env.RESPONSE_MODEL || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const embeddingModel = process.env.EMBEDDINGS_MODEL || 'amazon.titan-embed-text-v2:0';
const embeddingSize = Number(process.env.EMBEDDINGS_DIMENSIONS || '1024');

new GraphRAGStack(app, 'GraphRAGStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEPLOY_REGION || 'us-west-2',
  },
  embedding: {
    model: embeddingModel,
    size: embeddingSize,
  },
  models: {
    extractionModel,
    responseModel,
  },
});
