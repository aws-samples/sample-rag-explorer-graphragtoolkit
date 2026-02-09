FROM --platform=linux/amd64 python:3.10-slim

# Build timestamp: 2026-02-08-v3 - Force rebuild for x86_64
# Install AWS Lambda Web Adapter (x86_64 version)
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4-x86_64 /lambda-adapter /opt/extensions/lambda-adapter

WORKDIR /app

# Install tiktoken first with binary only (requires Rust to build from source)
RUN pip install --no-cache-dir tiktoken --only-binary :all:

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./

# Lambda Web Adapter expects the app on port 8080
ENV PORT=8080

CMD ["python", "app.py"]
