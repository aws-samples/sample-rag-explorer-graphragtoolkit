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


@app.get("/vector-chunks")
async def get_vector_chunks(
    tenant_id: str = Query(default="default"),
    limit: int = Query(default=20)
):
    """Get vector chunks for exploration - shows what vector-only RAG sees"""
    try:
        tenant_hash = get_tenant_hash(tenant_id)
        
        with GraphStoreFactory.for_graph_store(GRAPH_STORE_CONFIG) as graph_store:
            
            chunks_query = """
            MATCH (c:Chunk)
            OPTIONAL MATCH (s:Source)-[:HAS_CHUNK]->(c)
            RETURN id(c) AS chunkId, 
                   c.value AS text, 
                   s.fileName AS source
            LIMIT $limit
            """
            
            results = graph_store.execute_query(chunks_query, {'limit': limit})
            
            chunks = []
            for row in results:
                chunk_id = str(row.get('chunkId', ''))
                text = row.get('text', '')
                source = row.get('source', 'Unknown')
                
                if text:
                    display_text = text[:500] + '...' if len(text) > 500 else text
                    chunks.append({
                        'id': chunk_id,
                        'text': display_text,
                        'fullText': text,
                        'source': source,
                        'charCount': len(text)
                    })
            
            return {
                'chunks': chunks,
                'total': len(chunks),
                'description': 'These are the text chunks stored in the vector index. Vector-only RAG uses similarity search to find relevant chunks based on your question embedding.'
            }
            
    except Exception as e:
        print(f"Vector chunks error: {e}")
        import traceback
        traceback.print_exc()
        return {'chunks': [], 'total': 0, 'error': str(e)}


@app.get("/graph-nodes")
async def get_graph_nodes(
    tenant_id: str = Query(default="default"),
    node_type: str = Query(default="all"),
    limit: int = Query(default=50)
):
    """Get graph nodes for exploration - shows entities, topics, and facts in the knowledge graph"""
    try:
        tenant_hash = get_tenant_hash(tenant_id)
        
        with GraphStoreFactory.for_graph_store(GRAPH_STORE_CONFIG) as graph_store:
            nodes_by_type = {}
            
            # Query entities
            if node_type in ['all', 'entity']:
                try:
                    entity_results = graph_store.execute_query(
                        "MATCH (e) WHERE (e:Entity OR any(l IN labels(e) WHERE l CONTAINS 'Entity')) RETURN id(e) AS id, labels(e) AS labels, properties(e) AS props LIMIT $limit",
                        {'limit': limit}
                    )
                    entities = []
                    for row in entity_results:
                        props = row.get('props', {})
                        name = props.get('value') or props.get('name') or str(row.get('id', ''))[:30]
                        entity_type = props.get('classification') or 'Entity'
                        entities.append({
                            'id': str(row.get('id', '')),
                            'name': name,
                            'type': entity_type,
                            'labels': row.get('labels', [])
                        })
                    nodes_by_type['entities'] = entities
                except Exception as e:
                    print(f"Entity query failed: {e}")
                    nodes_by_type['entities'] = []
            
            # Query topics
            if node_type in ['all', 'topic']:
                try:
                    topic_results = graph_store.execute_query(
                        "MATCH (t:Topic) RETURN id(t) AS id, t.value AS value LIMIT $limit",
                        {'limit': limit}
                    )
                    topics = []
                    for row in topic_results:
                        value = row.get('value', '')
                        if value:
                            topics.append({
                                'id': str(row.get('id', '')),
                                'value': value[:200] + '...' if len(value) > 200 else value
                            })
                    nodes_by_type['topics'] = topics
                except Exception as e:
                    print(f"Topic query failed: {e}")
                    nodes_by_type['topics'] = []
            
            # Query statements
            if node_type in ['all', 'statement']:
                try:
                    statement_results = graph_store.execute_query(
                        "MATCH (s:Statement) RETURN id(s) AS id, s.value AS value LIMIT $limit",
                        {'limit': limit}
                    )
                    statements = []
                    for row in statement_results:
                        value = row.get('value', '')
                        if value:
                            statements.append({
                                'id': str(row.get('id', '')),
                                'value': value[:300] + '...' if len(value) > 300 else value
                            })
                    nodes_by_type['statements'] = statements
                except Exception as e:
                    print(f"Statement query failed: {e}")
                    nodes_by_type['statements'] = []
            
            # Query facts
            if node_type in ['all', 'fact']:
                try:
                    fact_results = graph_store.execute_query(
                        "MATCH (f:Fact) RETURN id(f) AS id, f.value AS value LIMIT $limit",
                        {'limit': limit}
                    )
                    facts = []
                    for row in fact_results:
                        value = row.get('value', '')
                        if value:
                            facts.append({
                                'id': str(row.get('id', '')),
                                'value': value[:300] + '...' if len(value) > 300 else value
                            })
                    nodes_by_type['facts'] = facts
                except Exception as e:
                    print(f"Fact query failed: {e}")
                    nodes_by_type['facts'] = []
            
            # Get relationship counts
            try:
                rel_results = graph_store.execute_query(
                    "MATCH ()-[r]->() RETURN type(r) AS relType, count(*) AS count ORDER BY count DESC LIMIT 10",
                    {}
                )
                relationships = [{'type': r['relType'], 'count': r['count']} for r in rel_results]
            except:
                relationships = []
            
            return {
                'nodes': nodes_by_type,
                'relationships': relationships,
                'description': 'The knowledge graph contains entities, topics, statements, and facts extracted from your documents. GraphRAG traverses these connections to find structurally relevant information.'
            }
            
    except Exception as e:
        print(f"Graph nodes error: {e}")
        import traceback
        traceback.print_exc()
        return {'nodes': {}, 'relationships': [], 'error': str(e)}


