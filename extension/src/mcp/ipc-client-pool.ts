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

function createNotebookNotFoundError(
  notebookUri: string,
  windowId?: string,
): IpcResponseBody {
  if (windowId) {
    return {
      type: "error",
      message:
        `Notebook not found in VS Code window ${windowId}: ${notebookUri}. ` +
        "Re-run list_notebooks and retry with a current window_id.",
    };
  }

  return {
    type: "error",
    message: `Notebook not found in any VS Code window: ${notebookUri}`,
  };
}

function createAmbiguousNotebookError(notebookUri: string): IpcResponseBody {
  return {
    type: "error",
    message:
      `Notebook is open in multiple VS Code windows: ${notebookUri}. ` +
      "Re-run list_notebooks and retry with the matching window_id.",
  };
}

type RoutedResponse = {
  socketPath: string;
  response: IpcResponseBody;
};

export class IpcClientPool {
  private clients = new Map<string, IpcClient>();
  /** Cache: notebook URI → socket path, only when ownership is unique */
  private notebookRoutes = new Map<string, string>();
  /** Cache: window ID → socket path */
  private windowRoutes = new Map<string, string>();
  /** Cache: window ID → notebook URIs currently open in that window */
  private notebooksByWindow = new Map<string, Set<string>>();

  private removeClient(socketPath: string): void {
    const client = this.clients.get(socketPath);
    if (client) {
      client.close();
      this.clients.delete(socketPath);
    }

    for (const [notebookUri, path] of this.notebookRoutes) {
      if (path === socketPath) {
        this.notebookRoutes.delete(notebookUri);
      }
    }

    let removedWindowMetadata = false;
    for (const [windowId, path] of this.windowRoutes) {
      if (path !== socketPath) {
        continue;
      }
      this.windowRoutes.delete(windowId);
      this.notebooksByWindow.delete(windowId);
      removedWindowMetadata = true;
    }

    if (removedWindowMetadata) {
      this.rebuildNotebookRoutes();
    }
  }

  private rebuildNotebookRoutes(): void {
    const ownership = new Map<string, string | null>();

    for (const [windowId, notebooks] of this.notebooksByWindow) {
      const socketPath = this.windowRoutes.get(windowId);
      if (!socketPath) {
        continue;
      }

      for (const notebookUri of notebooks) {
        const owner = ownership.get(notebookUri);
        if (owner === undefined) {
          ownership.set(notebookUri, windowId);
          continue;
        }

        if (owner !== windowId) {
          ownership.set(notebookUri, null);
        }
      }
    }

    this.notebookRoutes.clear();
    for (const [notebookUri, windowId] of ownership) {
      if (!windowId) {
        continue;
      }
      const socketPath = this.windowRoutes.get(windowId);
      if (socketPath) {
        this.notebookRoutes.set(notebookUri, socketPath);
      }
    }
  }

  private async requestSocket(
    socketPath: string,
    body: IpcRequestBody,
  ): Promise<IpcResponseBody | null> {
    const client = this.clients.get(socketPath);
    if (!client) {
      this.removeClient(socketPath);
      return null;
    }

    try {
      return await client.request(body);
    } catch {
      this.removeClient(socketPath);
      return null;
    }
  }

  private async probeNotebook(
    body: IpcRequestBody & { notebook_uri: string },
  ): Promise<RoutedResponse[]> {
    const entries = [...this.clients.entries()];
    const settled = await Promise.allSettled(
      entries.map(async ([socketPath, client]) => ({
        socketPath,
        response: await client.request(body),
      })),
    );

    const matches: RoutedResponse[] = [];
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === "fulfilled") {
        if (!isNotebookNotFoundError(result.value.response)) {
          matches.push(result.value);
        }
        continue;
      }

      const [socketPath] = entries[i];
      this.removeClient(socketPath);
    }

    return matches;
  }

  /**
   * Discover sockets and connect to any new ones. Drop dead connections.
   */
  async refresh(): Promise<void> {
    const socketPaths = discoverSockets();
    const currentPaths = new Set(socketPaths);

    for (const socketPath of this.clients.keys()) {
      if (!currentPaths.has(socketPath)) {
        this.removeClient(socketPath);
      }
    }

    const newSocketPaths = socketPaths.filter(
      (path) => !this.clients.has(path),
    );
    const settled = await Promise.allSettled(
      newSocketPaths.map(async (socketPath) => {
        const client = new IpcClient();
        await client.connect(socketPath);
        return { socketPath, client };
      }),
    );

    for (const result of settled) {
      if (result.status === "fulfilled") {
        this.clients.set(result.value.socketPath, result.value.client);
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
        const [socketPath] = entries[i];
        this.removeClient(socketPath);
      }
    }

    return results;
  }

  /**
   * Send a request to the right extension for a specific notebook.
   * If window_id is provided, route directly to that VS Code window.
   * Otherwise, use a cached unique route or probe all windows.
   */
  async requestOne(
    body: IpcRequestBody & { notebook_uri: string; window_id?: string },
  ): Promise<IpcResponseBody> {
    if (body.window_id) {
      const socketPath = this.windowRoutes.get(body.window_id);
      if (!socketPath) {
        return {
          type: "error",
          message:
            `VS Code window not found for window_id ${body.window_id}. ` +
            "Re-run list_notebooks and retry with a current window_id.",
        };
      }

      const response = await this.requestSocket(socketPath, body);
      if (response === null || isNotebookNotFoundError(response)) {
        return createNotebookNotFoundError(body.notebook_uri, body.window_id);
      }
      return response;
    }

    const cachedPath = this.notebookRoutes.get(body.notebook_uri);
    if (cachedPath) {
      const response = await this.requestSocket(cachedPath, body);
      if (response !== null && !isNotebookNotFoundError(response)) {
        return response;
      }
      this.notebookRoutes.delete(body.notebook_uri);
    }

    const matches = await this.probeNotebook(body);
    if (matches.length === 0) {
      return createNotebookNotFoundError(body.notebook_uri);
    }
    if (matches.length > 1) {
      return createAmbiguousNotebookError(body.notebook_uri);
    }

    const match = matches[0];
    if (match.response.type !== "error") {
      this.notebookRoutes.set(body.notebook_uri, match.socketPath);
    }
    return match.response;
  }

  /**
   * Update the window/socket and unique notebook routing caches from
   * list_notebooks responses.
   */
  updateRoutes(socketPath: string, notebooks: NotebookInfo[]): void {
    if (notebooks.length === 0) {
      let updated = false;
      for (const [windowId, path] of this.windowRoutes) {
        if (path !== socketPath) {
          continue;
        }
        this.notebooksByWindow.set(windowId, new Set());
        updated = true;
      }
      if (updated) {
        this.rebuildNotebookRoutes();
      }
      return;
    }

    const grouped = new Map<string, Set<string>>();
    for (const notebook of notebooks) {
      this.windowRoutes.set(notebook.window_id, socketPath);
      const windowNotebooks =
        grouped.get(notebook.window_id) ?? new Set<string>();
      windowNotebooks.add(notebook.uri);
      grouped.set(notebook.window_id, windowNotebooks);
    }

    for (const [windowId, windowNotebooks] of grouped) {
      this.notebooksByWindow.set(windowId, windowNotebooks);
    }

    this.rebuildNotebookRoutes();
  }

  get size(): number {
    return this.clients.size;
  }
}
