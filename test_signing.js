// Test script to debug SigV4 signing for Lambda Function URLs
// Run with: node test_signing.js

const { SignatureV4 } = require('@smithy/signature-v4');
const { Sha256 } = require('@aws-crypto/sha256-js');
const { fromEnv } = require('@aws-sdk/credential-provider-env');
const { fromIni } = require('@aws-sdk/credential-provider-ini');

async function testSigning() {
  // Try environment first, then ini
  let credentials;
  try {
    const envProvider = fromEnv();
    credentials = await envProvider();
  } catch {
    const iniProvider = fromIni({ profile: process.env.AWS_PROFILE || 'default' });
    credentials = await iniProvider();
  }
  
  console.log('Credentials:', {
    accessKeyId: credentials.accessKeyId?.substring(0, 12) + '...',
    hasSecretKey: !!credentials.secretAccessKey,
    hasSessionToken: !!credentials.sessionToken,
  });

  // Test with query string like the browser does
  const url = 'https://pncj3762mf3tumw6ikarz4xy2e0frgrk.lambda-url.us-west-2.on.aws/graph-visualization?tenant_id=demo&limit=100';
  const parsedUrl = new URL(url);
  
  console.log('\nURL parts:');
  console.log('  hostname:', parsedUrl.hostname);
  console.log('  pathname:', parsedUrl.pathname);
  console.log('  search:', parsedUrl.search);
  console.log('  path (pathname+search):', parsedUrl.pathname + parsedUrl.search);
  
  const sigv4 = new SignatureV4({
    service: 'lambda',
    region: 'us-west-2',
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
    sha256: Sha256,
  });

  // Sign with just host header (like awscurl does)
  const signed = await sigv4.sign({
    method: 'GET',
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname + parsedUrl.search,
    protocol: parsedUrl.protocol,
    headers: {
      host: parsedUrl.hostname,
    },
  });

  console.log('\nSigned headers:', Object.keys(signed.headers));
  console.log('Authorization:', signed.headers.authorization);
  
  // Now make the request
  const fetchHeaders = {};
  for (const [key, value] of Object.entries(signed.headers)) {
    if (key.toLowerCase() !== 'host') {
      fetchHeaders[key] = value;
    }
  }
  
  console.log('\nFetch headers (excluding host):', Object.keys(fetchHeaders));
  
  const response = await fetch(url, {
    method: 'GET',
    headers: fetchHeaders,
  });
  
  console.log('\nResponse status:', response.status);
  const text = await response.text();
  console.log('Response body:', text.substring(0, 200));
}

testSigning().catch(console.error);
