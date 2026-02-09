from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List
import os
import logging
import traceback
from dotenv import load_dotenv

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

from app.services.document_service import DocumentService
from app.services.indexing_service import IndexingService
from app.services.query_service import QueryService

load_dotenv()

app = FastAPI(title="GraphRAG Demo API")

# CORS middleware for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize services
doc_service = DocumentService()
indexing_service = IndexingService()
query_service = QueryService()


class QueryRequest(BaseModel):
    query: str
    tenant_id: str = "default"


class QueryResponse(BaseModel):
    vector_response: str
    graphrag_response: str
    vector_sources: List[dict]
    graphrag_sources: List[dict]
    vector_time_ms: float
    graphrag_time_ms: float


@app.get("/")
async def root():
    return {"message": "GraphRAG Demo API", "status": "running"}


@app.post("/upload")
async def upload_document(file: UploadFile = File(...), tenant_id: str = "default"):
    """Upload document (TXT/PDF) to S3 and trigger indexing"""
    try:
        logger.info(f"Upload request: file={file.filename}, tenant={tenant_id}")
        
        # Validate file type
        if not file.filename.endswith(('.txt', '.pdf')):
            raise HTTPException(status_code=400, detail="Only TXT and PDF files are supported")
        
        # Upload to S3
        logger.info("Uploading to S3...")
        s3_key = await doc_service.upload_to_s3(file, tenant_id)
        logger.info(f"S3 upload complete: {s3_key}")
        
        # Trigger indexing
        logger.info("Starting indexing...")
        result = await indexing_service.index_document(s3_key, tenant_id)
        logger.info(f"Indexing complete: {result}")
        
        return {
            "message": "Document uploaded and indexed successfully",
            "s3_key": s3_key,
            "tenant_id": tenant_id,
            "chunks_created": result.get("chunks_created", 0)
        }
    except Exception as e:
        logger.error(f"Upload failed: {str(e)}")
        logger.error(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/query", response_model=QueryResponse)
async def query_documents(request: QueryRequest):
    """Query documents with both vector-only and GraphRAG approaches"""
    try:
        result = await query_service.dual_query(request.query, request.tenant_id)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
async def health_check():
    return {"status": "healthy"}
