from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Graph and Vector Store
    graph_store: str
    vector_store: str
    
    # AWS
    aws_region: str = "us-east-1"
    s3_bucket: str
    
    # API
    api_title: str = "GraphRAG Demo API"
    api_version: str = "1.0.0"
    
    class Config:
        env_file = ".env"


settings = Settings()
