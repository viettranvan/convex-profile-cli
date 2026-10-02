import { spawn } from "node:child_process";
import http from "node:http";

import handler from "serve-handler";

function openBrowser(url: string): void {
  const browser = process.env.BROWSER?.trim();
  if (!browser && process.env.TERM_PROGRAM === "vscode") {
    process.stdout.write("IDE terminal detected: Cmd/Ctrl+Click the URL above to open it in the IDE browser.\n");
    return;
  }
  const command = browser || (process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open");
  const args = !browser && process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", (error) => {
    process.stderr.write(`Could not open browser automatically: ${error.message}\n`);
  });
  child.unref();
}

function isLoopbackHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE"
        ? new Error(`Port ${port} is already in use. Pass --port <number> to choose another port.`)
        : error);
    });
    server.listen(port, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

/**
 * Answers the dashboard's `?a=<port>` deployment lookup (the flow `convex dev --local` uses),
 * so the admin key reaches the page without appearing in the URL.
 */
export function createLoginServer(input: {
  dashboardPort: number;
  deployment: { name: string; url: string; adminKey: string };
}): http.Server {
  const allowedOrigins = new Set([`http://127.0.0.1:${input.dashboardPort}`, `http://localhost:${input.dashboardPort}`]);
  return http.createServer((request, response) => {
    const port = request.socket.localPort ?? 0;
    const origin = request.headers.origin;
    if (!isLoopbackHost(request.headers.host, port) || !origin || !allowedOrigins.has(origin) || request.method !== "GET") {
      response.writeHead(403).end("Forbidden");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      "Cache-Control": "no-store",
      Vary: "Origin",
    });
    response.end(JSON.stringify({ deployments: [input.deployment] }));
  });
}

export async function serveDashboard(input: {
  directory: string;
  port: number;
  backendUrl: string;
  profileName: string;
  adminKey?: string;
  open: boolean;
}): Promise<void> {
  const server = http.createServer((request, response) => {
    if (!isLoopbackHost(request.headers.host, input.port)) {
      response.writeHead(403).end("Invalid Host");
      return;
    }
    if (request.url?.startsWith("/api/current_deployment")) {
      response.writeHead(404).end("Not available for manual dashboard login");
      return;
    }
    void handler(request, response, { public: input.directory }).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end("Dashboard server error");
    });
  });

  await listen(server, input.port);
  let loginServer: http.Server | undefined;
  let url = `http://127.0.0.1:${input.port}/`;
  if (input.adminKey) {
    loginServer = createLoginServer({
      dashboardPort: input.port,
      deployment: { name: input.profileName, url: input.backendUrl, adminKey: input.adminKey },
    });
    const loginPort = await listen(loginServer, 0);
    url += `?a=${loginPort}&d=${encodeURIComponent(input.profileName)}`;
  }
  process.stdout.write(`Dashboard for profile "${input.profileName}": ${url}\n`);
  process.stdout.write(input.adminKey
    ? `Deployment URL: ${input.backendUrl}\nLogging in automatically; the admin key is served only to this dashboard origin.\n`
    : `Deployment URL: ${input.backendUrl}\nEnter the admin key manually in the dashboard.\n`);
  if (input.open) openBrowser(url);

  const stop = () => {
    for (const s of [server, loginServer]) {
      s?.close();
      // Browsers keep idle connections open, which would otherwise block close().
      s?.closeAllConnections();
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("close", resolve);
      server.once("error", reject);
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
