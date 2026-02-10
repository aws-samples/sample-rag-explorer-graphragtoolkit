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
} from '@cloudscape-design/components'
import { fetchAuthSession } from '@aws-amplify/auth'
import MessageFormatter from '../components/MessageFormatter'
import GraphVisualization, { GraphVisualizationRef } from '../components/GraphVisualization'
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
  filename?: string  // fallback for old records
  uploadedAt: string
  fileSize?: number
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
  const [tenantId] = useState('demo')
  const [userId, setUserId] = useState<string>('anonymous')
  const graphVisualizationRef = useRef<GraphVisualizationRef>(null)

  useEffect(() => {
    loadConfig().then((cfg) => {
      setApiUrl(cfg.queryApiUrl)
      setUploadUrl(cfg.uploadApiUrl)
    })
    
    // Get user identity ID from Cognito
    fetchAuthSession().then((session) => {
      if (session.identityId) {
        setUserId(session.identityId)
      }
    }).catch(console.error)
  }, [])

  useEffect(() => {
    if (apiUrl) {
      fetchGraphStats()
    }
  }, [apiUrl])

  useEffect(() => {
    if (uploadUrl && userId !== 'anonymous') {
      fetchStoredDocuments()
    }
  }, [uploadUrl, userId])

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
      const res = await signedFetch(`${baseUrl}/reset-graph?tenant_id=${tenantId}`, { method: 'POST' })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Reset failed: ${text}`)
      }
      setUploadSuccess('Graph database reset successfully!')
      setGraphMessages([])
      setVectorMessages([])
      setFiles([])
      await fetchStoredDocuments()
      // Refresh the graph visualization
      graphVisualizationRef.current?.refresh()
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
        
        // Read file as base64
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
        setUploadSuccess(`${file.name} uploaded! (${data.chunks_created} chunks created)`)
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

  const signedFetchWrapper = async (url: string, options?: RequestInit) => {
    return signedFetch(url, options)
  }

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
                    <Box variant="awsui-key-label">Tenant</Box>
                    <Box>{tenantId}</Box>
                  </div>
                  <div>
                    <input type="file" id="file-upload" multiple accept=".txt,.pdf" style={{ display: 'none' }} onChange={handleFileSelect} />
                    <Button iconName="upload" loading={uploading} onClick={() => document.getElementById('file-upload')?.click()}>
                      Upload Document
                    </Button>
                  </div>
                  <div>
                    <Button iconName="refresh" onClick={fetchGraphStats}>Refresh</Button>
                  </div>
                </ColumnLayout>
              </Container>

              {error && <Alert type="error" dismissible onDismiss={() => setError(null)}>{error}</Alert>}
              {uploadSuccess && <Alert type="success" dismissible onDismiss={() => setUploadSuccess(null)}>{uploadSuccess}</Alert>}

              {/* Knowledge Graph Visualization */}
              <ExpandableSection headerText="🔗 Knowledge Graph Visualization" defaultExpanded={false}>
                <Container>
                  {apiUrl && (
                    <GraphVisualization 
                      ref={graphVisualizationRef}
                      apiUrl={apiUrl} 
                      tenantId={tenantId}
                      onFetch={signedFetchWrapper}
                    />
                  )}
                </Container>
              </ExpandableSection>

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
