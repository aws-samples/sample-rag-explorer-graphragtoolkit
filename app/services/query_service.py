import os
import time
from typing import Dict, List

from graphrag_toolkit.lexical_graph import LexicalGraphQueryEngine
from graphrag_toolkit.lexical_graph.storage import GraphStoreFactory, VectorStoreFactory
from graphrag_toolkit.lexical_graph.storage.graph import GraphStore, MultiTenantGraphStore
from graphrag_toolkit.lexical_graph.storage.vector import VectorStore, MultiTenantVectorStore, ReadOnlyVectorStore
from graphrag_toolkit.lexical_graph.config import GraphRAGConfig
from graphrag_toolkit.lexical_graph.utils import LLMCache
from graphrag_toolkit.lexical_graph.retrieval.prompts import ANSWER_QUESTION_SYSTEM_PROMPT, ANSWER_QUESTION_USER_PROMPT
from graphrag_toolkit.lexical_graph.storage.vector.vector_index import to_embedded_query
from graphrag_toolkit.lexical_graph.tenant_id import to_tenant_id

from llama_index.core import ChatPromptTemplate
from llama_index.core.llms import ChatMessage, MessageRole
from llama_index.core.schema import QueryBundle, NodeWithScore, TextNode
from llama_index.core.base.base_retriever import BaseRetriever


class VectorRetriever(BaseRetriever):
    """Pure vector similarity search retriever"""
    
    def __init__(self, graph_store: GraphStore, vector_store: VectorStore, top_k: int = 5):
        self.graph_store = graph_store
        self.vector_store = vector_store
        self.top_k = top_k
    
    def _retrieve(self, query_bundle: QueryBundle) -> List[NodeWithScore]:
        # Get top-k similar chunks
        top_k_results = self.vector_store.get_index('chunk').top_k(query_bundle, self.top_k)
        top_k_map = {r['chunk']['chunkId']: r for r in top_k_results}
        chunk_ids = list(top_k_map.keys())
        
        # Fetch chunk content from graph
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


class QueryService:
    def __init__(self):
        self.graph_store_config = os.getenv('GRAPH_STORE')
        self.vector_store_config = os.getenv('VECTOR_STORE')
    
    async def dual_query(self, query: str, tenant_id: str) -> Dict:
        """Execute both vector-only and GraphRAG queries"""
        
        with (
            GraphStoreFactory.for_graph_store(self.graph_store_config) as graph_store,
            VectorStoreFactory.for_vector_store(self.vector_store_config) as vector_store
        ):
            # Vector-only query
            vector_result = await self._vector_query(query, tenant_id, graph_store, vector_store)
            
            # GraphRAG query
            graphrag_result = await self._graphrag_query(query, tenant_id, graph_store, vector_store)
            
            return {
                "vector_response": vector_result["response"],
                "graphrag_response": graphrag_result["response"],
                "vector_sources": vector_result["sources"],
                "graphrag_sources": graphrag_result["sources"],
                "vector_time_ms": vector_result["time_ms"],
                "graphrag_time_ms": graphrag_result["time_ms"]
            }
    
    async def _vector_query(self, query: str, tenant_id: str, graph_store, vector_store) -> Dict:
        """Pure vector similarity search"""
        start = time.time()
        
        # Wrap stores with tenant
        tenant_graph = MultiTenantGraphStore.wrap(graph_store, to_tenant_id(tenant_id))
        tenant_vector = ReadOnlyVectorStore.wrap(
            MultiTenantVectorStore.wrap(vector_store, to_tenant_id(tenant_id))
        )
        
        # Create retriever
        retriever = VectorRetriever(tenant_graph, tenant_vector, top_k=5)
        
        # Embed query and retrieve
        query_bundle = to_embedded_query(QueryBundle(query), GraphRAGConfig.embed_model)
        results = retriever.retrieve(query_bundle)
        
        # Generate response
        context = '\n\n'.join([f"Source: {n.metadata.get('source', 'Unknown')}\n{n.text}" for n in results])
        response = self._generate_response(query, context)
        
        end = time.time()
        
        return {
            "response": response,
            "sources": [{"text": n.text, "score": n.score} for n in results],
            "time_ms": (end - start) * 1000
        }
    
    async def _graphrag_query(self, query: str, tenant_id: str, graph_store, vector_store) -> Dict:
        """GraphRAG-enhanced search"""
        start = time.time()
        
        query_engine = LexicalGraphQueryEngine.for_traversal_based_search(
            graph_store,
            vector_store,
            tenant_id=tenant_id,
            streaming=False
        )
        
        response = query_engine.query(query)
        
        end = time.time()
        
        return {
            "response": str(response),
            "sources": [{"text": n.text, "metadata": n.metadata} for n in response.source_nodes],
            "time_ms": (end - start) * 1000
        }
    
    def _generate_response(self, query: str, context: str) -> str:
        """Generate LLM response from context"""
        llm = LLMCache(llm=GraphRAGConfig.response_llm, enable_cache=False)
        
        chat_template = ChatPromptTemplate(message_templates=[
            ChatMessage(role=MessageRole.SYSTEM, content=ANSWER_QUESTION_SYSTEM_PROMPT),
            ChatMessage(role=MessageRole.USER, content=ANSWER_QUESTION_USER_PROMPT),
        ])
        
        response = llm.predict(
            prompt=chat_template,
            query=query,
            search_results=context,
            answer_mode='fully'
        )
        
        return response
