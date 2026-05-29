import type { ManifestSignal } from "../config/manifest.ts";

type HttpAuth = NonNullable<Extract<ManifestSignal, { readonly type: "http.poll" }>["auth"]>;

export interface HeaderConfig {
  readonly auth?: HttpAuth | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly headersFromEnv?: Readonly<Record<string, string>> | undefined;
}

export function resolveConfiguredHeaders(config: HeaderConfig): Headers {
  const headers = new Headers(config.headers ?? {});
  applyAuth(headers, config.auth);
  for (const [headerName, envName] of Object.entries(config.headersFromEnv ?? {})) {
    const value = Bun.env[envName];
    if (!value) {
      throw new Error(`Environment variable ${envName} is required for HTTP header '${headerName}'.`);
    }
    headers.set(headerName, value);
  }
  return headers;
}

function applyAuth(headers: Headers, auth: HttpAuth | undefined): void {
  if (!auth) {
    return;
  }
  switch (auth.type) {
    case "bearer": {
      headers.set("Authorization", `Bearer ${readRequiredEnv(auth.tokenEnv, "bearer token")}`);
      return;
    }
    case "basic": {
      const username = readRequiredEnv(auth.usernameEnv, "basic auth username");
      const password = readRequiredEnv(auth.passwordEnv, "basic auth password");
      headers.set("Authorization", `Basic ${btoa(`${username}:${password}`)}`);
      return;
    }
    case "header": {
      const value = readRequiredEnv(auth.valueEnv, `header ${auth.name}`);
      headers.set(auth.name, `${auth.prefix ?? ""}${value}`);
      return;
    }
  }
}

function readRequiredEnv(name: string, label: string): string {
  const value = Bun.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required for ${label}.`);
  }
  return value;
}
