#!/usr/bin/env python3
"""Test Cognito authentication and Lambda Function URL signing"""

import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

# Configuration
USER_POOL_ID = "us-east-1_excwQLV8p"
CLIENT_ID = "36nato9ng040o6j5kd075i49v1"
IDENTITY_POOL_ID = "us-east-1:5b3b77be-6d6d-459e-a4d9-a8d775efcb26"
REGION = "us-east-1"

# Test credentials (will be replaced)
USERNAME = "[email]"
PASSWORD = "[password]"

# Lambda Function URLs
QUERY_URL = "https://kareqeouex7t33icdtaezmvigu0hmbjq.lambda-url.us-east-1.on.aws/health"
UPLOAD_URL = "https://7b7z7rjkkaxbhjasgbimvk3nxm0vtptv.lambda-url.us-east-1.on.aws/documents"

def authenticate_cognito(username, password):
    """Authenticate with Cognito User Pool and get Identity Pool credentials"""
    from pycognito import Cognito
    
    # Step 1: Authenticate with User Pool using SRP
    print(f"Authenticating user: {username}")
    
    u = Cognito(USER_POOL_ID, CLIENT_ID, username=username)
    u.authenticate(password=password)
    
    id_token = u.id_token
    print(f"Got ID token: {id_token[:50]}...")
    
    # Step 2: Get Identity ID from Identity Pool
    cognito_identity = boto3.client('cognito-identity', region_name=REGION)
    
    logins = {
        f'cognito-idp.{REGION}.amazonaws.com/{USER_POOL_ID}': id_token
    }
    
    identity_response = cognito_identity.get_id(
        IdentityPoolId=IDENTITY_POOL_ID,
        Logins=logins
    )
    
    identity_id = identity_response['IdentityId']
    print(f"Got Identity ID: {identity_id}")
    
    # Step 3: Get AWS credentials from Identity Pool
    credentials_response = cognito_identity.get_credentials_for_identity(
        IdentityId=identity_id,
        Logins=logins
    )
    
    creds = credentials_response['Credentials']
    print(f"Got AWS credentials:")
    print(f"  AccessKeyId: {creds['AccessKeyId'][:12]}...")
    print(f"  SecretKey: {creds['SecretKey'][:12]}...")
    print(f"  SessionToken: {creds['SessionToken'][:50]}...")
    
    return {
        'access_key': creds['AccessKeyId'],
        'secret_key': creds['SecretKey'],
        'session_token': creds['SessionToken'],
        'identity_id': identity_id,
    }

def make_signed_request(url, credentials, method='GET', body=None):
    """Make a SigV4 signed request to Lambda Function URL"""
    
    print(f"\nMaking signed {method} request to: {url}")
    
    # Create the request
    headers = {}
    if body:
        headers['Content-Type'] = 'application/json'
    
    request = AWSRequest(method=method, url=url, headers=headers, data=body)
    
    # Create credentials object
    from botocore.credentials import Credentials
    creds = Credentials(
        access_key=credentials['access_key'],
        secret_key=credentials['secret_key'],
        token=credentials['session_token']
    )
    
    # Sign the request
    SigV4Auth(creds, 'lambda', REGION).add_auth(request)
    
    print(f"Signed headers: {dict(request.headers)}")
    
    # Make the request
    response = requests.request(
        method=method,
        url=url,
        headers=dict(request.headers),
        data=body
    )
    
    print(f"Response status: {response.status_code}")
    print(f"Response body: {response.text[:500]}")
    
    return response

def main():
    import sys
    
    if len(sys.argv) >= 3:
        username = sys.argv[1]
        password = sys.argv[2]
    else:
        username = USERNAME
        password = PASSWORD
    
    if username == "[email]":
        print("Usage: python test_auth.py <email> <password>")
        return
    
    try:
        # Authenticate
        credentials = authenticate_cognito(username, password)
        
        # Test health endpoint
        response = make_signed_request(QUERY_URL, credentials)
        
        # Test documents endpoint
        user_id = credentials['identity_id']
        docs_url = f"{UPLOAD_URL}?user_id={user_id}"
        response = make_signed_request(docs_url, credentials)
        
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == '__main__':
    main()
