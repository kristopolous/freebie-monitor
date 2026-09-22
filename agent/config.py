"""Shared setup. Import this before building the agent in every script.

Loads .env and builds the Strands model. Unlike the original starter (which
always uses Bedrock), this picks a provider based on what's configured:

1. Bedrock, if explicitly requested and AWS credentials resolve — coded and
   tested working (tool calls need `streaming=False`, see below), but not
   the default: it also needs a one-time "Anthropic use case details" form
   submitted in the Bedrock console before the account can invoke models.
2. A local OpenAI-compatible endpoint otherwise (STRANDS_PROVIDER=local) —
   the default, already verified working end to end.

Streaming quirks, both real:
- Bedrock: tool calls need `streaming=False` (plain converse(), not
  converse_stream()) — the streaming path mis-parses tool-call deltas into
  dozens of empty fragments.
- The local endpoint: the opposite — leave streaming on (the default);
  `stream=False` hits a Strands SDK bug converting the non-streaming reply
  into synthetic delta events. Separately (either streaming setting), any
  numeric (int/float) tool argument can leak a raw int into a field the
  delta-accumulator always expects to be a string
  (strands/event_loop/streaming.py:handle_content_block_delta,
  `state["current_tool_use"]["input"] += tool_use_delta.get("input", "")`).
  Worked around in agent.py by typing tool args as strings, not by anything
  here — flagging it in case a future tool reintroduces a numeric param.

Cognee runs against the cloud API (platform.cognee.ai), not a local graph —
Cognee's own package confirms the "V1 add/cognify/search" verbs this uses
are still fully supported alongside the newer remember/recall calls the
original starter demonstrates locally. See CogneeMemory in agent.py.
"""

import os
import warnings
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

# An empty `KEY=` line in .env sets os.environ[KEY] = "" — present-but-empty,
# not absent. That's indistinguishable from "unset" everywhere WE read it
# with `or`, but libraries that read the env directly (boto3's AWS_PROFILE,
# notably) treat "" as a real value and fail trying to use it. Strip these
# so an unset-looking .env line actually behaves as unset everywhere.
for _key, _val in list(os.environ.items()):
    if _val == "":
        del os.environ[_key]

warnings.filterwarnings("ignore", category=RuntimeWarning)


def _patch_streaming_delta_type_bug() -> None:
    """Works around a real Strands SDK bug: strands/event_loop/streaming.py's
    handle_content_block_delta does
        state["current_tool_use"]["input"] += tool_use_delta.get("input", "")
    assuming "input" is always a string chunk of partial JSON. Some models
    (this local endpoint's included, regardless of the tool's declared
    argument type) sometimes emit a bare JSON number for one field instead
    of a string, which crashes that += with "can only concatenate str (not
    'int') to str". This coerces the delta to a string before it reaches the
    buggy line, at the one place both streaming and non-streaming responses
    funnel through, so it's provider-agnostic.
    """
    import strands.event_loop.streaming as _streaming

    _original = _streaming.handle_content_block_delta

    def _patched(event, state):
        delta = event.get("delta", {})
        tool_use = delta.get("toolUse")
        if isinstance(tool_use, dict) and "input" in tool_use and not isinstance(tool_use["input"], str):
            tool_use["input"] = str(tool_use["input"])
        return _original(event, state)

    _streaming.handle_content_block_delta = _patched


_patch_streaming_delta_type_bug()

# Cognee cloud — tenant-specific base URL + key from platform.cognee.ai/api-keys.
COGNEE_API_URL = os.environ.get("COGNEE_API_URL", "")
COGNEE_API_KEY = os.environ.get("COGNEE_API_KEY", "")
COGNEE_DATASET = os.environ.get("COGNEE_DATASET", "freebie-monitor")


def _bedrock_available() -> bool:
    if not (os.environ.get("AWS_PROFILE") or os.environ.get("AWS_ACCESS_KEY_ID")):
        return False
    try:
        import boto3

        boto3.Session().get_credentials().get_frozen_credentials()
        return True
    except Exception:
        return False


def get_model():
    """Returns a Strands Model. Prefers Bedrock (matching the starter) when
    credentials are actually available; otherwise falls back to whichever
    local/cloud provider is configured in .env."""
    provider = os.environ.get("STRANDS_PROVIDER", "auto")

    if provider == "bedrock" or (provider == "auto" and _bedrock_available()):
        from strands.models import BedrockModel

        return BedrockModel(
            model_id=os.environ.get("STRANDS_MODEL_ID", "global.anthropic.claude-sonnet-4-6"),
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
            # False -> plain converse() instead of converse_stream(). Verified needed: the
            # streaming path mis-parses tool-call deltas into dozens of empty fragments
            # ("Tool #N: None" / "incomplete tool use block"); non-streaming returns one
            # clean tool call.
            streaming=False,
        )

    if provider == "anthropic" or (provider == "auto" and os.environ.get("ANTHROPIC_API_KEY")):
        from strands.models.anthropic import AnthropicModel

        return AnthropicModel(
            client_args={"api_key": os.environ["ANTHROPIC_API_KEY"]},
            model_id=os.environ.get("STRANDS_MODEL_ID", "claude-sonnet-5"),
        )

    from strands.models.openai import OpenAIModel

    return OpenAIModel(
        client_args={
            "base_url": os.environ.get("LOCAL_MODEL_BASE_URL") or "https://9ol.es/11434",
            "api_key": os.environ.get("LOCAL_MODEL_API_KEY") or "local",
        },
        model_id=os.environ.get("LOCAL_MODEL_ID") or "qwen3.8",
        # Default streaming — verified working cleanly against this endpoint.
        # stream=False actually breaks tool calls here: the SDK's non-streaming
        # response gets re-synthesized into delta events, and one edge case in
        # that conversion leaks a raw int into a field the delta-accumulator
        # always expects to be a string ("can only concatenate str (not 'int')
        # to str", strands/event_loop/streaming.py:handle_content_block_delta).
    )
