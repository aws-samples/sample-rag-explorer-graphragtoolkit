import { useState } from 'react'
import {
  AppLayout,
  ContentLayout,
  Header,
  Container,
  SpaceBetween,
  Button,
  Box,
  Alert,
  ProgressBar,
  Table,
  StatusIndicator,
} from '@cloudscape-design/components'
import { Link } from 'react-router-dom'
import { config } from '../config'

interface UploadedFile {
  name: string
  size: string
  status: 'uploading' | 'processing' | 'completed' | 'error'
  timestamp: Date
}

export default function DocumentUpload() {
  const [files, setFiles] = useState<UploadedFile[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = event.target.files
    if (!selectedFiles || selectedFiles.length === 0) return

    setUploading(true)
    setError(null)
    setSuccess(null)

    for (const file of Array.from(selectedFiles)) {
      const newFile: UploadedFile = {
        name: file.name,
        size: formatFileSize(file.size),
        status: 'uploading',
        timestamp: new Date(),
      }
      setFiles(prev => [newFile, ...prev])

      try {
        // Upload directly to S3 via presigned URL from API
        const formData = new FormData()
        formData.append('file', file)
        
        const uploadRes = await fetch(`${config.apiUrl}/upload?tenant_id=default`, {
          method: 'POST',
          body: formData,
        })

        if (!uploadRes.ok) {
          const errorData = await uploadRes.json().catch(() => ({}))
          throw new Error(errorData.detail || 'Failed to upload document')
        }

        // Update status to processing (S3 trigger will handle indexing)
        setFiles(prev => prev.map(f => 
          f.name === file.name ? { ...f, status: 'processing' as const } : f
        ))

        const result = await uploadRes.json()

        // Update status to completed
        setFiles(prev => prev.map(f => 
          f.name === file.name ? { ...f, status: 'completed' as const } : f
        ))
        setSuccess(`${file.name} uploaded and indexed! (${result.chunks_created || 0} chunks created)`)
      } catch (err) {
        setFiles(prev => prev.map(f => 
          f.name === file.name ? { ...f, status: 'error' as const } : f
        ))
        setError(`Failed to upload ${file.name}`)
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

  return (
    <AppLayout
      navigationHide
      toolsHide
      content={
        <ContentLayout
          header={
            <Header
              variant="h1"
              description="Upload documents to build your knowledge graph"
              actions={
                <Link to="/" style={{ textDecoration: 'none' }}>
                  <Button>← Back to Chat</Button>
                </Link>
              }
            >
              Document Upload
            </Header>
          }
        >
          <SpaceBetween size="l">
            {error && (
              <Alert type="error" dismissible onDismiss={() => setError(null)}>
                {error}
              </Alert>
            )}
            {success && (
              <Alert type="success" dismissible onDismiss={() => setSuccess(null)}>
                {success}
              </Alert>
            )}

            <Container
              header={<Header variant="h2">Upload Documents</Header>}
            >
              <SpaceBetween size="m">
                <Box>
                  Upload PDF or TXT documents. They will be processed and stored 
                  in Neptune Analytics as a knowledge graph for GraphRAG queries.
                </Box>
                
                <input
                  type="file"
                  id="file-upload"
                  multiple
                  accept=".txt,.md"
                  style={{ display: 'none' }}
                  onChange={handleFileSelect}
                />
                <Button
                  variant="primary"
                  iconName="upload"
                  loading={uploading}
                  onClick={() => document.getElementById('file-upload')?.click()}
                >
                  {uploading ? 'Uploading...' : 'Select Files to Upload'}
                </Button>

                {uploading && (
                  <ProgressBar
                    status="in-progress"
                    label="Processing documents..."
                  />
                )}
              </SpaceBetween>
            </Container>

            {files.length > 0 && (
              <Container
                header={<Header variant="h2">Upload History</Header>}
              >
                <Table
                  items={files}
                  columnDefinitions={[
                    { id: 'name', header: 'File Name', cell: item => item.name },
                    { id: 'size', header: 'Size', cell: item => item.size },
                    { id: 'status', header: 'Status', cell: item => getStatusIndicator(item.status) },
                    { id: 'time', header: 'Time', cell: item => item.timestamp.toLocaleTimeString() },
                  ]}
                  empty={<Box textAlign="center">No files uploaded yet</Box>}
                />
              </Container>
            )}
          </SpaceBetween>
        </ContentLayout>
      }
    />
  )
}
