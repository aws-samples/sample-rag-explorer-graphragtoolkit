import { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react'
import * as d3 from 'd3'
import { Box, Button, Spinner } from '@cloudscape-design/components'

interface Node {
  id: string
  name: string
  type: string
  description: string
  x?: number
  y?: number
  fx?: number | null
  fy?: number | null
}

interface Link {
  source: string | Node
  target: string | Node
  type: string
}

interface GraphData {
  nodes: Node[]
  links: Link[]
}

interface GraphVisualizationProps {
  apiUrl: string
  tenantId?: string
  onFetch?: (url: string, options?: RequestInit) => Promise<Response>
}

export interface GraphVisualizationRef {
  refresh: () => void
}

const GraphVisualization = forwardRef<GraphVisualizationRef, GraphVisualizationProps>(
  ({ apiUrl, tenantId = 'demo', onFetch }, ref) => {
  const svgRef = useRef<SVGSVGElement>(null)
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<GraphData>({ nodes: [], links: [] })
  const [error, setError] = useState<string | null>(null)

  const fetchGraphData = async () => {
    setLoading(true)
    setError(null)
    try {
      const baseUrl = apiUrl.replace(/\/$/, '')
      const url = `${baseUrl}/graph-visualization?tenant_id=${encodeURIComponent(tenantId)}&limit=100`
      
      const res = onFetch 
        ? await onFetch(url, { method: 'GET' })
        : await fetch(url, { method: 'GET', mode: 'cors' })
      
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const graphData = await res.json()
      console.log('Graph data:', graphData)
      setData(graphData)
    } catch (err) {
      console.error('Failed to fetch graph data:', err)
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  // Expose refresh method to parent
  useImperativeHandle(ref, () => ({
    refresh: fetchGraphData
  }))

  useEffect(() => {
    if (apiUrl) {
      fetchGraphData()
    }
  }, [apiUrl, tenantId])

  useEffect(() => {
    if (!svgRef.current || data.nodes.length === 0) return

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const width = 400
    const height = 300

    // Color scale for node types
    const color = d3.scaleOrdinal<string>()
      .domain(['document', 'person', 'company', 'concept', 'location', 'date', 'organization', 'chunk', 'entity'])
      .range(['#0972d3', '#037f0c', '#d91515', '#9469d6', '#eb5f07', '#067d68', '#5f6b7a', '#8b5cf6', '#06b6d4'])

    // Create simulation
    const simulation = d3.forceSimulation<Node>(data.nodes)
      .force('link', d3.forceLink<Node, Link>(data.links).id(d => d.id).distance(80))
      .force('charge', d3.forceManyBody().strength(-200))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(30))

    // Add zoom
    const g = svg.append('g')
    svg.call(d3.zoom<SVGSVGElement, unknown>()
      .extent([[0, 0], [width, height]])
      .scaleExtent([0.5, 3])
      .on('zoom', (event) => g.attr('transform', event.transform)))

    // Draw links
    const link = g.append('g')
      .selectAll('line')
      .data(data.links)
      .join('line')
      .attr('stroke', '#999')
      .attr('stroke-opacity', 0.6)
      .attr('stroke-width', 1.5)

    // Draw nodes
    const node = g.append('g')
      .selectAll<SVGCircleElement, Node>('circle')
      .data(data.nodes)
      .join('circle')
      .attr('r', d => d.type === 'document' ? 12 : 8)
      .attr('fill', d => color(d.type))
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.5)
      .call(d3.drag<SVGCircleElement, Node>()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart()
          d.fx = d.x
          d.fy = d.y
        })
        .on('drag', (event, d) => {
          d.fx = event.x
          d.fy = event.y
        })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0)
          d.fx = null
          d.fy = null
        }))

    // Add labels
    const labels = g.append('g')
      .selectAll('text')
      .data(data.nodes)
      .join('text')
      .text(d => d.name.length > 15 ? d.name.slice(0, 15) + '...' : d.name)
      .attr('font-size', '9px')
      .attr('dx', 12)
      .attr('dy', 3)
      .attr('fill', '#333')

    // Add tooltips
    node.append('title')
      .text(d => `${d.name}\nType: ${d.type}\n${d.description}`)

    // Update positions on tick
    simulation.on('tick', () => {
      link
        .attr('x1', d => (d.source as Node).x!)
        .attr('y1', d => (d.source as Node).y!)
        .attr('x2', d => (d.target as Node).x!)
        .attr('y2', d => (d.target as Node).y!)

      node
        .attr('cx', d => d.x!)
        .attr('cy', d => d.y!)

      labels
        .attr('x', d => d.x!)
        .attr('y', d => d.y!)
    })

    return () => {
      simulation.stop()
    }
  }, [data])

  if (loading) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> Loading graph...
      </Box>
    )
  }

  if (error) {
    return (
      <Box textAlign="center" color="text-status-error" padding="m">
        Error: {error}
        <Box margin={{ top: 's' }}>
          <Button onClick={fetchGraphData}>Retry</Button>
        </Box>
      </Box>
    )
  }

  if (data.nodes.length === 0) {
    return (
      <Box textAlign="center" color="text-body-secondary" padding="m">
        No nodes yet. Upload documents to build the graph.
        <Box margin={{ top: 's' }}>
          <Button onClick={fetchGraphData} iconName="refresh">Refresh</Button>
        </Box>
      </Box>
    )
  }

  return (
    <div>
      <Box float="right">
        <Button iconName="refresh" variant="icon" onClick={fetchGraphData} />
      </Box>
      <svg
        ref={svgRef}
        width="100%"
        height="300"
        style={{ border: '1px solid #e9ebed', borderRadius: '8px', background: '#fafafa' }}
      />
      <Box variant="small" color="text-body-secondary" textAlign="center">
        {data.nodes.length} nodes, {data.links.length} relationships
      </Box>
    </div>
  )
})

export default GraphVisualization