@app.get("/graph-visualization")
async def get_graph_visualization(
    tenant_id: str = Query(default="default"),
    limit: int = Query(default=100)
):
    """Get graph data for visualization — fetches a connected subgraph"""
    try:
        with GraphStoreFactory.for_graph_store(GRAPH_STORE_CONFIG) as graph_store:
            # Single query: fetch relationships and their connected nodes together
            # This guarantees we get a connected subgraph, not random disconnected nodes
            subgraph_query = """
            MATCH (a)-[r]->(b)
            RETURN id(a) AS source, labels(a) AS sourceLabels, properties(a) AS sourceProps,
                   id(b) AS target, labels(b) AS targetLabels, properties(b) AS targetProps,
                   type(r) AS relType
            LIMIT $limit
            """
            results = graph_store.execute_query(subgraph_query, {'limit': limit * 3})
            
            nodes = {}
            links = []
            
            def process_node(node_id, labels, props):
                if node_id in nodes:
                    return
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
                    elif 'topic' in label:
                        node_type = 'concept'
                    elif 'statement' in label:
                        node_type = 'concept'
                    elif 'fact' in label:
                        node_type = 'entity'
                
                name = props.get('name') or props.get('value') or props.get('title') or str(node_id)[:20]
                if isinstance(name, str) and len(name) > 50:
                    name = name[:50] + '...'
                
                nodes[node_id] = {
                    'id': node_id,
                    'name': str(name),
                    'type': node_type,
                    'description': str(props.get('description', ''))[:100] if props.get('description') else ''
                }
            
            for row in results:
                src_id = str(row.get('source', ''))
                tgt_id = str(row.get('target', ''))
                if not src_id or not tgt_id:
                    continue
                
                process_node(src_id, row.get('sourceLabels', []), row.get('sourceProps', {}))
                process_node(tgt_id, row.get('targetLabels', []), row.get('targetProps', {}))
                
                links.append({
                    'source': src_id,
                    'target': tgt_id,
                    'type': str(row.get('relType', 'RELATED_TO'))
                })
                
                # Cap nodes for visualization performance
                if len(nodes) >= limit:
                    break
            
            return {
                'nodes': list(nodes.values()),
                'links': links
            }
            
    except Exception as e:
        print(f"Graph visualization error: {e}")
        import traceback
        traceback.print_exc()
        return {'nodes': [], 'links': []}




if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
