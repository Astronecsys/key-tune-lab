"""Instrument application services.

Services operate on the runtime state through a narrow proxy today.  This keeps
the HTTP/device facade stable while giving each domain a replaceable boundary.
"""
