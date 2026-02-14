import os
import concurrent.futures
from concurrent.futures import ThreadPoolExecutor

# Monkey-patch ProcessPoolExecutor to avoid multiprocessing issues in Lambda
original_ProcessPoolExecutor = concurrent.futures.ProcessPoolExecutor
concurrent.futures.ProcessPoolExecutor = ThreadPoolExecutor

import concurrent.futures.process
concurrent.futures.process.ProcessPoolExecutor = ThreadPoolExecutor

os.environ['TOKENIZERS_PARALLELISM'] = 'false'
os.environ['OMP_NUM_THREADS'] = '1'
os.environ['MKL_NUM_THREADS'] = '1'
os.environ['PYTHONHASHSEED'] = '0'

import tempfile
import hashlib
import boto3
from datetime import datetime
from typing import Optional, List
from decimal import Decimal

from fastapi import FastAPI, UploadFile, File, HTTPException, Query
from pydantic import BaseModel
from boto3.dynamodb.conditions import Key

from graphrag_toolkit.lexical_graph import LexicalGraphIndex, IndexingConfig
from graphrag_toolkit.lexical_graph.storage import GraphStoreFactory, VectorStoreFactory
from llama_index.core import SimpleDirectoryReader
from llama_index.core.node_parser import SentenceSplitter, MarkdownNodeParser

# Environment variables
S3_BUCKET = os.environ.get('S3_BUCKET')
GRAPH_STORE_CONFIG = os.environ.get('GRAPH_STORE')
VECTOR_STORE_CONFIG = os.environ.get('VECTOR_STORE')
DOCUMENT_TABLE = os.environ.get('DOCUMENT_TABLE')
NEPTUNE_GRAPH_ID = os.environ.get('NEPTUNE_GRAPH_ID')

s3_client = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
neptune_client = boto3.client('neptune-graph')

app = FastAPI(title="GraphRAG Document Processor")


# ==================== HELPERS ====================

def get_tenant_hash(tenant_id: str) -> str:
    return hashlib.md5(tenant_id.encode()).hexdigest()[:10].lower()


def calculate_md5(file_content: bytes, user_id: str, tenant_id: str = '') -> str:
    """Calculate MD5 hash of file content + user_id + tenant_id for dedup."""
    h = hashlib.md5()
    h.update(user_id.encode('utf-8'))
    h.update(tenant_id.encode('utf-8'))
    h.update(file_content)
    return h.hexdigest()


def is_file_processed(md5_hash: str) -> bool:
    """Check if a file with this MD5 has already been processed."""
    if not DOCUMENT_TABLE:
        return False
    table = dynamodb.Table(DOCUMENT_TABLE)
    response = table.query(
        IndexName='md5-index',
        KeyConditionExpression=Key('md5').eq(md5_hash)
    )
    return len(response.get('Items', [])) > 0


def save_document_metadata(user_id: str, tenant_id: str, s3_path: str, filename: str,
                           size: int, md5: str, chunks: int, status: str = 'completed'):
    """Save document metadata to DynamoDB."""
    if not DOCUMENT_TABLE:
        return
    table = dynamodb.Table(DOCUMENT_TABLE)
    table.put_item(Item={
        'userId': user_id,
        's3Path': s3_path,
        'tenantId': tenant_id,
        'fileName': filename,
        'size': size,
        'md5': md5,
        'uploadedAt': datetime.utcnow().isoformat(),
        'chunksCreated': chunks,
        'status': status,
    })


def get_user_documents(user_id: str) -> List[dict]:
    if not DOCUMENT_TABLE:
        return []
    table = dynamodb.Table(DOCUMENT_TABLE)
    response = table.query(
        KeyConditionExpression=Key('userId').eq(user_id)
    )
    items = []
    for item in response.get('Items', []):
        converted = {}
        for k, v in item.items():
            converted[k] = int(v) if isinstance(v, Decimal) else v
        items.append(converted)
    return items


# ==================== INDEXING ====================

def index_single_document(file_content: bytes, filename: str, tenant_id: str) -> dict:
    """Index a single document into the graph (additive per tenant)."""
    tenant_hash = get_tenant_hash(tenant_id)

    is_md = filename.lower().endswith('.md')
    suffix = '.md' if is_md else '.txt'

    with tempfile.NamedTemporaryFile(mode='wb', suffix=suffix, delete=False) as tmp:
        tmp.write(file_content)
        tmp_path = tmp.name

    try:
        if is_md:
            chunking = [MarkdownNodeParser(), SentenceSplitter(chunk_size=512, chunk_overlap=50)]
        else:
            chunking = [SentenceSplitter(chunk_size=512, chunk_overlap=50)]

        with (
            GraphStoreFactory.for_graph_store(GRAPH_STORE_CONFIG) as graph_store,
            VectorStoreFactory.for_vector_store(VECTOR_STORE_CONFIG, index_names=['chunk']) as vector_store
        ):
            config = IndexingConfig(chunking=chunking)
            graph_index = LexicalGraphIndex(
                graph_store,
                vector_store,
                tenant_id=tenant_hash,
                indexing_config=config
            )

            reader = SimpleDirectoryReader(
                input_files=[tmp_path],
                file_metadata=lambda p: {'file_name': filename}
            )
            docs = reader.load_data()

            # Count chunks for reporting
            splitter = SentenceSplitter(chunk_size=512, chunk_overlap=50)
            chunk_count = len(splitter.get_nodes_from_documents(docs))

            graph_index.extract_and_build(nodes=docs, show_progress=False)

            return {"chunks_created": chunk_count, "tenant_hash": tenant_hash}
    finally:
        os.unlink(tmp_path)


