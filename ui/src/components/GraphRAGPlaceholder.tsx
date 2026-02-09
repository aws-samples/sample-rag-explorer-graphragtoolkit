import {
  Container,
  Header,
  Box,
  SpaceBetween,
  Button,
} from '@cloudscape-design/components'

export default function GraphRAGPlaceholder() {
  return (
    <Container
      header={
        <Header
          variant="h2"
          description="Knowledge graph-powered document analysis (Coming Soon)"
          actions={
            <Button disabled iconName="external">
              Launch Graph RAG
            </Button>
          }
        >
          🔗 Graph RAG Integration
        </Header>
      }
    >
      <SpaceBetween size="m">
        <Box>
          <SpaceBetween size="xs">
            <Box variant="h3">What is Graph RAG?</Box>
            <Box variant="p" color="text-body-secondary">
              Graph Retrieval-Augmented Generation combines knowledge graphs with
              LLMs to provide deeper insights from your financial documents and
              market data.
            </Box>
          </SpaceBetween>
        </Box>

        <div
          style={{
            padding: '24px',
            backgroundColor: '#f2f3f3',
            borderRadius: '8px',
            border: '1px solid #e9ebed',
          }}
        >
          <SpaceBetween size="s" alignItems="center">
            <Box textAlign="center" variant="h3" color="text-status-inactive">
              📊 Graph Database
            </Box>
            <Box textAlign="center" variant="p" color="text-body-secondary">
              Neptune Analytics for relationship mapping
            </Box>
          </SpaceBetween>
        </div>

        <Box>
          <SpaceBetween size="xs">
            <Box variant="h3">Planned Features</Box>
            <Box variant="p" color="text-body-secondary">
              <ul style={{ margin: 0, paddingLeft: '20px' }}>
                <li>Document knowledge extraction</li>
                <li>Entity relationship mapping</li>
                <li>Multi-hop reasoning queries</li>
                <li>Visual graph exploration</li>
              </ul>
            </Box>
          </SpaceBetween>
        </Box>

        <Box textAlign="center" padding="s">
          <Box variant="small" color="text-status-inactive">
            This section will be activated once the Graph RAG solution is deployed
          </Box>
        </Box>
      </SpaceBetween>
    </Container>
  )
}
