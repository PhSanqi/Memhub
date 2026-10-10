# Memhub Server Edition

Server Edition runs the central Memory Core and Memhub MCP runtime on loopback. Publish `/mcp` only through an authenticated reverse proxy such as Cloudflare Access/Tunnel; the public route terminates at the same loopback MCP runtime used by local clients.

- Linux: `MEMHUB_PUBLIC_HOST=memory.example.com bash linux/install.sh`
- Windows: `powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -PublicHost memory.example.com`

Remote MCP clients authenticate at the reverse-proxy boundary.
