import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export function loadConfig(providerName, configPath = path.resolve('threads.config.json')) {
  loadDotenv(path.resolve('.env'));

  const raw = readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);

  // New multi-provider format
  if (config.providers) {
    const name = providerName || config.default || Object.keys(config.providers)[0];
    const provider = config.providers[name];
    if (!provider) {
      throw new Error(`Provider "${name}" not found. Available: ${Object.keys(config.providers).join(', ')}`);
    }
    return {
      provider: {
        name,
        baseURL: provider.baseURL,
        apiKey: resolveEnvToken(provider.apiKey),
      },
      model: provider.model,
    };
  }

  // Legacy single-provider format
  return {
    provider: {
      name: config.provider?.name,
      baseURL: config.provider?.baseURL,
      apiKey: resolveEnvToken(config.provider?.apiKey),
    },
    model: config.model,
  };
}

export function listProviders(configPath = path.resolve('threads.config.json')) {
  loadDotenv(path.resolve('.env'));
  const raw = readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  if (config.providers) return Object.keys(config.providers);
  return [config.provider?.name || 'default'].filter(Boolean);
}

function loadDotenv(envPath) {
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, value] = match;
    const unquoted = value.replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = unquoted;
  }
}

function resolveEnvToken(value) {
  if (!value) return undefined;
  const match = String(value).match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (!match) return value;
  const envValue = process.env[match[1]];
  if (!envValue) {
    throw new Error(`Environment variable "${match[1]}" is not set (referenced by config apiKey).`);
  }
  return envValue;
}