import { useState } from 'react'
import {
  SpaceBetween,
  Button,
  Textarea,
  Box,
  Alert,
  Spinner,
  Select,
} from '@cloudscape-design/components'
import MessageFormatter from './MessageFormatter'
import { useChatContext } from '../context/ChatContext'

interface Message {
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

export default function ChatInterface() {
  const { messages, addMessage, clearMessages } = useChatContext()
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [displayMode, setDisplayMode] = useState<'markdown' | 'simple' | 'structured'>('structured')

  const sendMessage = async () => {
    if (!input.trim()) return

    const userMessage: Message = {
      role: 'user',
      content: input,
      timestamp: new Date(),
    }

    addMessage(userMessage)
    setInput('')
    setLoading(true)
    setError(null)

    try {
      // Call the local API proxy which invokes the deployed agent
      // Add timeout to prevent hanging indefinitely
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 60000) // 60 second timeout
      
      const response = await fetch('http://localhost:5001/api/invoke-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: userMessage.content }),
        signal: controller.signal
      })
      
      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`API error: ${response.statusText}`)
      }

      const data = await response.json()
      
      if (data.error) {
        throw new Error(data.error)
      }
      
      const assistantMessage: Message = {
        role: 'assistant',
        content: data.response || 'No response received',
        timestamp: new Date(),
      }

      addMessage(assistantMessage)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setError('Request timed out after 60 seconds. The agent may be processing complex queries. Please try again.')
      } else {
        setError('Failed to send message. Please try again.')
      }
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <SpaceBetween size="m">
      {/* Display Mode Selector and Clear Button */}
      <SpaceBetween direction="horizontal" size="s">
        <Box float="right">
          <Select
            selectedOption={{ label: displayMode === 'markdown' ? 'Markdown' : displayMode === 'simple' ? 'Simple' : 'Structured', value: displayMode }}
            onChange={({ detail }) => setDisplayMode(detail.selectedOption.value as any)}
            options={[
              { label: 'Structured (Recommended)', value: 'structured' },
              { label: 'Markdown', value: 'markdown' },
              { label: 'Simple Text', value: 'simple' },
            ]}
            selectedAriaLabel="Selected"
          />
        </Box>
        {messages.length > 0 && (
          <Button
            variant="normal"
            iconName="remove"
            onClick={clearMessages}
          >
            Clear Chat
          </Button>
        )}
      </SpaceBetween>

      {/* Messages Display */}
      <Box padding={{ vertical: 's' }}>
        <div
          style={{
            maxHeight: '500px',
            overflowY: 'auto',
            padding: '16px',
            backgroundColor: '#f9f9f9',
            borderRadius: '8px',
          }}
        >
          {messages.length === 0 ? (
            <Box textAlign="center" color="text-body-secondary" padding="xxl">
              <SpaceBetween size="s">
                <Box variant="h3">Welcome to Graph Agent</Box>
                <Box>
                  Start by introducing yourself with your broker profile, or ask
                  about your documents using GraphRAG or Vector RAG.
                </Box>
              </SpaceBetween>
            </Box>
          ) : (
            <SpaceBetween size="m">
              {messages.map((msg, idx) => (
                <div
                  key={idx}
                  style={{
                    padding: '16px',
                    backgroundColor: msg.role === 'user' ? '#ffffff' : '#f2f3f3',
                    borderRadius: '8px',
                    border: '1px solid #e9ebed',
                  }}
                >
                  <SpaceBetween size="xs">
                    <Box
                      variant="strong"
                      color={msg.role === 'user' ? 'text-status-info' : 'text-status-success'}
                    >
                      {msg.role === 'user' ? '👤 You' : '🤖 Agent'}
                    </Box>
                    {msg.role === 'assistant' ? (
                      <MessageFormatter content={msg.content} variant={displayMode} />
                    ) : (
                      <Box>{msg.content}</Box>
                    )}
                    <Box variant="small" color="text-body-secondary">
                      {msg.timestamp.toLocaleTimeString()}
                    </Box>
                  </SpaceBetween>
                </div>
              ))}
            </SpaceBetween>
          )}
        </div>
      </Box>

      {/* Error Display */}
      {error && (
        <Alert type="error" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Input Area */}
      <SpaceBetween size="s">
        <Textarea
          value={input}
          onChange={({ detail }) => setInput(detail.value)}
          placeholder="Ask a question about your uploaded documents..."
          rows={3}
          disabled={loading}
        />
        <Box float="right">
          <Button
            variant="primary"
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            iconName={loading ? undefined : 'angle-right-double'}
          >
            {loading ? <Spinner /> : 'Send'}
          </Button>
        </Box>
      </SpaceBetween>
    </SpaceBetween>
  )
}
