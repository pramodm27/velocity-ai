import httpx
import json
from .config import settings

def get_url():
    return settings.model_base_url.rstrip("/") + "/chat/completions"

async def complete(messages):
    if not settings.model_api_key:
        raise RuntimeError("Set MODEL_API_KEY in backend/.env")
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.post(
            get_url(),
            headers={"Authorization": "Bearer " + settings.model_api_key},
            json={"model": settings.model_name, "messages": messages, "temperature": 0.2}
        )
        if r.status_code >= 400:
            raise RuntimeError(f"Model API error ({r.status_code}): {r.text}")
        return r.json()["choices"][0]["message"]["content"]

async def stream(messages):
    if not settings.model_api_key:
        raise RuntimeError("Set MODEL_API_KEY in backend/.env")
    async with httpx.AsyncClient(timeout=120) as c:
        async with c.stream(
            "POST",
            get_url(),
            headers={"Authorization": "Bearer " + settings.model_api_key},
            json={"model": settings.model_name, "messages": messages, "stream": True, "temperature": 0.2}
        ) as r:
            if r.status_code >= 400:
                err_text = await r.aread()
                raise RuntimeError(f"Model API error ({r.status_code}): {err_text.decode('utf-8', errors='replace')}")
            async for line in r.aiter_lines():
                if not line:
                    continue
                line_str = line.strip()
                if line_str.startswith("data:"):
                    data = line_str[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        d = json.loads(data)
                        t = d.get("choices", [{}])[0].get("delta", {}).get("content")
                        if t:
                            yield t
                    except json.JSONDecodeError:
                        continue
