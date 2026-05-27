from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

app = FastAPI()
model = SentenceTransformer("nomic-ai/nomic-embed-text-v1.5", trust_remote_code=True)

class Req(BaseModel):
    texts: list[str]

@app.post("/embed")
def embed(req: Req):
    return {"embeddings": model.encode(req.texts).tolist()}