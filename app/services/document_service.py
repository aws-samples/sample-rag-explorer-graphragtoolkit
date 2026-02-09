import boto3
import os
from fastapi import UploadFile
from datetime import datetime


class DocumentService:
    def __init__(self):
        self.s3_client = boto3.client('s3', region_name=os.getenv('AWS_REGION', 'us-east-1'))
        self.bucket_name = os.getenv('S3_BUCKET')
        
        if not self.bucket_name:
            raise ValueError("S3_BUCKET environment variable not set")
    
    async def upload_to_s3(self, file: UploadFile, tenant_id: str) -> str:
        """Upload file to S3 and return the key"""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        s3_key = f"{tenant_id}/documents/{timestamp}_{file.filename}"
        
        # Read file content
        content = await file.read()
        
        # Upload to S3
        self.s3_client.put_object(
            Bucket=self.bucket_name,
            Key=s3_key,
            Body=content,
            ContentType=file.content_type
        )
        
        return s3_key
    
    def download_from_s3(self, s3_key: str) -> bytes:
        """Download file from S3"""
        response = self.s3_client.get_object(Bucket=self.bucket_name, Key=s3_key)
        return response['Body'].read()
