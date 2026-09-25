"""OSHIVA memory — server-side conversation state.

  sessions.py — conversation history + a shared scratchpad keyed by conversation_id (file-backed scaffold;
                swaps to ols_ai_* DB tables later without changing callers).
"""
