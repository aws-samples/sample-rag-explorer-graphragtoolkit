import { useState, useEffect, useCallback, useRef } from 'react'
import {
  AppLayout,
  ContentLayout,
  Header,
  Container,
  SpaceBetween,
  Button,
  Textarea,
  Box,
  Alert,
  Spinner,
  StatusIndicator,
  ColumnLayout,
  Grid,
  Table,
  Modal,
  ExpandableSection,
  Tabs,
  Badge,
  Input,
  FormField,
  Select,
} from '@cloudscape-design/components'
import { fetchAuthSession } from '@aws-amplify/auth'
import * as d3 from 'd3'
import MessageFormatter from '../components/MessageFormatter'
import { loadConfig } from '../config'
import { signedFetch } from '../App'

interface GraphRAGChatProps {
  onSignOut?: () => void;
}

interface Message {
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  sourcesCount?: number
  timeMs?: number
}

interface GraphStats {
  configured: boolean
  status?: string
  error?: string
}

interface UploadedFile {
  name: string
  size: string
  status: 'uploading' | 'processing' | 'completed' | 'error'
  timestamp: Date
  chunksCreated?: number
}

interface StoredDocument {
  s3Path: string
  fileName?: string
  filename?: string
  uploadedAt: string
  fileSize?: number
  tenantId?: string
}

interface QueryVectorChunk {
  text: string
  source: string
  score: number
  charCount: number
}

interface QueryGraphNode {
  id: string
  name: string
  type: string
}

interface QueryGraphLink {
  source: string
  target: string
  type: string
}

interface D3Node extends QueryGraphNode {
  x?: number
  y?: number
  fx?: number | null
  fy?: number | null
}

interface D3Link {
  source: string | D3Node
  target: string | D3Node
  type: string
}

