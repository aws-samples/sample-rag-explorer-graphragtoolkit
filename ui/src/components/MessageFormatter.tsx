import { Box, SpaceBetween } from '@cloudscape-design/components'
import ReactMarkdown from 'react-markdown'

interface MessageFormatterProps {
  content: string
  variant?: 'markdown' | 'simple' | 'structured'
}

export default function MessageFormatter({ content, variant = 'markdown' }: MessageFormatterProps) {
  // Clean up escaped newlines and formatting
  const cleanContent = content
    .replace(/\\n/g, '\n')
    .replace(/\*\*/g, '')
    .trim()

  if (variant === 'simple') {
    // Simple: Just clean text with line breaks
    return (
      <Box>
        {cleanContent.split('\n').map((line, idx) => (
          <Box key={idx} margin={{ bottom: line.trim() ? 'xs' : 'n' }}>
            {line || <br />}
          </Box>
        ))}
      </Box>
    )
  }

  if (variant === 'structured') {
    // Structured: Parse sections and format nicely
    const sections = cleanContent.split('\n\n')
    
    return (
      <SpaceBetween size="m">
        {sections.map((section, idx) => {
          const lines = section.split('\n')
          const isHeader = lines[0].startsWith('#') || lines[0].includes(':')
          
          return (
            <Box key={idx}>
              {lines.map((line, lineIdx) => {
                // Check for emoji bullets
                const hasEmoji = /^[🚀📈⚠️💡📊🔗👤💬]/.test(line)
                const isBullet = line.trim().startsWith('-') || line.trim().startsWith('*')
                
                if (line.startsWith('##')) {
                  return (
                    <Box key={lineIdx} variant="h3" margin={{ bottom: 'xs' }}>
                      {line.replace(/^##\s*/, '')}
                    </Box>
                  )
                }
                
                if (hasEmoji || isBullet) {
                  return (
                    <Box 
                      key={lineIdx} 
                      margin={{ left: 's', bottom: 'xxs' }}
                      color="text-body-secondary"
                    >
                      {line.replace(/^[-*]\s*/, '')}
                    </Box>
                  )
                }
                
                if (isHeader && lineIdx === 0) {
                  return (
                    <Box key={lineIdx} variant="strong" fontSize="heading-s">
                      {line.replace(/\*\*/g, '')}
                    </Box>
                  )
                }
                
                return (
                  <Box key={lineIdx} margin={{ bottom: 'xxs' }}>
                    {line || <br />}
                  </Box>
                )
              })}
            </Box>
          )
        })}
      </SpaceBetween>
    )
  }

  // Markdown: Full markdown rendering (default)
  return (
    <div className="markdown-content">
      <ReactMarkdown
        components={{
          h1: ({ children }) => <Box variant="h1" margin={{ bottom: 's' }}>{children}</Box>,
          h2: ({ children }) => <Box variant="h2" margin={{ bottom: 's', top: 'm' }}>{children}</Box>,
          h3: ({ children }) => <Box variant="h3" margin={{ bottom: 'xs', top: 's' }}>{children}</Box>,
          p: ({ children }) => <Box margin={{ bottom: 's' }}>{children}</Box>,
          strong: ({ children }) => <Box variant="strong">{children}</Box>,
          ul: ({ children }) => <Box margin={{ left: 's', bottom: 's' }}>{children}</Box>,
          li: ({ children }) => (
            <Box margin={{ bottom: 'xxs' }}>
              • {children}
            </Box>
          ),
        }}
      >
        {cleanContent}
      </ReactMarkdown>
    </div>
  )
}