# ==================== API ROUTES ====================

@app.get("/")
async def root():
    return {"message": "GraphRAG Document Processor", "status": "running"}


@app.get("/health")
async def health_check():
    return {"status": "healthy"}


class Base64FileUpload(BaseModel):
    fileName: str
    fileContent: str  # base64 encoded
    contentType: Optional[str] = None


async def process_and_index_file(
    filename: str,
    file_content: bytes,
    content_type: str,
    tenant_id: str,
    user_id: str
) -> dict:
    """Upload file to S3, check for duplicates, index only if new."""
    if not filename.lower().endswith(('.txt', '.md')):
        raise HTTPException(status_code=400, detail="Only TXT and MD files are supported")

    file_size = len(file_content)
    file_md5 = calculate_md5(file_content, user_id, tenant_id)

    if is_file_processed(file_md5):
        return {
            "message": "Document already processed, skipping indexing",
            "filename": filename,
            "tenant_id": tenant_id,
            "already_processed": True,
            "chunks_created": 0,
        }

    # Upload to S3
    s3_key = None
    if S3_BUCKET:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        s3_key = f"private/{user_id}/{tenant_id}/documents/{timestamp}_{filename}"
        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=s3_key,
            Body=file_content,
            ContentType=content_type
        )

    try:
        index_result = index_single_document(file_content, filename, tenant_id)
    except Exception as e:
        # Remove S3 object on indexing failure so user can retry
        if S3_BUCKET and s3_key:
            try:
                s3_client.delete_object(Bucket=S3_BUCKET, Key=s3_key)
            except Exception:
                pass
        raise e

    # Save to DynamoDB after successful indexing
    if s3_key:
        save_document_metadata(
            user_id=user_id,
            tenant_id=tenant_id,
            s3_path=s3_key,
            filename=filename,
            size=file_size,
            md5=file_md5,
            chunks=index_result["chunks_created"]
        )

    return {
        "message": "Document uploaded and indexed successfully",
        "filename": filename,
        "s3_key": s3_key,
        "tenant_id": tenant_id,
        "user_id": user_id,
        "chunks_created": index_result["chunks_created"],
        "already_processed": False,
    }


@app.post("/upload")
async def upload_document(
    tenant_id: str = Query(default="default"),
    user_id: str = Query(default="anonymous"),
    file: UploadFile = File(...),
):
    """Upload document (TXT/MD) via multipart form data"""
    try:
        filename = file.filename
        file_content = await file.read()
        content_type = file.content_type or 'application/octet-stream'
        return await process_and_index_file(filename, file_content, content_type, tenant_id, user_id)
    except HTTPException:
        raise
    except Exception as e:
        print(f"Upload error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/upload-json")
async def upload_document_json(
    data: Base64FileUpload,
    tenant_id: str = Query(default="default"),
    user_id: str = Query(default="anonymous"),
):
    """Upload document via JSON with base64 encoded content (for signed requests)"""
    import base64
    try:
        filename = data.fileName
        file_content = base64.b64decode(data.fileContent)
        content_type = data.contentType or 'application/octet-stream'
        return await process_and_index_file(filename, file_content, content_type, tenant_id, user_id)
    except HTTPException:
        raise
    except Exception as e:
        print(f"Upload JSON error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/documents")
async def list_documents(user_id: str = Query(...)):
    """List all documents for a user"""
    try:
        documents = get_user_documents(user_id)
        return {"documents": documents, "count": len(documents)}
    except Exception as e:
        print(f"List documents error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/reset-graph")
async def reset_graph(
    user_id: str = Query(default=""),
):
    """Full reset: clear Neptune graph, delete all DynamoDB records and S3 files for the user."""
    try:
        try:
            response = neptune_client.execute_query(
                graphIdentifier=NEPTUNE_GRAPH_ID,
                queryString="MATCH (n) DETACH DELETE n",
                language='OPEN_CYPHER'
            )
            print(f"Reset graph response: {response}")
        except Exception as e:
            print(f"Neptune API delete failed: {e}")
            with GraphStoreFactory.for_graph_store(GRAPH_STORE_CONFIG) as graph_store:
                graph_store.execute_query("MATCH (n) DETACH DELETE n", {})

        # Clean up S3 files and DynamoDB records
        deleted_s3 = 0
        deleted_dynamo = 0
        if DOCUMENT_TABLE and user_id:
            try:
                docs = get_user_documents(user_id)
                table = dynamodb.Table(DOCUMENT_TABLE)
                for doc in docs:
                    s3_path = doc.get('s3Path', '')
                    if S3_BUCKET and s3_path:
                        try:
                            s3_client.delete_object(Bucket=S3_BUCKET, Key=s3_path)
                            deleted_s3 += 1
                        except Exception as e:
                            print(f"S3 delete error for {s3_path}: {e}")
                    table.delete_item(Key={'userId': user_id, 's3Path': s3_path})
                    deleted_dynamo += 1
            except Exception as e:
                print(f"Cleanup error: {e}")

        return {
            "message": "Full reset completed",
            "deleted_s3_files": deleted_s3,
            "deleted_dynamo_records": deleted_dynamo,
        }
    except Exception as e:
        print(f"Reset graph error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
