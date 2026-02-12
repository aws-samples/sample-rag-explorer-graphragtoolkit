import os
import time
import hashlib
from typing import List

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel

from graphrag_toolkit.lexical_graph import LexicalGraphQueryEngine
from graphrag_toolkit.lexical_graph.storage import GraphStoreFactory, VectorStoreFactory
from graphrag_toolkit.lexical_graph.storage.graph import MultiTenantGraphStore
from graphrag_toolkit.lexical_graph.storage.vector import MultiTenantVectorStore, ReadOnlyVectorStore
from graphrag_toolkit.lexical_graph.config import GraphRAGConfig
from graphrag_toolkit.lexical_graph.utils import LLMCache
from graphrag_toolkit.lexical_graph.retrieval.prompts import ANSWER_QUESTION_SYSTEM_PROMPT, ANSWER_QUESTION_USER_PROMPT
from graphrag_toolkit.lexical_graph.storage.vector.vector_index import to_embedded_query
from graphrag_toolkit.lexical_graph.tenant_id import to_tenant_id

from llama_index.core import ChatPromptTemplate
from llama_index.core.llms import ChatMessage, MessageRole
from llama_index.core.schema import QueryBundle, NodeWithScore, TextNode
from llama_index.core.base.base_retriever import BaseRetriever

# Environment variables
GRAPH_STORE_CONFIG = os.environ.get('GRAPH_STORE')
VECTOR_STORE_CONFIG = os.environ.get('VECTOR_STORE')

# FastAPI app
app = FastAPI(title="GraphRAG Query Handler")


class QueryRequest(BaseModel):
    query: str
    tenant_id: str = "default"


class QueryResponse(BaseModel):
    vector_response: str
    graphrag_response: str
    vector_sources: List[dict]
    graphrag_sources: List[dict]
    vector_chunks: List[dict]
    graphrag_graph_nodes: List[dict]
    graphrag_graph_links: List[dict]
    vector_time_ms: float
    graphrag_time_ms: float


class VectorRetriever(BaseRetriever):
    """Pure vector similarity search retriever"""
    
    def __init__(self, graph_store, vector_store, top_k: int = 5):
        self.graph_store = graph_store
        self.vector_store = vector_store
        self.top_k = top_k
    
    def _retrieve(self, query_bundle: QueryBundle):
        top_k_results = self.vector_store.get_index('chunk').top_k(query_bundle, self.top_k)
        top_k_map = {r['chunk']['chunkId']: r for r in top_k_results}
        chunk_ids = list(top_k_map.keys())
        
        # Get chunk text and resolve source filename via graph traversal
        cypher = '''
        MATCH (c) WHERE id(c) IN $chunkIds 
        OPTIONAL MATCH (c)-[:`__EXTRACTED_FROM__`]->(s)
        RETURN id(c) AS chunkId, c.value AS chunk, s.source AS sourceName, s{.*} AS sourceMeta
        '''
        results = self.graph_store.execute_query(cypher, {'chunkIds': chunk_ids})
        
        source_names = {}
        for r in results:
            chunk_id = r['chunkId']
            if chunk_id in top_k_map:
                top_k_map[chunk_id]['chunk']['value'] = r['chunk']
                # Try to get human-readable source name
                source_name = r.get('sourceName') or ''
                if not source_name and r.get('sourceMeta'):
                    source_name = r['sourceMeta'].get('source', '')
                if source_name:
                    source_names[chunk_id] = source_name
        
        return [
            NodeWithScore(
                node=TextNode(
                    text=result['chunk']['value'],
                    metadata={
                        'source': source_names.get(result['chunk']['chunkId'], result.get('source', 'Unknown')),
                        'chunkId': result['chunk']['chunkId']
                    }
                ),
                score=result['score']
            )
            for result in list(top_k_map.values())
        ]


def get_tenant_hash(tenant_id: str) -> str:
    return hashlib.md5(tenant_id.encode()).hexdigest()[:10].lower()


def generate_response(query: str, context: str) -> str:
    llm = LLMCache(llm=GraphRAGConfig.response_llm, enable_cache=False)
    chat_template = ChatPromptTemplate(message_templates=[
        ChatMessage(role=MessageRole.SYSTEM, content=ANSWER_QUESTION_SYSTEM_PROMPT),
        ChatMessage(role=MessageRole.USER, content=ANSWER_QUESTION_USER_PROMPT),
    ])
    return llm.predict(prompt=chat_template, query=query, search_results=context, answer_mode='fully')


