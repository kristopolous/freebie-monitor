"""Step 1: build the rewards brain from the files in data/. Run once before the demo.

    python ingest.py

Each file goes to Cognee's cloud add_text + cognify (the still-supported "V1" verbs — see
config.py's docstring), which extracts entities and relationships with an LLM and adds them
to one knowledge graph, same as the original starter's local cognee.remember() does.
"""

import asyncio
import time

import httpx

import config

DATA = config.ROOT / "data"


async def main() -> None:
    files = sorted(p for p in DATA.iterdir() if p.is_file() and not p.name.startswith("."))

    headers = {"X-Api-Key": config.COGNEE_API_KEY, "Content-Type": "application/json"}

    print(f"Building the Freebie Monitor brain from {len(files)} files:\n")
    async with httpx.AsyncClient(timeout=60) as client:
        for path in files:
            t = time.time()
            res = await client.post(
                f"{config.COGNEE_API_URL}/api/v1/add_text",
                headers=headers,
                json={"textData": [f"Source file: {path.name}\n\n{path.read_text()}"], "datasetName": config.COGNEE_DATASET},
            )
            res.raise_for_status()
            print(f"  remembered {path.name:<22} {time.time() - t:5.1f}s")

        print("\nCognifying the graph...")
        t = time.time()
        res = await client.post(
            f"{config.COGNEE_API_URL}/api/v1/cognify",
            headers=headers,
            json={"datasets": [config.COGNEE_DATASET], "runInBackground": False},
        )
        res.raise_for_status()
        print(f"  done {time.time() - t:5.1f}s")

    print(f"\nDone. Dataset: {config.COGNEE_DATASET}")


if __name__ == "__main__":
    asyncio.run(main())
