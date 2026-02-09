import {
    SpaceBetween,
    Box,
    Button,
    ExpandableSection,
    Badge,
} from '@cloudscape-design/components'

export default function BrokerProfile() {
    const profileTemplate = `Name: [Your Full Name]
Company: [Your Company/Firm]
Role: [Your Role/Title]
Preferred News Feed: [Bloomberg, WSJ, Reuters, etc.]
Industry Interests: [technology, healthcare, energy, etc.]
Investment Strategy: [growth, value, dividend, etc.]
Risk Tolerance: [conservative, moderate, aggressive]
Client Demographics: [retail, institutional, high net worth, etc.]
Geographic Focus: [North America, Europe, Asia-Pacific, etc.]
Recent Interests: [specific sectors, trends, or companies]`

    const copyTemplate = () => {
        navigator.clipboard.writeText(profileTemplate)
    }

    return (
        <SpaceBetween size="m">
            <Box>
                <SpaceBetween size="xs">
                    <Box variant="h3">Quick Start</Box>
                    <Box variant="p" color="text-body-secondary">
                        Copy the template below and paste it into the chat to set up your
                        personalized broker profile.
                    </Box>
                </SpaceBetween>
            </Box>

            <ExpandableSection headerText="Broker Card Template" defaultExpanded>
                <SpaceBetween size="s">
                    <div
                        style={{
                            padding: '12px',
                            backgroundColor: '#f2f3f3',
                            fontFamily: 'monospace',
                            fontSize: '13px',
                            borderRadius: '4px',
                            border: '1px solid #e9ebed',
                        }}
                    >
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                            {profileTemplate}
                        </pre>
                    </div>
                    <Button iconName="copy" onClick={copyTemplate}>
                        Copy Template
                    </Button>
                </SpaceBetween>
            </ExpandableSection>

            <Box>
                <SpaceBetween size="xs">
                    <Box variant="h3">Features</Box>
                    <Box variant="p" color="text-body-secondary">
                        <ul style={{ margin: 0, paddingLeft: '20px' }}>
                            <li>Real-time stock data</li>
                            <li>Multi-source news aggregation</li>
                            <li>Personalized market analysis</li>
                            <li>Persistent memory across sessions</li>
                        </ul>
                    </Box>
                </SpaceBetween>
            </Box>

            <Box>
                <SpaceBetween size="xs">
                    <Box variant="h3">Example Query</Box>
                    <div
                        style={{
                            padding: '12px',
                            backgroundColor: '#ffffff',
                            borderRadius: '8px',
                            border: '1px solid #e9ebed',
                        }}
                    >
                        <Box variant="code">
                            "What's happening with AI and technology stocks today?"
                        </Box>
                    </div>
                </SpaceBetween>
            </Box>
        </SpaceBetween>
    )
}
