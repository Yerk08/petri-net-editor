import json

def run_chunk(raw_data: str) -> str:
    data = json.loads(raw_data)
    x = int(data.get("x", 0))
    return json.dumps({"result": x * 2})

