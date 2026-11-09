"""Passive, local ComfyUI benchmark audit; load only in an isolated test clone."""

import base64
import functools
import json
import inspect
import os
from pathlib import Path
import sys
import threading
import uuid
from datetime import datetime, timezone

from aiohttp import web


_EVENTS = frozenset({
    "execution_start", "execution_success", "execution_error",
    "execution_interrupted", "execution_cached",
})


def install(prompt_server, prompt_executor):
    """Wrap a future PromptServer instance; audit failures invalidate the run."""
    log_name = os.environ.get("COMFY_BENCH_AUDIT_LOG")
    if not log_name:
        raise RuntimeError("COMFY_BENCH_AUDIT_LOG is required")
    log_path = Path(log_name).resolve()
    if ".analysis" not in log_path.parts:
        raise RuntimeError("Audit log must be inside an .analysis directory")
    if not log_path.parent.is_dir():
        raise RuntimeError("Audit log directory must already exist")
    lock = threading.Lock()
    state = {"failed": False}

    def record(event):
        event["at"] = datetime.now(timezone.utc).isoformat()
        try:
            line = json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"
            with lock:
                with log_path.open("a", encoding="utf-8", newline="\n") as stream:
                    stream.write(line)
        except (OSError, TypeError, ValueError) as error:
            state["failed"] = True
            print(f"COMFY_BENCH_AUDIT_FAILURE: {type(error).__name__}", file=sys.stderr, flush=True)

    def encoded(body):
        if body is None:
            return None
        if not isinstance(body, bytes):
            state["failed"] = True
            print("COMFY_BENCH_AUDIT_FAILURE: response body unavailable", file=sys.stderr, flush=True)
            return None
        return base64.b64encode(body).decode("ascii")

    @web.middleware
    async def audit_prompt(request, handler):
        if request.method != "POST" or request.path not in {"/prompt", "/api/prompt"}:
            return await handler(request)
        request_body = await request.read()
        request_id = uuid.uuid4().hex
        record({"kind": "prompt_request", "request_id": request_id,
                "request_body_base64": encoded(request_body)})
        try:
            response = await handler(request)
        except web.HTTPException as error:
            record({"kind": "prompt_response", "request_id": request_id,
                    "status": error.status, "response_body_base64": encoded(error.body)})
            raise
        except Exception as error:
            record({"kind": "prompt_exception", "request_id": request_id,
                    "exception_type": type(error).__name__})
            raise
        record({"kind": "prompt_response", "request_id": request_id,
                "status": response.status, "response_body_base64": encoded(response.body)})
        return response

    original_init = prompt_server.__init__
    original_add_message = prompt_executor.add_message

    @functools.wraps(original_init)
    def init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        self.app.middlewares.append(audit_prompt)

    signature = inspect.signature(original_add_message)

    @functools.wraps(original_add_message)
    def add_message(self, *args, **kwargs):
        bound = signature.bind(self, *args, **kwargs)
        result = original_add_message(self, *args, **kwargs)
        event = bound.arguments["event"]
        if event in _EVENTS:
            recorded_event, recorded_data = self.status_messages[-1]
            if recorded_event != event:
                state["failed"] = True
                print("COMFY_BENCH_AUDIT_FAILURE: unexpected status event", file=sys.stderr, flush=True)
            else:
                record({"kind": "execution_event", "event": recorded_event,
                        "data": recorded_data, "sid": self.server.client_id})
        return result

    prompt_server.__init__ = init
    prompt_executor.add_message = add_message
    return state
