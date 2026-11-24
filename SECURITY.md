# Security

## The sandbox is not a security boundary

Unless `--safe` is given, untangle executes fragments of the input (decoders, builtin calls,
packer bodies) in a separate Node process with the permission model enabled, an empty
environment and a memory cap, inside a `vm` context with a null-prototype global. This blocks
the usual escapes, but:

- Node's permission model does not restrict network access;
- `vm` is not designed to contain hostile code.

**Run untangle on live samples inside a disposable analysis VM**, or use `--safe` (static
transforms only, nothing from the sample is executed). Extracted payloads (`--extract-blobs`)
are written to disk as-is and are live malware: handle them accordingly.

## Reporting a vulnerability

If you find a sandbox escape or a way to make untangle execute sample code outside the sandbox,
please report it privately through
[GitHub security advisories](https://github.com/CtxtArc/untangle/security/advisories/new)
rather than a public issue. Include a minimal, harmless proof of concept.
