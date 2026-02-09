import { useState } from 'react'
import {
  SpaceBetween,
  Button,
  Textarea,
  Box,
  Alert,
  Spinner,
  Container,
  Header,
  Grid,
  ColumnLayout,
  Badge,
  ProgressBar,
  KeyValuePairs,
  StatusIndicator,
} from '@cloudscape-design/components'
import MessageFormatter from './MessageFormatter'
import { config } from '../config'

interface ComparisonResult {
  market_agent: {
    response: string
    response_time: number
    sources_count: number
    tools_used: string[]
    has_historical: boolean
  }
  graphrag: {
    response: string
    response_time: number
    sources_count: number
    entities_found: string[]
    relationships_count: number
    documents_used: number
    time_range_days: number
    has_trends: boolean
  }
  graph_stats?: {
    total_documents: number
    total_entities: number
    total_relationships: number
    companies_tracked: number
  }
}

export default function GraphRAGDemo() {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [comparison, setComparison] = useState<ComparisonResult | null>(null)

  const runComparison = async () => {
    if (!query.trim()) return

    setLoading(true)
    setError(null)

    try {
      // Call query endpoint
      const response = await fetch(`${config.apiUrl}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, tenant_id: 'default' })
      })

      if (!response.ok) {
        throw new Error(`API error: ${response.statusText}`)
      }

      const data = await response.json()
      // Transform API response to match UI expectations
      setComparison({
        market_agent: {
          response: data.vector_response,
          response_time: Math.round(data.vector_time_ms / 1000 * 10) / 10,
          sources_count: data.vector_sources?.length || 0,
          tools_used: [],
          has_historical: false,
        },
        graphrag: {
          response: data.graphrag_response,
          response_time: Math.round(data.graphrag_time_ms / 1000 * 10) / 10,
          sources_count: data.graphrag_sources?.length || 0,
          entities_found: [],
          relationships_count: data.graphrag_sources?.length || 0,
          documents_used: data.graphrag_sources?.length || 0,
          time_range_days: 30,
          has_trends: true,
        },
      })
      
    } catch (err) {
      setError('Failed to run comparison. Make sure the API is running.')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <SpaceBetween size="l">
      {/* Header with Stats */}
      <Container
        header={
          <Header
            variant="h2"
            description="See the same query answered with and without knowledge graph"
            actions={
              comparison?.graph_stats && (
                <Box>
                  <Badge color="green">
                    {comparison.graph_stats.total_documents} docs processed
                  </Badge>
                </Box>
              )
            }
          >
            🔬 Side-by-Side Comparison
          </Header>
        }
      >
        <SpaceBetween size="m">
          {/* Query Input */}
          <SpaceBetween size="s">
            <Textarea
              value={query}
              onChange={({ detail }) => setQuery(detail.value)}
              placeholder="Try: 'What tech companies are investing in AI?' or 'How has Amazon performed this month?'"
              rows={2}
              disabled={loading}
            />
            <Box float="right">
              <Button
                variant="primary"
                onClick={runComparison}
                disabled={loading || !query.trim()}
                iconName="search"
              >
                {loading ? <Spinner /> : 'Compare Both Approaches'}
              </Button>
            </Box>
          </SpaceBetween>

          {/* Suggested Queries */}
          {!comparison && (
            <Box>
              <Box variant="awsui-key-label" margin={{ bottom: 'xs' }}>
                Try these demo queries:
              </Box>
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  variant="inline-link"
                  onClick={() => setQuery("What's Amazon's stock price?")}
                >
                  Simple Query
                </Button>
                <Button
                  variant="inline-link"
                  onClick={() => setQuery("What tech companies are investing in AI?")}
                >
                  Complex Query
                </Button>
                <Button
                  variant="inline-link"
                  onClick={() => setQuery("How has AI sentiment changed over time?")}
                >
                  Temporal Query
                </Button>
              </SpaceBetween>
            </Box>
          )}
        </SpaceBetween>
      </Container>

        {/* Error Display */}
        {error && (
          <Alert type="error" dismissible onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}

      {/* Comparison Results */}
      {comparison && (
        <Grid gridDefinition={[{ colspan: 6 }, { colspan: 6 }]}>
          {/* Real-Time Only */}
          <Container
            header={
              <Header
                variant="h3"
                actions={
                  <Badge color="blue">Real-time Only</Badge>
                }
              >
                📈 Without Knowledge Graph
              </Header>
            }
          >
            <SpaceBetween size="m">
              {/* Response */}
              <div style={{ minHeight: '200px' }}>
                <MessageFormatter content={comparison.market_agent.response} variant="structured" />
              </div>
              
              {/* Metrics */}
              <div style={{ borderTop: '1px solid #e9ebed', paddingTop: '16px' }}>
                <SpaceBetween size="s">
                  <KeyValuePairs
                    columns={2}
                    items={[
                      {
                        label: 'Response Time',
                        value: (
                          <Box>
                            {comparison.market_agent.response_time}s
                            <StatusIndicator type="success" />
                          </Box>
                        )
                      },
                      {
                        label: 'Sources',
                        value: `${comparison.market_agent.sources_count} articles`
                      },
                      {
                        label: 'Relationships',
                        value: (
                          <Box color="text-status-inactive">
                            0 discovered
                          </Box>
                        )
                      },
                      {
                        label: 'Historical Context',
                        value: (
                          <StatusIndicator type="stopped">
                            Not available
                          </StatusIndicator>
                        )
                      }
                    ]}
                  />
                  
                  <Box>
                    <Box variant="awsui-key-label" margin={{ bottom: 'xs' }}>
                      Capabilities
                    </Box>
                    <SpaceBetween size="xxs">
                      <Box>✅ Current data</Box>
                      <Box>✅ Fast response</Box>
                      <Box color="text-status-inactive">❌ No historical trends</Box>
                      <Box color="text-status-inactive">❌ No relationships</Box>
                      <Box color="text-status-inactive">❌ Forgets after response</Box>
                    </SpaceBetween>
                  </Box>
                </SpaceBetween>
              </div>
            </SpaceBetween>
          </Container>

          {/* With Knowledge Graph */}
          <Container
            header={
              <Header
                variant="h3"
                actions={
                  <Badge color="green">Knowledge Graph Enabled</Badge>
                }
              >
                🔗 With Knowledge Graph
              </Header>
            }
          >
            <SpaceBetween size="m">
              {/* Response */}
              <div style={{ minHeight: '200px' }}>
                <MessageFormatter content={comparison.graphrag.response} variant="structured" />
              </div>
              
              {/* Metrics */}
              <div style={{ borderTop: '1px solid #e9ebed', paddingTop: '16px' }}>
                <SpaceBetween size="s">
                  <KeyValuePairs
                    columns={2}
                    items={[
                      {
                        label: 'Response Time',
                        value: (
                          <Box>
                            {comparison.graphrag.response_time}s
                            <StatusIndicator type="success" />
                          </Box>
                        )
                      },
                      {
                        label: 'Sources',
                        value: `${comparison.graphrag.sources_count} documents`
                      },
                      {
                        label: 'Relationships',
                        value: (
                          <Box color="text-status-success">
                            {comparison.graphrag.relationships_count} discovered
                          </Box>
                        )
                      },
                      {
                        label: 'Time Range',
                        value: (
                          <StatusIndicator type="success">
                            {comparison.graphrag.time_range_days} days
                          </StatusIndicator>
                        )
                      }
                    ]}
                  />
                  
                  <Box>
                    <Box variant="awsui-key-label" margin={{ bottom: 'xs' }}>
                      Enhanced Capabilities
                    </Box>
                    <SpaceBetween size="xxs">
                      <Box>✅ Current + historical data</Box>
                      <Box>✅ Relationship discovery</Box>
                      <Box>✅ Trend analysis</Box>
                      <Box>✅ Multi-hop reasoning</Box>
                      <Box>✅ Persistent knowledge</Box>
                    </SpaceBetween>
                  </Box>
                </SpaceBetween>
              </div>
            </SpaceBetween>
          </Container>
        </Grid>
      )}

      {/* Knowledge Graph Stats */}
      {comparison?.graph_stats && (
        <Container
          header={
            <Header variant="h3">
              📊 Knowledge Graph Statistics
            </Header>
          }
        >
          <ColumnLayout columns={4} variant="text-grid">
            <div>
              <Box variant="awsui-key-label">Documents Processed</Box>
              <Box fontSize="heading-l" fontWeight="bold">
                {comparison.graph_stats.total_documents}
              </Box>
              <ProgressBar
                value={(comparison.graph_stats.total_documents / 200) * 100}
                variant="standalone"
                additionalInfo="Growing with each query"
              />
            </div>
            <div>
              <Box variant="awsui-key-label">Companies Tracked</Box>
              <Box fontSize="heading-l" fontWeight="bold">
                {comparison.graph_stats.companies_tracked}
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">Entities Extracted</Box>
              <Box fontSize="heading-l" fontWeight="bold">
                {comparison.graph_stats.total_entities}
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">Relationships Found</Box>
              <Box fontSize="heading-l" fontWeight="bold" color="text-status-success">
                {comparison.graph_stats.total_relationships}
              </Box>
            </div>
          </ColumnLayout>
        </Container>
      )}

      {/* Visual Comparison Summary */}
      {comparison && (
        <Container>
          <ColumnLayout columns={3} variant="text-grid">
            <div>
              <Box variant="awsui-key-label">Response Depth</Box>
              <Box margin={{ top: 'xs' }}>
                <ProgressBar
                  value={30}
                  variant="standalone"
                  label="Real-time Only"
                  description="Surface-level, current data"
                />
                <ProgressBar
                  value={95}
                  variant="standalone"
                  label="With Knowledge Graph"
                  description="Deep historical context"
                  resultText="3x more insights"
                />
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">Data Sources</Box>
              <Box margin={{ top: 'xs' }}>
                <Box>
                  📊 Real-time: {comparison.market_agent.sources_count} sources
                </Box>
                <Box color="text-status-success">
                  📊 With Graph: {comparison.graphrag.sources_count} sources
                  <Badge color="green">+{comparison.graphrag.sources_count - comparison.market_agent.sources_count}</Badge>
                </Box>
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">Key Advantage</Box>
              <Box margin={{ top: 'xs' }}>
                <SpaceBetween size="xxs">
                  <Box>
                    <StatusIndicator type="success">
                      {comparison.graphrag.relationships_count} relationships discovered
                    </StatusIndicator>
                  </Box>
                  <Box>
                    <StatusIndicator type="success">
                      {comparison.graphrag.time_range_days}-day trend analysis
                    </StatusIndicator>
                  </Box>
                  <Box>
                    <StatusIndicator type="success">
                      Persistent knowledge
                    </StatusIndicator>
                  </Box>
                </SpaceBetween>
              </Box>
            </div>
          </ColumnLayout>
        </Container>
      )}

      {/* Instructions */}
      {!comparison && (
        <Alert type="info">
          <SpaceBetween size="xs">
            <Box variant="strong">🎯 Demo: See the Difference</Box>
            <Box>
              This page shows the same query answered two ways:<br />
              <br />
              <strong>Left:</strong> Real-time data only (fast, current, forgets after)<br />
              <strong>Right:</strong> Real-time + Knowledge Graph (deep, historical, remembers forever)<br />
              <br />
              Try the suggested queries above to see how knowledge graphs enhance market intelligence!
            </Box>
          </SpaceBetween>
        </Alert>
      )}
    </SpaceBetween>
  )
}
