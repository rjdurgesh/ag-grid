"""OSHIVA security — protective layers around the agent.

  redaction.py — central PII / secret scrubbing of tool results before they reach the model or the audit log
                 (DB passwords, connection strings, and personal data such as names / email / username /
                 GUID / account number never leave for the shared LLM or the logs).
"""
