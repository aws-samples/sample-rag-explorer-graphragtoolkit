# GraphRAG Neptune Analytics Demo

A production-ready demonstration comparing **GraphRAG** (Knowledge Graph-enhanced Retrieval Augmented Generation) with traditional **Vector-only RAG** approaches. Built on AWS using Neptune Analytics, Lambda, Cognito, and CloudFront.

## Why GraphRAG?

Traditional vector-based RAG finds content that is **semantically similar** to your question. But what about information that is **structurally relevant but semantically dissimilar**?

Consider this scenario:
- Example Corp sells Widgets with huge Christmas demand in the UK
- Example Corp partners with AnyCompany Logistics for shipping
- AnyCompany Logistics uses the Turquoise Canal to cut shipping times
- The Turquoise Canal is blocked by landslides

When asked *"What are the sales prospects for Example Corp in the UK?"*, vector search returns optimistic results about demand and partnerships. But it **misses** the supply chain disruption because "blocked canal" isn't semantically similar to "sales prospects."

GraphRAG solves this by:
1. Building a **knowledge graph** of entities and relationships
2. Using **entity networks** to find structurally connected information
3. Combining vector similarity with graph traversal for comprehensive retrieval

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│   CloudFront    │────▶│  S3 (Frontend)   │     │   Cognito Auth      │
│   Distribution  │     │  React + Vite    │     │   User Pool +       │
└─────────────────┘     └──────────────────┘     │   Identity Pool     │
                                                  └─────────────────────┘
        │                                                   │
        │ SigV4 Signed Requests                            │
        ▼                                                   ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  Query Handler  │────▶│ Neptune Analytics│◀────│ Document Processor  │
│  Lambda (Docker)│     │  Graph + Vector  │     │ Lambda (Docker)     │
└─────────────────┘     └──────────────────┘     └─────────────────────┘
                                                          │
                                                          ▼
                                                 ┌─────────────────────┐
                                                 │   S3 Documents +    │
                                                 │   DynamoDB Registry │
                                                 └─────────────────────┘
```

## Key Features

- **Side-by-Side Comparison**: Query both GraphRAG and Vector RAG simultaneously
- **Knowledge Graph Visualization**: Interactive D3.js visualization of entities and relationships
- **Document Upload**: Upload documents and watch the knowledge graph grow
- **Multi-Tenancy**: Isolated data per user/tenant
- **Secure by Default**: Cognito authentication with SigV4 signed API requests
- **Serverless**: Pay-per-use with Lambda and Neptune Analytics

## How It Works

### Indexing (Document Processing)

1. **Load**: Documents are uploaded to S3
2. **Chunk**: Text is split into manageable chunks
3. **Extract**: LLM extracts propositions, topics, entities, and facts
4. **Build**: Creates a hierarchical lexical graph with vector embeddings

The lexical graph has three tiers:
- **Source/Chunk Tier**: Documents and their chunks
- **Topic/Statement Tier**: Extracted topics and statements
- **Entity/Fact Tier**: Named entities and their relationships

### Querying

1. **Embed**: Create embedding for the user question
2. **Vector Search**: Find semantically similar chunks (entry points)
3. **Graph Traversal**: Follow entity networks to find related content
4. **Generate**: LLM synthesizes response from retrieved context

GraphRAG uses **entity networks** - one or two-hop neighborhoods around key entities - to discover structurally relevant but semantically dissimilar information.

## Quick Start

### Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js 18+ and npm
- Docker (for Lambda images)
- CDK CLI: `npm install -g aws-cdk`

### Deploy

```bash
# Clone the repository
git clone git@ssh.gitlab.aws.dev:adichap/graphrag-neptune-analytics.git
cd graphrag-neptune-analytics

# Deploy infrastructure
cd infra
npm install
cdk bootstrap  # First time only
DOCKER_BUILDKIT=1 npx cdk deploy --require-approval never
```

The deployment outputs include:
- **FrontendURL**: Your CloudFront URL
- **QueryApiURL**: Query Lambda Function URL
- **UploadApiURL**: Upload Lambda Function URL

### Use the Demo

1. Open the **FrontendURL** in your browser
2. Create an account or sign in
3. Upload a document (PDF or TXT)
4. Ask questions and compare GraphRAG vs Vector RAG responses
5. Explore the knowledge graph visualization

## Project Structure

```
├── app/                    # Local development FastAPI app
├── infra/                  # CDK infrastructure
│   ├── bin/               # CDK app entry point
│   ├── lib/               # Stack definition
│   └── lambda/            # Lambda function code
│       ├── document-processor/  # Upload & indexing
│       └── query-handler/       # Query API
├── ui/                     # React frontend
│   └── src/
│       ├── components/    # Reusable components
│       ├── pages/         # Page components
│       └── context/       # React context
└── README.md
```

## Technology Stack

- **Graph Database**: Amazon Neptune Analytics (graph + vector in one)
- **LLM**: Amazon Bedrock (Claude for extraction/generation, Titan for embeddings)
- **Compute**: AWS Lambda (Docker containers)
- **Auth**: Amazon Cognito (User Pool + Identity Pool)
- **Frontend**: React + Vite + Cloudscape Design System
- **CDN**: Amazon CloudFront
- **Storage**: Amazon S3 + DynamoDB
- **IaC**: AWS CDK (TypeScript)

## Cost Considerations

- **Neptune Analytics**: ~$0.10/GB-hour (128 GB minimum ≈ $12.80/hour)
- **Lambda**: Pay per invocation and duration
- **Bedrock**: Pay per token (extraction + generation)
- **S3/DynamoDB/CloudFront**: Minimal for demo usage

**Tip**: Destroy the stack when not in use to avoid Neptune Analytics charges.

```bash
cd infra
cdk destroy
```

## Learn More

This demo is based on the [GraphRAG Toolkit](https://github.com/awslabs/graphrag-toolkit) and concepts from the GraphRAG Workshop.

Key concepts:
- **Lexical Graph**: Three-tiered structure (Source → Topic → Entity)
- **Entity Networks**: Graph neighborhoods for context expansion
- **Multi-Tenancy**: Isolated graphs within shared infrastructure
- **Traversal-Based Search**: Combining vector similarity with graph traversal

## License

This project is licensed under the MIT License.
