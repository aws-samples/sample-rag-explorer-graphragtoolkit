#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { GraphRAGStack } from '../lib/graphrag-stack';

const app = new cdk.App();

new GraphRAGStack(app, 'GraphRAGStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-west-2',
  },
  embedding: {
    model: 'amazon.titan-embed-text-v2:0',
    size: 1024,
  },
});
