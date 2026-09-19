# Memhub Server Edition

Server Edition runs the central Memory Core and Memhub Gateway on loopback. Publish `/memhub/mcp` and `/memhub/capture` only through an authenticated reverse proxy such as Cloudflare Access.

- Linux: `MEMHUB_PUBLIC_HOST=memory.example.com bash linux/install.sh`
- Windows: `powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -PublicHost memory.example.com`

Device-side Bridges are installed separately and keep Cloudflare Service Tokens/device tokens off AI plugin configuration.
