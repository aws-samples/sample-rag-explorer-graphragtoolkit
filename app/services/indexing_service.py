import os
import tempfile
from typing import Dict
from PyPDF2 import PdfReader

from graphrag_toolkit.lexical_graph import LexicalGraphIndex, IndexingConfig
from graphrag_toolkit.lexical_graph.storage import GraphStoreFactory, VectorStoreFactory
from graphrag_toolkit.lexical_graph.indexing.build import Checkpoint

from llama_index.core import SimpleDirectoryReader
from llama_index.core.node_parser import SentenceSplitter

from app.services.document_service import DocumentService


class IndexingService:
    def __init__(self):
        self.doc_service = DocumentService()
        self.graph_store_config = os.getenv('GRAPH_STORE')
        self.vector_store_config = os.getenv('VECTOR_STORE')
    
    async def index_document(self, s3_key: str, tenant_id: str) -> Dict:
        """Download document from S3, extract text, and index with GraphRAG"""
        
        # Download from S3
        content = self.doc_service.download_from_s3(s3_key)
        
        # Extract text based on file type
        if s3_key.endswith('.pdf'):
            text = self._extract_pdf_text(content)
        else:
            text = content.decode('utf-8')
        
        # Save to temp file for processing
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as tmp:
            tmp.write(text)
            tmp_path = tmp.name
        
        try:
            # Index with GraphRAG Toolkit
            chunks_created = await self._index_with_graphrag(tmp_path, tenant_id, s3_key)
            return {"chunks_created": chunks_created}
        finally:
            os.unlink(tmp_path)
    
    def _extract_pdf_text(self, content: bytes) -> str:
        """Extract text from PDF"""
        with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name
        
        try:
            reader = PdfReader(tmp_path)
            text = ""
            for page in reader.pages:
                text += page.extract_text() + "\n"
            return text
        finally:
            os.unlink(tmp_path)
    
    async def _index_with_graphrag(self, file_path: str, tenant_id: str, source_name: str) -> int:
        """Index document using GraphRAG Toolkit (Extract + Build)"""
        
        with (
            GraphStoreFactory.for_graph_store(self.graph_store_config) as graph_store,
            VectorStoreFactory.for_vector_store(self.vector_store_config, index_names=['chunk']) as vector_store
        ):
            # Configure indexing with sentence splitter
            config = IndexingConfig(
                chunking=[SentenceSplitter(chunk_size=512, chunk_overlap=50)]
            )
            
            graph_index = LexicalGraphIndex(
                graph_store,
                vector_store,
                tenant_id=tenant_id,
                indexing_config=config
            )
            
            # Load document
            reader = SimpleDirectoryReader(
                input_files=[file_path],
                file_metadata=lambda p: {'file_name': source_name}
            )
            docs = reader.load_data()
            
            # Extract and Build in one go
            checkpoint = Checkpoint(f'index-{tenant_id}')
            
            graph_index.extract_and_build(
                nodes=docs,
                checkpoint=checkpoint,
                show_progress=False
            )
            
            return len(docs)
