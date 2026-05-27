FROM pytorch/pytorch:2.10.0-cuda13.0-cudnn9-runtime

WORKDIR /app

# (Optional) set pip defaults
ENV PIP_NO_CACHE_DIR=1 \
    HF_HUB_DISABLE_SYMLINKS_WARNING=1

# Install venv module for the system Python (3.12)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.12-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*

    # Create a virtualenv and put it on PATH
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

RUN pip install --upgrade pip && \
      pip install --no-cache-dir \
        sentence-transformers==5.3.0 \
        einops==0.8.0 \
        fastapi==0.135.1 \
        "uvicorn[standard]==0.42.0"
  
COPY server.py .
EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]