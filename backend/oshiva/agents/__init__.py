"""OSHIVA agents — the coordinator and the pluggable specialist agents.

  coordinator.py — routes a turn to an agent, then runs it (the seam that grows from 1 agent to many).
  registry.py    — the Agent dataclass + AGENTS registry + route() (keyword scoring).
  runner.py      — run_agent_loop(): the tool-calling loop that runs ONE agent and streams events.
"""
