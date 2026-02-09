import {
  discoverSockets,
  IpcClient,
  type IpcRequestBody,
  type IpcResponseBody,
  type NotebookInfo,
} from "./ipc-client.ts";

function isNotebookNotFoundError(response: IpcResponseBody): boolean {
  if (response.type !== "error") {
    return false;
  }

  return (
    response.message.startsWith("Notebook not found") ||
    response.message.startsWith(
      "Notebook is not currently open as a marimo notebook",
    ) ||
    response.message.startsWith("Notebook is not open or not running")
  );
}

export class IpcClientPool {
  private clients = new Map<string, IpcClient>();
  /** Cache: notebook URI → socket path that owns it */
  private notebookRoutes = new Map<string, string>();

  /**
   * Discover sockets and connect to any new ones. Drop dead connections.
   */
  async refresh(): Promise<void> {
    const socketPaths = discoverSockets();
    const currentPaths = new Set(socketPaths);

    // Remove clients whose sockets no longer exist on disk
    for (const [path, client] of this.clients) {
      if (!currentPaths.has(path)) {
        client.close();
        this.clients.delete(path);
      }
    }

    // Connect to any new sockets
    for (const socketPath of socketPaths) {
      if (!this.clients.has(socketPath)) {
        const client = new IpcClient();
        try {
          await client.connect(socketPath);
          this.clients.set(socketPath, client);
        } catch {
          // Socket file exists but connection failed — stale socket, skip it
        }
      }
    }
  }

  /**
   * Send a request to ALL connected extensions and collect responses.
   * Used for list_notebooks to aggregate across windows.
   */
  async requestAll(
    body: IpcRequestBody,
  ): Promise<{ socketPath: string; response: IpcResponseBody }[]> {
    const results: { socketPath: string; response: IpcResponseBody }[] = [];

    const entries = [...this.clients.entries()];
    const settled = await Promise.allSettled(
      entries.map(async ([socketPath, client]) => {
        const response = await client.request(body);
        return { socketPath, response };
      }),
    );

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        // Connection dead — remove it
        const [path, client] = entries[i];
        client.close();
        this.clients.delete(path);
      }
    }

    return results;
  }

  /**
   * Send a request to the right extension for a specific notebook.
   * Uses cached routing from list_notebooks, falls back to trying each.
   */
  async requestOne(
    body: IpcRequestBody & { notebook_uri: string },
  ): Promise<IpcResponseBody> {
    // Try cached route first
    const cachedPath = this.notebookRoutes.get(body.notebook_uri);
    if (cachedPath) {
      const client = this.clients.get(cachedPath);
      if (client) {
        try {
          const response = await client.request(body);
          if (!isNotebookNotFoundError(response)) {
            return response;
          }
          // Notebook moved/closed in this window. Try other windows.
        } catch {
          // Connection dead — remove it
          client.close();
          this.clients.delete(cachedPath);
        }
      }
      // Cached route is stale — remove it
      this.notebookRoutes.delete(body.notebook_uri);
    }

    // Try each connected extension until one succeeds
    for (const [path, client] of this.clients) {
      try {
        const response = await client.request(body);
        if (!isNotebookNotFoundError(response)) {
          // Cache this route for future requests
          if (response.type !== "error") {
            this.notebookRoutes.set(body.notebook_uri, path);
          }
          return response;
        }
      } catch {
        // Connection dead — remove it
        client.close();
        this.clients.delete(path);
      }
    }

    return {
      type: "error" as const,
      message: `Notebook not found in any VS Code window: ${body.notebook_uri}`,
    };
  }

  /**
   * Update the notebook→socket routing cache from list_notebooks responses.
   */
  updateRoutes(socketPath: string, notebooks: NotebookInfo[]): void {
    for (const nb of notebooks) {
      this.notebookRoutes.set(nb.uri, socketPath);
    }
  }

  get size(): number {
    return this.clients.size;
  }
}
