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
        
        cypher = 'MATCH (c) WHERE id(c) IN $chunkIds RETURN id(c) AS chunkId, c.value AS chunk'
        results = self.graph_store.execute_query(cypher, {'chunkIds': chunk_ids})
        
        for r in results:
            chunk_id = r['chunkId']
            top_k_map[chunk_id]['chunk']['value'] = r['chunk']
        
        return [
            NodeWithScore(
                node=TextNode(
                    text=result['chunk']['value'],
                    metadata={'source': result['source'], 'chunkId': result['chunk']['chunkId']}
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
    
    return {
        "response": response,
        "sources": [{"text": n.text, "score": n.score} for n in results],
        "time_ms": (time.time() - start) * 1000
    }


def graphrag_query(query: str, tenant_id: str, graph_store, vector_store) -> dict:
    start = time.time()
    query_engine = LexicalGraphQueryEngine.for_traversal_based_search(
        graph_store, vector_store, tenant_id=tenant_id, streaming=False
    )
    response = query_engine.query(query)
    return {
        "response": str(response),
        "sources": [{"text": n.text, "metadata": n.metadata} for n in response.source_nodes],
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
                "vector_time_ms": vector_result["time_ms"],
                "graphrag_time_ms": graphrag_result["time_ms"]
            }
    except Exception as e:
        print(f"Query error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/graph-visualization")
async def get_graph_visualization(
    tenant_id: str = Query(default="default"),
    limit: int = Query(default=100)
):
    """Get graph data for visualization"""
    try:
        tenant_hash = get_tenant_hash(tenant_id)
        
        with GraphStoreFactory.for_graph_store(GRAPH_STORE_CONFIG) as graph_store:
            # Query nodes with their labels and properties
            nodes_query = """
            MATCH (n)
            WHERE n.`~tenantId` = $tenantId OR n.tenantId = $tenantId OR true
            RETURN id(n) AS id, labels(n) AS labels, properties(n) AS props
            LIMIT $limit
            """
            
            # Query relationships
            rels_query = """
            MATCH (a)-[r]->(b)
            WHERE (a.`~tenantId` = $tenantId OR a.tenantId = $tenantId OR true)
            RETURN id(a) AS source, id(b) AS target, type(r) AS type
            LIMIT $limit
            """
            
            try:
                nodes_result = graph_store.execute_query(nodes_query, {'tenantId': tenant_hash, 'limit': limit})
                rels_result = graph_store.execute_query(rels_query, {'tenantId': tenant_hash, 'limit': limit})
            except Exception as e:
                print(f"Query with tenant filter failed, trying without: {e}")
                # Fallback without tenant filter
                nodes_result = graph_store.execute_query(
                    "MATCH (n) RETURN id(n) AS id, labels(n) AS labels, properties(n) AS props LIMIT $limit",
                    {'limit': limit}
                )
                rels_result = graph_store.execute_query(
                    "MATCH (a)-[r]->(b) RETURN id(a) AS source, id(b) AS target, type(r) AS type LIMIT $limit",
                    {'limit': limit}
                )
            
            # Process nodes
            nodes = []
            node_ids = set()
            for row in nodes_result:
                node_id = str(row.get('id', ''))
                if node_id and node_id not in node_ids:
                    node_ids.add(node_id)
                    labels = row.get('labels', [])
                    props = row.get('props', {})
                    
                    # Determine node type from labels
                    node_type = 'concept'
                    if labels:
                        label = labels[0].lower() if isinstance(labels, list) else str(labels).lower()
                        if 'document' in label or 'source' in label:
                            node_type = 'document'
                        elif 'person' in label:
                            node_type = 'person'
                        elif 'org' in label or 'company' in label:
                            node_type = 'organization'
                        elif 'location' in label or 'place' in label:
                            node_type = 'location'
                        elif 'chunk' in label:
                            node_type = 'chunk'
                        elif 'entity' in label:
                            node_type = 'entity'
                    
                    # Get display name
                    name = props.get('name') or props.get('value') or props.get('title') or node_id[:20]
                    if isinstance(name, str) and len(name) > 50:
                        name = name[:50] + '...'
                    
                    nodes.append({
                        'id': node_id,
                        'name': str(name),
                        'type': node_type,
                        'description': str(props.get('description', ''))[:100] if props.get('description') else ''
                    })
            
            # Process relationships
            links = []
            for row in rels_result:
                source = str(row.get('source', ''))
                target = str(row.get('target', ''))
                rel_type = row.get('type', 'RELATED_TO')
                
                if source in node_ids and target in node_ids:
                    links.append({
                        'source': source,
                        'target': target,
                        'type': str(rel_type)
                    })
            
            return {
                'nodes': nodes,
                'links': links
            }
            
    except Exception as e:
        print(f"Graph visualization error: {e}")
        import traceback
        traceback.print_exc()
        # Return empty graph on error
        return {'nodes': [], 'links': []}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