def vector_query(query: str, tenant_id: str, graph_store, vector_store) -> dict:
    start = time.time()
    tenant_graph = MultiTenantGraphStore.wrap(graph_store, to_tenant_id(tenant_id))
    tenant_vector = ReadOnlyVectorStore.wrap(MultiTenantVectorStore.wrap(vector_store, to_tenant_id(tenant_id)))
    
    retriever = VectorRetriever(tenant_graph, tenant_vector, top_k=5)
    query_bundle = to_embedded_query(QueryBundle(query), GraphRAGConfig.embed_model)
    results = retriever.retrieve(query_bundle)
    
    context = '\n\n'.join([f"Source: {n.metadata.get('source', 'Unknown')}\n{n.text}" for n in results])
    response = generate_response(query, context)
    
    def _source_str(meta_source):
        """Extract a display string from source metadata which may be a string or dict."""
        if isinstance(meta_source, str):
            return meta_source
        if isinstance(meta_source, dict):
            return meta_source.get('metadata', {}).get('source', meta_source.get('sourceId', 'Unknown'))
        return str(meta_source)
    
    # Return chunks used for this query
    chunks = []
    for n in results:
        text = n.text or ''
        chunks.append({
            "text": text[:500] + '...' if len(text) > 500 else text,
            "source": _source_str(n.metadata.get('source', 'Unknown')),
            "score": n.score,
            "charCount": len(text)
        })
    
    return {
        "response": response,
        "sources": [{"text": n.text, "score": n.score, "source": _source_str(n.metadata.get('source', 'Unknown'))} for n in results],
        "chunks": chunks,
        "time_ms": (time.time() - start) * 1000
    }


def graphrag_query(query: str, tenant_id: str, graph_store, vector_store) -> dict:
    start = time.time()
    query_engine = LexicalGraphQueryEngine.for_traversal_based_search(
        graph_store, vector_store, tenant_id=tenant_id, streaming=False
    )
    response = query_engine.query(query)
    
    # Extract graph structure from source_nodes metadata for visualization
    # Each source_node has metadata['result'] with: source, topics[], each topic has statements[], each statement has facts[]
    graph_nodes = []
    graph_links = []
    seen_nodes = set()
    
    def add_node(node_id, name, node_type):
        if node_id not in seen_nodes:
            seen_nodes.add(node_id)
            label = name if len(name) <= 80 else name[:77] + '...'
            graph_nodes.append({"id": node_id, "name": label, "type": node_type})
    
    for idx, node in enumerate(response.source_nodes):
        meta = node.metadata or {}
        result = meta.get('result', {})
        
        # Source node
        source = result.get('source', {})
        source_id = ''
        if isinstance(source, dict):
            source_id = source.get('sourceId', f'source_{idx}')
            source_meta = source.get('metadata', {})
            source_name = source_meta.get('source', source_id)
        else:
            source_id = f'source_{idx}'
            source_name = str(source)
        add_node(source_id, source_name, 'source')
        
        # Topics and their statements/facts
        for t_idx, topic in enumerate(result.get('topics', [])):
            topic_name = topic.get('topic', f'Topic {t_idx}')
            topic_id = topic.get('topicId', f'{source_id}_topic_{t_idx}')
            add_node(topic_id, topic_name, 'topic')
            graph_links.append({"source": source_id, "target": topic_id, "type": "HAS_TOPIC"})
            
            for s_idx, stmt in enumerate(topic.get('statements', [])):
                if isinstance(stmt, dict):
                    stmt_text = stmt.get('statement', '')
                    stmt_id = stmt.get('statementId', f'{topic_id}_stmt_{s_idx}')
                    add_node(stmt_id, stmt_text, 'statement')
                    graph_links.append({"source": topic_id, "target": stmt_id, "type": "HAS_STATEMENT"})
                    
                    for f_idx, fact in enumerate(stmt.get('facts', [])):
                        fact_id = f'{stmt_id}_fact_{f_idx}'
                        add_node(fact_id, fact, 'fact')
                        graph_links.append({"source": stmt_id, "target": fact_id, "type": "SUPPORTS"})
    
    return {
        "response": str(response),
        "sources": [{"text": n.text[:500] if n.text else '', "score": n.score} for n in response.source_nodes],
        "graph_nodes": graph_nodes,
        "graph_links": graph_links,
        "time_ms": (time.time() - start) * 1000
    }


@app.get("/")
async def root():
    return {"message": "GraphRAG Query Handler", "status": "running"}


@app.get("/health")
async def health_check():
    return {"status": "healthy"}


@app.post("/query", response_model=QueryResponse)
async def query_documents(request: QueryRequest):
    """Query documents with both vector-only and GraphRAG approaches"""
    try:
        tenant_hash = get_tenant_hash(request.tenant_id)
        
        with (
            GraphStoreFactory.for_graph_store(GRAPH_STORE_CONFIG) as graph_store,
            VectorStoreFactory.for_vector_store(VECTOR_STORE_CONFIG) as vector_store
        ):
            vector_result = vector_query(request.query, tenant_hash, graph_store, vector_store)
            graphrag_result = graphrag_query(request.query, tenant_hash, graph_store, vector_store)
            
            return {
                "vector_response": vector_result["response"],
                "graphrag_response": graphrag_result["response"],
                "vector_sources": vector_result["sources"],
                "graphrag_sources": graphrag_result["sources"],
                "vector_chunks": vector_result["chunks"],
                "graphrag_graph_nodes": graphrag_result["graph_nodes"],
                "graphrag_graph_links": graphrag_result["graph_links"],
                "vector_time_ms": vector_result["time_ms"],
                "graphrag_time_ms": graphrag_result["time_ms"]
            }
    except Exception as e:
        print(f"Query error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))



if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
