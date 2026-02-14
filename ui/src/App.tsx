import { useEffect, useState } from 'react';
import { Amplify } from 'aws-amplify';
import { signIn, signUp, signOut, confirmSignUp, getCurrentUser, fetchAuthSession } from '@aws-amplify/auth';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import {
  AppLayout,
  ContentLayout,
  Header,
  Container,
  SpaceBetween,
  Button,
  Input,
  FormField,
  Alert,
  Spinner,
  Box,
} from '@cloudscape-design/components';
import GraphRAGChat from './pages/GraphRAGChat';
import { loadConfig } from './config';

type AuthState = 'loading' | 'signIn' | 'signUp' | 'confirmSignUp' | 'authenticated';

function App() {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);

  useEffect(() => {
    initializeApp();
  }, []);

  const initializeApp = async () => {
    try {
      const appConfig = await loadConfig();
      
      // Only configure Amplify if auth is available
      if (appConfig.auth.user_pool_id) {
        Amplify.configure({
          Auth: {
            Cognito: {
              userPoolId: appConfig.auth.user_pool_id,
              userPoolClientId: appConfig.auth.user_pool_client_id,
              identityPoolId: appConfig.auth.identity_pool_id,
            },
          },
        });

        // Check if user is already signed in
        try {
          await getCurrentUser();
          setAuthState('authenticated');
        } catch {
          setAuthState('signIn');
        }
      } else {
        // No auth configured (local dev), skip auth
        setAuthState('authenticated');
      }
      setConfigLoaded(true);
    } catch (err) {
      console.error('Failed to initialize app:', err);
      setError('Failed to load configuration');
      setAuthState('signIn');
      setConfigLoaded(true);
    }
  };

  const handleSignIn = async () => {
    setLoading(true);
    setError(null);
    try {
      await signIn({ username: email, password });
      setAuthState('authenticated');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Sign in failed';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async () => {
    setLoading(true);
    setError(null);
    try {
      await signUp({
        username: email,
        password,
        options: { userAttributes: { email } },
      });
      setAuthState('confirmSignUp');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Sign up failed';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmSignUp = async () => {
    setLoading(true);
    setError(null);
    try {
      await confirmSignUp({ username: email, confirmationCode: confirmCode });
      // Auto sign in after confirmation
      await signIn({ username: email, password });
      setAuthState('authenticated');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Confirmation failed';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut();
      setAuthState('signIn');
      setEmail('');
      setPassword('');
    } catch (err) {
      console.error('Sign out error:', err);
    }
  };

  if (authState === 'loading' || !configLoaded) {
    return (
      <AppLayout
        navigationHide
        toolsHide
        content={
          <ContentLayout>
            <Container>
              <Box textAlign="center" padding="xxl">
                <Spinner size="large" />
                <Box variant="p" margin={{ top: 'm' }}>Loading...</Box>
              </Box>
            </Container>
          </ContentLayout>
        }
      />
    );
  }

  if (authState === 'authenticated') {
    return <GraphRAGChat onSignOut={handleSignOut} />;
  }

  // Auth forms
  return (
    <AppLayout
      navigationHide
      toolsHide
      content={
        <ContentLayout
          header={<Header variant="h1">RAG Explorer</Header>}
        >
          <Container
            header={
              <Header variant="h2">
                {authState === 'signIn' ? 'Sign In' : authState === 'signUp' ? 'Create Account' : 'Confirm Email'}
              </Header>
            }
          >
            <SpaceBetween size="l">
              {error && (
                <Alert type="error" dismissible onDismiss={() => setError(null)}>
                  {error}
                </Alert>
              )}

              {authState === 'confirmSignUp' ? (
                <>
                  <FormField label="Confirmation Code" description="Check your email for the code">
                    <Input
                      value={confirmCode}
                      onChange={({ detail }) => setConfirmCode(detail.value)}
                      placeholder="Enter confirmation code"
                    />
                  </FormField>
                  <SpaceBetween direction="horizontal" size="s">
                    <Button onClick={handleConfirmSignUp} loading={loading} variant="primary">
                      Confirm
                    </Button>
                    <Button onClick={() => setAuthState('signIn')}>Back to Sign In</Button>
                  </SpaceBetween>
                </>
              ) : (
                <>
                  <FormField label="Email">
                    <Input
                      type="email"
                      value={email}
                      onChange={({ detail }) => setEmail(detail.value)}
                      placeholder="Enter your email"
                    />
                  </FormField>
                  <FormField label="Password">
                    <Input
                      type="password"
                      value={password}
                      onChange={({ detail }) => setPassword(detail.value)}
                      placeholder="Enter your password"
                    />
                  </FormField>
                  <SpaceBetween direction="horizontal" size="s">
                    {authState === 'signIn' ? (
                      <>
                        <Button onClick={handleSignIn} loading={loading} variant="primary">
                          Sign In
                        </Button>
                        <Button onClick={() => setAuthState('signUp')}>Create Account</Button>
                      </>
                    ) : (
                      <>
                        <Button onClick={handleSignUp} loading={loading} variant="primary">
                          Sign Up
                        </Button>
                        <Button onClick={() => setAuthState('signIn')}>Back to Sign In</Button>
                      </>
                    )}
                  </SpaceBetween>
                </>
              )}
            </SpaceBetween>
          </Container>
        </ContentLayout>
      }
    />
  );
}

// SigV4-signed fetch for Lambda Function URLs with IAM auth
export async function signedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const [session, config] = await Promise.all([
    fetchAuthSession(),
    loadConfig(),
  ]);
  const credentials = session.credentials;
  const identityId = session.identityId;
  
  if (!credentials) {
    console.error('No credentials available from Cognito Identity Pool');
    throw new Error('No credentials available - please sign in again');
  }

  // Get region from identity ID (format: us-west-2:uuid)
  const region = identityId?.split(':')[0] || config.region || 'us-west-2';

  const parsedUrl = new URL(url);
  const method = options.method || 'GET';
  
  // Get body as string - only for non-GET requests
  let body: string | undefined;
  if (options.body && method !== 'GET') {
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }

  // Create signer with credentials from Cognito
  const sigv4 = new SignatureV4({
    service: 'lambda',
    region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
    sha256: Sha256,
  });

  // Build headers for signing
  const headersToSign: Record<string, string> = {
    host: parsedUrl.hostname,
  };
  if (body) {
    headersToSign['content-type'] = 'application/json';
  }

  const queryParams: Record<string, string> = {};
  parsedUrl.searchParams.forEach((value, key) => {
    queryParams[key] = value;
  });

  const signed = await sigv4.sign({
    method,
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname,
    query: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    protocol: parsedUrl.protocol,
    headers: headersToSign,
    body,
  });

  // Exclude 'host' — browser sets it automatically and it's a forbidden header
  const fetchHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(signed.headers)) {
    if (key.toLowerCase() !== 'host' && typeof value === 'string') {
      fetchHeaders[key] = value;
    }
  }

  const response = await fetch(url, {
    method,
    headers: fetchHeaders,
    body,
    mode: 'cors',
  });

  if (!response.ok) {
    const errorText = await response.clone().text();
    console.error('Request failed:', response.status, errorText);
  }

  return response;
}

export default App;
