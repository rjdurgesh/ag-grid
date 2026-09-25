"""OSHIVA access control — two layers.

  gate.py         — screen-level gate: "may you use OSHIVA at all?" (enabled master switch + allow-list pin
                    or SCREEN/assistant RBAC grant).
  scope_access.py — tool-level authz: which business lines (group/cib/retail) the caller may query, so a tool
                    never surfaces data the user couldn't see in the UI ("tools run as the user").
"""
