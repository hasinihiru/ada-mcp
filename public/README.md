# Public Static Assets

Place your custom logo file in this directory and name it `logo.png` (i.e. `public/logo.png`).

The MCP HTTP server is configured to automatically serve files from this directory under the `/public` URL path. The login page will automatically display `/public/logo.png` if present, and gracefully fall back to the default ADA logo if `logo.png` is not found.