export default function GraphRAGChat({ onSignOut }: GraphRAGChatProps) {
  const [graphMessages, setGraphMessages] = useState<Message[]>([])
  const [vectorMessages, setVectorMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [graphStats, setGraphStats] = useState<GraphStats | null>(null)
  const [files, setFiles] = useState<UploadedFile[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null)
  const [apiUrl, setApiUrl] = useState('')
  const [uploadUrl, setUploadUrl] = useState('')
  const [storedDocuments, setStoredDocuments] = useState<StoredDocument[]>([])
  const [loadingDocs, setLoadingDocs] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [showResetModal, setShowResetModal] = useState(false)
  const [tenantId, setTenantId] = useState('default')
  const [tenantInput, setTenantInput] = useState('default')
  const [userId, setUserId] = useState<string>('anonymous')

  // Per-query results
  const [lastVectorChunks, setLastVectorChunks] = useState<QueryVectorChunk[]>([])
  const [lastGraphNodes, setLastGraphNodes] = useState<QueryGraphNode[]>([])
  const [lastGraphLinks, setLastGraphLinks] = useState<QueryGraphLink[]>([])
  const [activeResultsTab, setActiveResultsTab] = useState('graph-viz')
  const graphSvgRef = useRef<SVGSVGElement>(null)
  // Derive unique tenants from stored documents
  const uniqueTenants = Array.from(new Set(
    storedDocuments
      .map(doc => doc.tenantId)
      .filter((t): t is string => !!t)
  )).sort()

  const tenantOptions = uniqueTenants.map(t => ({ label: t, value: t }))

  useEffect(() => {
    loadConfig().then((cfg) => {
      setApiUrl(cfg.queryApiUrl)
      setUploadUrl(cfg.uploadApiUrl)
    })
    fetchAuthSession().then((session) => {
      if (session.identityId) {
        setUserId(session.identityId)
      }
    }).catch(console.error)
  }, [])

  useEffect(() => {
    if (apiUrl) fetchGraphStats()
  }, [apiUrl])

  useEffect(() => {
    if (uploadUrl && userId !== 'anonymous') fetchStoredDocuments()
  }, [uploadUrl, userId])

  // Auto-select tenant from stored documents on initial load
  useEffect(() => {
    if (storedDocuments.length > 0) {
      const tenants = Array.from(new Set(
        storedDocuments.map(doc => doc.tenantId).filter((t): t is string => !!t)
      )).sort()
      if (tenants.length > 0 && tenantId === 'default' && tenantInput === 'default') {
        setTenantId(tenants[0])
        setTenantInput(tenants[0])
      }
    }
  }, [storedDocuments])

  // D3 force graph for per-query graph visualization
  useEffect(() => {
    if (!graphSvgRef.current || lastGraphNodes.length === 0 || activeResultsTab !== 'graph-viz') return

    const svg = d3.select(graphSvgRef.current)
    svg.selectAll('*').remove()

    const width = 800
    const height = 400

    const color = d3.scaleOrdinal<string>()
      .domain(['source', 'topic', 'statement', 'fact'])
      .range(['#0972d3', '#037f0c', '#9469d6', '#eb5f07'])

    const nodeRadius = (type: string) => {
      switch (type) {
        case 'source': return 14
        case 'topic': return 11
        case 'statement': return 8
        case 'fact': return 6
        default: return 8
      }
    }

    const nodes: D3Node[] = lastGraphNodes.map(n => ({ ...n }))
    const links: D3Link[] = lastGraphLinks
      .filter(l => lastGraphNodes.some(n => n.id === l.source) && lastGraphNodes.some(n => n.id === l.target))
      .map(l => ({ ...l }))

    const simulation = d3.forceSimulation<D3Node>(nodes)
      .force('link', d3.forceLink<D3Node, D3Link>(links).id(d => d.id).distance(100))
      .force('charge', d3.forceManyBody().strength(-250))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(35))

    const g = svg.append('g')
    svg.call(d3.zoom<SVGSVGElement, unknown>()
      .extent([[0, 0], [width, height]])
      .scaleExtent([0.3, 4])
      .on('zoom', (event) => g.attr('transform', event.transform)))

    // Draw links
    const link = g.append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', '#999')
      .attr('stroke-opacity', 0.5)
      .attr('stroke-width', 1.5)

    // Link labels
    const linkLabel = g.append('g')
      .selectAll('text')
      .data(links)
      .join('text')
      .text(d => d.type)
      .attr('font-size', '7px')
      .attr('fill', '#888')
      .attr('text-anchor', 'middle')

    // Draw nodes
    const node = g.append('g')
      .selectAll<SVGCircleElement, D3Node>('circle')
      .data(nodes)
      .join('circle')
      .attr('r', d => nodeRadius(d.type))
      .attr('fill', d => color(d.type))
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.5)
      .call(d3.drag<SVGCircleElement, D3Node>()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart()
          d.fx = d.x; d.fy = d.y
        })
        .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0)
          d.fx = null; d.fy = null
        }))

    node.append('title').text(d => `[${d.type}] ${d.name}`)

    // Labels
    const labels = g.append('g')
      .selectAll('text')
      .data(nodes)
      .join('text')
      .text(d => d.name.length > 20 ? d.name.slice(0, 20) + '...' : d.name)
      .attr('font-size', '9px')
      .attr('dx', 16)
      .attr('dy', 3)
      .attr('fill', '#333')

    simulation.on('tick', () => {
      link
        .attr('x1', d => (d.source as D3Node).x!)
        .attr('y1', d => (d.source as D3Node).y!)
        .attr('x2', d => (d.target as D3Node).x!)
        .attr('y2', d => (d.target as D3Node).y!)
      linkLabel
        .attr('x', d => ((d.source as D3Node).x! + (d.target as D3Node).x!) / 2)
        .attr('y', d => ((d.source as D3Node).y! + (d.target as D3Node).y!) / 2)
      node.attr('cx', d => d.x!).attr('cy', d => d.y!)
      labels.attr('x', d => d.x!).attr('y', d => d.y!)
    })

    return () => { simulation.stop() }
  }, [lastGraphNodes, lastGraphLinks, activeResultsTab])

  const fetchGraphStats = async () => {
    if (!apiUrl) return
    try {
      const baseUrl = apiUrl.replace(/\/$/, '')
      const res = await signedFetch(`${baseUrl}/health`, { method: 'GET' })
      if (res.ok) {
        const data = await res.json()
        setGraphStats({ configured: true, status: data.status || 'healthy' })
      } else {
        const text = await res.text()
        setGraphStats({ configured: false, error: `Backend unhealthy: ${res.status} ${text}` })
      }
    } catch (err) {
      console.error('Health check failed:', err)
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      setGraphStats({ configured: false, error: `Cannot connect to backend: ${errorMsg}` })
    }
  }

  const fetchStoredDocuments = useCallback(async () => {
    if (!uploadUrl || userId === 'anonymous') return
    setLoadingDocs(true)
    try {
      const baseUrl = uploadUrl.replace(/\/$/, '')
      const res = await signedFetch(`${baseUrl}/documents?user_id=${encodeURIComponent(userId)}`, { method: 'GET' })
      if (res.ok) {
        const data = await res.json()
        setStoredDocuments(data.documents || [])
      }
    } catch (err) {
      console.error('Failed to fetch documents:', err)
    } finally {
      setLoadingDocs(false)
    }
  }, [uploadUrl, userId])

  const handleResetGraph = async () => {
    setResetting(true)
    setError(null)
    try {
      const baseUrl = uploadUrl.replace(/\/$/, '')
      const res = await signedFetch(`${baseUrl}/reset-graph?tenant_id=${tenantId}&user_id=${encodeURIComponent(userId)}`, { method: 'POST' })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Reset failed: ${text}`)
      }
      setUploadSuccess('Graph database reset successfully!')
      setGraphMessages([])
      setVectorMessages([])
      setFiles([])
      setTenantId('default')
      setTenantInput('default')
      setLastVectorChunks([])
      setLastGraphNodes([])
      setLastGraphLinks([])
      await fetchStoredDocuments()
    } catch (err) {
      setError(`Failed to reset graph: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setResetting(false)
      setShowResetModal(false)
    }
  }

  const handleDeleteDocument = async (s3Path: string) => {
    try {
      const baseUrl = uploadUrl.replace(/\/$/, '')
      const res = await signedFetch(
        `${baseUrl}/documents?user_id=${encodeURIComponent(userId)}&s3_path=${encodeURIComponent(s3Path)}`,
        { method: 'DELETE' }
      )
      if (!res.ok) throw new Error('Delete failed')
      await fetchStoredDocuments()
      setUploadSuccess('Document deleted successfully')
    } catch (err) {
      setError(`Failed to delete document: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  const sendMessage = async () => {
    if (!input.trim() || !apiUrl) return

    const userMessage: Message = { role: 'user', content: input, timestamp: new Date() }
    setGraphMessages(prev => [...prev, userMessage])
    setVectorMessages(prev => [...prev, userMessage])
    setInput('')
    setLoading(true)
    setError(null)
    // Clear previous query results
    setLastVectorChunks([])
    setLastGraphNodes([])
    setLastGraphLinks([])

    try {
      const baseUrl = apiUrl.replace(/\/$/, '')
      const res = await signedFetch(`${baseUrl}/query`, {
        method: 'POST',
        body: JSON.stringify({ query: input, tenant_id: tenantId }),
      })

      if (!res.ok) throw new Error('Query failed')

      const data = await res.json()

      setGraphMessages(prev => [...prev, {
        role: 'assistant',
        content: data.graphrag_response || 'No response',
        timestamp: new Date(),
        sourcesCount: data.graphrag_sources?.length || 0,
        timeMs: data.graphrag_time_ms,
      }])

      setVectorMessages(prev => [...prev, {
        role: 'assistant',
        content: data.vector_response || 'No response',
        timestamp: new Date(),
        sourcesCount: data.vector_sources?.length || 0,
        timeMs: data.vector_time_ms,
      }])

      // Capture per-query results
      setLastVectorChunks(data.vector_chunks || [])
      setLastGraphNodes(data.graphrag_graph_nodes || [])
      setLastGraphLinks(data.graphrag_graph_links || [])
    } catch (err) {
      setError('Failed to get response. Check that the backend is configured correctly.')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = event.target.files
    if (!selectedFiles || selectedFiles.length === 0) return

    setUploading(true)
    setError(null)
    setUploadSuccess(null)

    for (const file of Array.from(selectedFiles)) {
      const newFile: UploadedFile = {
        name: file.name,
        size: formatFileSize(file.size),
        status: 'uploading',
        timestamp: new Date(),
      }
      setFiles(prev => [newFile, ...prev])

      try {
        setFiles(prev => prev.map(f =>
          f.name === file.name ? { ...f, status: 'processing' as const } : f
        ))

        const uploadEndpoint = `${uploadUrl.replace(/\/$/, '')}/upload-json?tenant_id=${tenantId}&user_id=${encodeURIComponent(userId)}`

        const arrayBuffer = await file.arrayBuffer()
        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))

        const res = await signedFetch(uploadEndpoint, {
          method: 'POST',
          body: JSON.stringify({
            fileName: file.name,
            fileContent: base64,
            contentType: file.type || 'application/octet-stream',
          }),
        })

        if (!res.ok) {
          const errorText = await res.text()
          throw new Error(`Upload failed: ${errorText}`)
        }

        const data = await res.json()

        setFiles(prev => prev.map(f =>
          f.name === file.name ? { ...f, status: 'completed' as const, chunksCreated: data.chunks_created } : f
        ))
        if (data.already_processed) {
          setUploadSuccess(`${file.name} was already processed, skipping re-indexing`)
        } else {
          setUploadSuccess(`${file.name} uploaded and indexed successfully!`)
        }
        await fetchStoredDocuments()
      } catch (err) {
        setFiles(prev => prev.map(f =>
          f.name === file.name ? { ...f, status: 'error' as const } : f
        ))
        setError(`Failed to upload ${file.name}: ${err instanceof Error ? err.message : 'Unknown error'}`)
        console.error(err)
      }
    }

    setUploading(false)
    event.target.value = ''
  }

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  const getStatusIndicator = (status: UploadedFile['status']) => {
    switch (status) {
      case 'uploading': return <StatusIndicator type="in-progress">Uploading</StatusIndicator>
      case 'processing': return <StatusIndicator type="pending">Processing</StatusIndicator>
      case 'completed': return <StatusIndicator type="success">Completed</StatusIndicator>
      case 'error': return <StatusIndicator type="error">Error</StatusIndicator>
    }
  }

  const renderChat = (messages: Message[], title: string, isGraphRAG: boolean) => (
    <Container header={<Header variant="h2">{title}</Header>}>
      <div style={{ maxHeight: '350px', overflowY: 'auto', padding: '12px', backgroundColor: '#f9f9f9', borderRadius: '8px' }}>
        {messages.length === 0 ? (
          <Box textAlign="center" color="text-body-secondary" padding="m">
            {isGraphRAG ? 'Uses knowledge graph with entity relationships' : 'Uses vector similarity search on document chunks'}
          </Box>
        ) : (
          <SpaceBetween size="s">
            {messages.map((msg, idx) => (
              <div key={idx} style={{ padding: '8px', backgroundColor: msg.role === 'user' ? '#fff' : '#f2f3f3', borderRadius: '6px', border: '1px solid #e9ebed' }}>
                <Box variant="small" color={msg.role === 'user' ? 'text-status-info' : 'text-status-success'}>
                  {msg.role === 'user' ? '👤 You' : isGraphRAG ? '🔗 GraphRAG' : '📄 Vector RAG'}
                  {msg.role === 'assistant' && (
                    <span style={{ marginLeft: '8px', fontSize: '11px', color: '#666' }}>
                      ({msg.sourcesCount || 0} sources, {msg.timeMs?.toFixed(0) || 0}ms)
                    </span>
                  )}
                </Box>
                {msg.role === 'assistant' ? (
                  <MessageFormatter content={msg.content} variant="simple" />
                ) : (
                  <Box variant="small">{msg.content}</Box>
                )}
              </div>
            ))}
          </SpaceBetween>
        )}
      </div>
    </Container>
  )

  return (
    <>
      <Modal
        visible={showResetModal}
        onDismiss={() => setShowResetModal(false)}
        header="Reset Knowledge Graph"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setShowResetModal(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleResetGraph} loading={resetting}>
                Reset Graph
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <Box>
          Are you sure you want to reset the knowledge graph? This will delete all nodes and relationships
          for tenant "{tenantId}". Your uploaded documents will remain in S3 but will need to be re-indexed.
        </Box>
      </Modal>

      <AppLayout
        navigationHide
        toolsHide
        content={
          <ContentLayout
            header={
              <Header
                variant="h1"
                description="Compare GraphRAG vs Vector-only RAG responses side-by-side"
                actions={
                  <SpaceBetween direction="horizontal" size="s">
                    <Button
                      iconName="remove"
                      onClick={() => setShowResetModal(true)}
                      loading={resetting}
                    >
                      Reset Graph
                    </Button>
                    {onSignOut && (
                      <Button onClick={onSignOut} variant="link">Sign Out</Button>
                    )}
                  </SpaceBetween>
                }
              >
                RAG Comparison Demo
              </Header>
            }
          >
            <SpaceBetween size="l">
              {/* Status Bar */}
              <Container>
                <ColumnLayout columns={4}>
                  <div>
                    <Box variant="awsui-key-label">Backend Status</Box>
                    {graphStats?.configured ? (
                      <StatusIndicator type="success">Connected</StatusIndicator>
                    ) : (
                      <StatusIndicator type="error">{graphStats?.error || 'Not Connected'}</StatusIndicator>
                    )}
                  </div>
                  <div>
                    {uniqueTenants.length > 0 ? (
                      <FormField label="Select Tenant" description="Choose existing or create new">
                        <SpaceBetween direction="horizontal" size="xs">
                          <Select
                            selectedOption={tenantOptions.find(o => o.value === tenantId) || null}
                            onChange={({ detail }) => {
                              if (detail.selectedOption?.value) {
                                setTenantId(detail.selectedOption.value)
                                setTenantInput(detail.selectedOption.value)
                                setUploadSuccess(`Switched to tenant: ${detail.selectedOption.value}`)
                                setLastVectorChunks([])
                                setLastGraphNodes([])
                                setLastGraphLinks([])
                              }
                            }}
                            options={tenantOptions}
                            placeholder="Select tenant"
                            filteringType="auto"
                          />
                          <Input
                            value={tenantInput}
                            onChange={({ detail }) => setTenantInput(detail.value)}
                            placeholder="Or new tenant"
                          />
                          <Button
                            onClick={() => {
                              const newTenant = tenantInput || 'default'
                              setTenantId(newTenant)
                              setUploadSuccess(`Switched to tenant: ${newTenant}`)
                              setLastVectorChunks([])
                              setLastGraphNodes([])
                              setLastGraphLinks([])
                            }}
                            disabled={!tenantInput || tenantInput === tenantId}
                          >
                            Set
                          </Button>
                        </SpaceBetween>
                      </FormField>
                    ) : (
                      <FormField label="Tenant ID" description="Isolates your data">
                        <SpaceBetween direction="horizontal" size="xs">
                          <Input
                            value={tenantInput}
                            onChange={({ detail }) => setTenantInput(detail.value)}
                            placeholder="Enter tenant ID"
                          />
                          <Button
                            onClick={() => {
                              setTenantId(tenantInput || 'default')
                              setUploadSuccess(`Switched to tenant: ${tenantInput || 'default'}`)
                            }}
                            disabled={tenantInput === tenantId}
                          >
                            Set
                          </Button>
                        </SpaceBetween>
                      </FormField>
                    )}
                  </div>
                  <div>
                    <Box variant="awsui-key-label">Active Tenant</Box>
                    <Badge color="blue">{tenantId}</Badge>
                  </div>
                  <div>
                    <SpaceBetween direction="horizontal" size="xs">
                      <input type="file" id="file-upload" multiple accept=".txt,.md" style={{ display: 'none' }} onChange={handleFileSelect} />
                      <Button iconName="upload" loading={uploading} onClick={() => document.getElementById('file-upload')?.click()}>
                        Upload
                      </Button>
                      <Button iconName="refresh" onClick={fetchGraphStats}>Refresh</Button>
                    </SpaceBetween>
                  </div>
                </ColumnLayout>
              </Container>

              {error && <Alert type="error" dismissible onDismiss={() => setError(null)}>{error}</Alert>}
              {uploadSuccess && <Alert type="success" dismissible onDismiss={() => setUploadSuccess(null)}>{uploadSuccess}</Alert>}

              {/* Comparison Chats */}
              <Grid gridDefinition={[{ colspan: 6 }, { colspan: 6 }]}>
                {renderChat(graphMessages, '🔗 GraphRAG (Knowledge Graph)', true)}
                {renderChat(vectorMessages, '📄 Vector RAG (Similarity Search)', false)}
              </Grid>

              {/* Input Area */}
              <Container>
                <SpaceBetween size="s">
                  <Textarea
                    value={input}
                    onChange={({ detail }) => setInput(detail.value)}
                    placeholder="Ask a question to compare both RAG approaches..."
                    rows={2}
                    disabled={loading}
                  />
                  <Box float="right">
                    <Button variant="primary" onClick={sendMessage} disabled={loading || !input.trim()}>
                      {loading ? <Spinner /> : 'Send to Both'}
                    </Button>
                  </Box>
                </SpaceBetween>
              </Container>

              {/* Per-Query Results */}
              {(lastVectorChunks.length > 0 || lastGraphNodes.length > 0) && (
                <ExpandableSection
                  headerText={`📊 Query Results — ${lastVectorChunks.length} vector chunks, ${lastGraphNodes.length} graph nodes, ${lastGraphLinks.length} relationships`}
                  defaultExpanded={true}
                >
                  <Tabs
                    activeTabId={activeResultsTab}
                    onChange={({ detail }) => setActiveResultsTab(detail.activeTabId)}
                    tabs={[
                      {
                        id: 'graph-viz',
                        label: `� Graph Visualization (${lastGraphNodes.length} nodes, ${lastGraphLinks.length} links)`,
                        content: lastGraphNodes.length > 0 ? (
                          <SpaceBetween size="s">
                            <Box color="text-body-secondary" variant="small">
                              Knowledge graph structure used by GraphRAG to answer this query. Sources → Topics → Statements → Facts.
                            </Box>
                            <SpaceBetween direction="horizontal" size="xs">
                              {[
                                { type: 'source', color: '#0972d3' },
                                { type: 'topic', color: '#037f0c' },
                                { type: 'statement', color: '#9469d6' },
                                { type: 'fact', color: '#eb5f07' },
                              ].map(({ type, color }) => (
                                <span key={type} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                                  <span style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: color, display: 'inline-block' }} />
                                  {type}
                                </span>
                              ))}
                            </SpaceBetween>
                            <svg
                              ref={graphSvgRef}
                              width="100%"
                              height="400"
                              style={{ border: '1px solid #e9ebed', borderRadius: '8px', background: '#fafafa' }}
                            />
                          </SpaceBetween>
                        ) : (
                          <Box textAlign="center" color="text-body-secondary" padding="l">
                            No graph data returned for this query.
                          </Box>
                        )
                      },
                      {
                        id: 'vector-chunks',
                        label: `📄 Vector Chunks (${lastVectorChunks.length})`,
                        content: (
                          <SpaceBetween size="s">
                            <Box color="text-body-secondary" variant="small">
                              These are the document chunks retrieved by vector similarity search for this query.
                            </Box>
                            <Table
                              items={lastVectorChunks}
                              columnDefinitions={[
                                { id: 'source', header: 'Source', cell: item => typeof item.source === 'string' ? item.source : JSON.stringify(item.source), width: 150 },
                                { id: 'text', header: 'Content', cell: item => (
                                  <Box variant="code" fontSize="body-s">{item.text}</Box>
                                )},
                                { id: 'score', header: 'Score', cell: item => item.score?.toFixed(3) || '-', width: 80 },
                                { id: 'chars', header: 'Chars', cell: item => item.charCount, width: 70 },
                              ]}
                              variant="embedded"
                              wrapLines
                            />
                          </SpaceBetween>
                        )
                      },
                      {
                        id: 'graph-sources',
                        label: `🔗 GraphRAG Sources (${lastGraphNodes.length})`,
                        content: (
                          <SpaceBetween size="s">
                            <Box color="text-body-secondary" variant="small">
                              These are the knowledge graph nodes (sources, topics, statements, facts) used by GraphRAG to answer this query.
                            </Box>
                            <Table
                              items={lastGraphNodes}
                              columnDefinitions={[
                                { id: 'type', header: 'Type', cell: item => <Badge color="blue">{item.type}</Badge>, width: 100 },
                                { id: 'name', header: 'Content', cell: item => (
                                  <Box variant="code" fontSize="body-s">{item.name}</Box>
                                )},
                              ]}
                              variant="embedded"
                              wrapLines
                            />
                          </SpaceBetween>
                        )
                      }
                    ]}
                  />
                </ExpandableSection>
              )}

              {/* Upload History (current session) */}
              {files.length > 0 && (
                <Container header={<Header variant="h2">Upload History (This Session)</Header>}>
                  <Table
                    items={files.slice(0, 10)}
                    columnDefinitions={[
                      { id: 'name', header: 'File', cell: item => item.name },
                      { id: 'size', header: 'Size', cell: item => item.size },
                      { id: 'status', header: 'Status', cell: item => getStatusIndicator(item.status) },
                    ]}
                    variant="embedded"
                  />
                </Container>
              )}

              {/* Stored Documents (from DynamoDB) */}
              <Container
                header={
                  <Header
                    variant="h2"
                    actions={<Button iconName="refresh" onClick={fetchStoredDocuments} loading={loadingDocs}>Refresh</Button>}
                  >
                    📁 Your Documents
                  </Header>
                }
              >
                {loadingDocs ? (
                  <Box textAlign="center" padding="l"><Spinner /> Loading documents...</Box>
                ) : storedDocuments.length === 0 ? (
                  <Box textAlign="center" color="text-body-secondary" padding="l">
                    No documents uploaded yet. Upload documents to build your knowledge graph.
                  </Box>
                ) : (
                  <Table
                    items={storedDocuments}
                    columnDefinitions={[
                      { id: 'fileName', header: 'File Name', cell: item => item.fileName || item.filename || 'Unknown' },
                      { id: 'tenantId', header: 'Tenant', cell: item => <Badge color="grey">{item.tenantId || 'unknown'}</Badge> },
                      { id: 'uploadedAt', header: 'Uploaded', cell: item => new Date(item.uploadedAt).toLocaleString() },
                      {
                        id: 'actions',
                        header: 'Actions',
                        cell: item => (
                          <Button
                            iconName="remove"
                            variant="icon"
                            onClick={() => handleDeleteDocument(item.s3Path)}
                          />
                        )
                      },
                    ]}
                    variant="embedded"
                  />
                )}
              </Container>
            </SpaceBetween>
          </ContentLayout>
        }
      />
    </>
  )
}
