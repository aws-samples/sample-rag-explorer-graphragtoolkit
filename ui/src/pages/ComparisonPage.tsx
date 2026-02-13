import {
  AppLayout,
  ContentLayout,
  Header,
  SpaceBetween,
} from '@cloudscape-design/components'
import GraphRAGDemo from '../components/GraphRAGDemo'

export default function ComparisonPage() {
  return (
    <AppLayout
      navigationHide
      toolsHide
      content={
        <ContentLayout
          header={
            <Header
              variant="h1"
              description="Side-by-side comparison of RAG approaches"
            >
              Agent Comparison Lab
            </Header>
          }
        >
          <SpaceBetween size="l">
            <GraphRAGDemo />
          </SpaceBetween>
        </ContentLayout>
      }
    />
  )
}
