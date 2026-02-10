import os
import concurrent.futures
from concurrent.futures import ThreadPoolExecutor

# Monkey patch ProcessPoolExecutor to avoid multiprocessing issues in Lambda
original_ProcessPoolExecutor = concurrent.futures.ProcessPoolExecutor
concurrent.futures.ProcessPoolExecutor = ThreadPoolExecutor

# Also patch in the process module
import concurrent.futures.process
concurrent.futures.process.ProcessPoolExecutor = ThreadPoolExecutor

# Disable multiprocessing/threading for Lambda compatibility
os.environ['TOKENIZERS_PARALLELISM'] = 'false'
os.environ['OMP_NUM_THREADS'] = '1'
os.environ['MKL_NUM_THREADS'] = '1'
os.environ['PYTHONHASHSEED'] = '0'

import json
import tempfile
import hashlib
import boto3
from datetime import datetime
from typing import Optional, List
from decimal import Decimal

from fastapi import FastAPI, UploadFile, File, HTTPException, Form, Query
from pydantic import BaseModel

from PyPDF2 import PdfReader

from graphrag_toolkit.lexical_graph import LexicalGraphIndex, IndexingConfig
from graphrag_toolkit.lexical_graph.storage import GraphStoreFactory, VectorStoreFactory
from llama_index.core import SimpleDirectoryReader
from llama_index.core.node_parser import SentenceSplitter

# Environment variables
S3_BUCKET = os.environ.get('S3_BUCKET')
GRAPH_STORE_CONFIG = os.environ.get('GRAPH_STORE')
VECTOR_STORE_CONFIG = os.environ.get('VECTOR_STORE')
DOCUMENT_TABLE = os.environ.get('DOCUMENT_TABLE')
NEPTUNE_GRAPH_ID = os.environ.get('NEPTUNE_GRAPH_ID')

s3_client = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
neptune_client = boto3.client('neptune-graph')

# FastAPI app
app = FastAPI(title="GraphRAG Document Processor")


class DocumentInfo(BaseModel):
    userId: str
    s3Path: str
    filename: str
    size: int
    md5: str
    uploadedAt: str
    chunksCreated: int


def get_tenant_hash(tenant_id: str) -> str:
    """Generate consistent tenant hash"""
    return hashlib.md5(tenant_id.encode()).hexdigest()[:10].lower()


def extract_pdf_text(content: bytes) -> str:
    """Extract text from PDF"""
    with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name
    try:
        reader = PdfReader(tmp_path)
        return "".join(page.extract_text() + "\n" for page in reader.pages)
    finally:
        os.unlink(tmp_path)


def index_document(text: str, filename: str, tenant_id: str) -> dict:
    """Index document text into Neptune graph"""
    tenant_hash = get_tenant_hash(tenant_id)
    
    # Save to temp file for processing
    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as tmp:
        tmp.write(text)
        tmp_path = tmp.name
    
    try:
        with (
            GraphStoreFactory.for_graph_store(GRAPH_STORE_CONFIG) as graph_store,
            VectorStoreFactory.for_vector_store(VECTOR_STORE_CONFIG, index_names=['chunk']) as vector_store
        ):
            splitter = SentenceSplitter(chunk_size=512, chunk_overlap=50)
            config = IndexingConfig(chunking=[splitter])
            
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
            
            # Get actual chunk count by running the splitter
            chunks = splitter.get_nodes_from_documents(docs)
            chunk_count = len(chunks)
            
            graph_index.extract_and_build(nodes=docs, show_progress=False)
            
            return {"chunks_created": chunk_count, "tenant_hash": tenant_hash}
    finally:
        os.unlink(tmp_path)


def save_document_metadata(user_id: str, s3_path: str, filename: str, size: int, md5: str, chunks: int):
    """Save document metadata to DynamoDB"""
    if not DOCUMENT_TABLE:
        return
    
    table = dynamodb.Table(DOCUMENT_TABLE)
    table.put_item(Item={
        'userId': user_id,
        's3Path': s3_path,
        'fileName': filename,  # Use camelCase to match UI expectations
        'size': size,
        'md5': md5,
        'uploadedAt': datetime.utcnow().isoformat(),
        'chunksCreated': chunks,
    })


def get_user_documents(user_id: str) -> List[dict]:
    """Get all documents for a user from DynamoDB"""
    if not DOCUMENT_TABLE:
        return []
    
    table = dynamodb.Table(DOCUMENT_TABLE)
    response = table.query(
        KeyConditionExpression='userId = :uid',
        ExpressionAttributeValues={':uid': user_id}
    )
    
    # Convert Decimal to int for JSON serialization
    items = []
    for item in response.get('Items', []):
        converted = {}
        for k, v in item.items():
            if isinstance(v, Decimal):
                converted[k] = int(v)
            else:
                converted[k] = v
        items.append(converted)
    
    return items


def delete_document_metadata(user_id: str, s3_path: str):
    """Delete document metadata from DynamoDB"""
    if not DOCUMENT_TABLE:
        return
    
    table = dynamodb.Table(DOCUMENT_TABLE)
    table.delete_item(Key={'userId': user_id, 's3Path': s3_path})


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
    """Common logic to process and index a file"""
    # Validate file type
    if not filename.lower().endswith(('.txt', '.pdf')):
        raise HTTPException(status_code=400, detail="Only TXT and PDF files are supported")
    
    file_size = len(file_content)
    file_md5 = hashlib.md5(file_content).hexdigest()
    
    # Extract text based on file type
    if filename.lower().endswith('.pdf'):
        text = extract_pdf_text(file_content)
    else:
        text = file_content.decode('utf-8')
    
    # Upload to S3 with user-isolated path
    s3_key = None
    if S3_BUCKET:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        s3_key = f"private/{user_id}/documents/{timestamp}_{filename}"
        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=s3_key,
            Body=file_content,
            ContentType=content_type
        )
    
    # Index the document
    index_result = index_document(text, filename, tenant_id)
    
    # Save metadata to DynamoDB
    if s3_key:
        save_document_metadata(
            user_id=user_id,
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
        "chunks_created": index_result["chunks_created"]
    }


@app.post("/upload")
async def upload_document(
    tenant_id: str = Query(default="default"),
    user_id: str = Query(default="anonymous"),
    file: UploadFile = File(...),
):
    """Upload document (TXT/PDF) via multipart form data"""
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


@app.delete("/documents")
async def delete_document(
    user_id: str = Query(...),
    s3_path: str = Query(...)
):
    """Delete a document from S3 and DynamoDB"""
    try:
        # Delete from S3
        if S3_BUCKET and s3_path:
            try:
                s3_client.delete_object(Bucket=S3_BUCKET, Key=s3_path)
            except Exception as e:
                print(f"S3 delete error: {e}")
        
        # Delete from DynamoDB
        delete_document_metadata(user_id, s3_path)
        
        return {"message": "Document deleted successfully", "s3_path": s3_path}
    except Exception as e:
        print(f"Delete document error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/reset-graph")
async def reset_graph(tenant_id: str = Query(default="default")):
    """Reset/clear the Neptune graph for a tenant"""
    try:
        tenant_hash = get_tenant_hash(tenant_id)
        
        # Use Neptune Analytics API directly for more reliable deletion
        try:
            # First try to delete all data using Neptune Analytics ExecuteQuery API
            delete_query = "MATCH (n) DETACH DELETE n"
            
            response = neptune_client.execute_query(
                graphIdentifier=NEPTUNE_GRAPH_ID,
                queryString=delete_query,
                language='OPEN_CYPHER'
            )
            print(f"Reset graph response: {response}")
            
        except Exception as e:
            print(f"Neptune API delete failed: {e}")
            # Fallback to graphrag_toolkit method
            with GraphStoreFactory.for_graph_store(GRAPH_STORE_CONFIG) as graph_store:
                try:
                    # Try tenant-specific delete first
                    delete_query = """
                    MATCH (n)
                    WHERE n.`~tenantId` = $tenantId OR n.tenantId = $tenantId
                    DETACH DELETE n
                    """
                    graph_store.execute_query(delete_query, {'tenantId': tenant_hash})
                except Exception as inner_e:
                    print(f"Tenant-specific delete failed: {inner_e}")
                    # Full reset
                    graph_store.execute_query("MATCH (n) DETACH DELETE n", {})
        
        return {
            "message": "Graph reset successfully",
            "tenant_id": tenant_id,
            "tenant_hash": tenant_hash
        }
    except Exception as e:
        print(f"Reset graph error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
