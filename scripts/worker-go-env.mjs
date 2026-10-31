import process from "node:process";

const commonKeys = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "SystemRoot", "WINDIR", "PATHEXT",
];

export const jobsWorkerKeys = [
  "JOBS_WORKER_DATABASE_URL", "JOBS_WORKER_ID", "GO_DATABASE_URL",
  "GO_ROUTINE_SCHEDULER", "GO_ROUTINE_AGENT_RUNNER", "GO_SUPPORT_EMBEDDING_WORKER",
  "GO_SUPPORT_EMBEDDING_MODEL", "MODEL_PROVIDER", "MODEL_PRIMARY", "MODEL_FAST",
  "MODEL_REASONING", "MODEL_EMBEDDINGS", "MODEL_OCR", "MODEL_BASE_URL", "NIM_BASE_URL", "ZAI_BASE_URL",
  "EMBEDDING_DIMENSIONS", "NVIDIA_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY",
  "MISTRAL_API_KEY", "ZAI_API_KEY", "OPENAI_API_KEY", "NOTIFICATION_WEBHOOK_URL",
  "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SMTP_SECURE", "SMTP_TO",
];

export function jobsWorkerEnvironment(source = process.env) {
  return {
    ...selectedEnvironment(jobsWorkerKeys, source),
    GO_ROUTINE_SCHEDULER: source.GO_ROUTINE_SCHEDULER ?? "0",
    GO_ROUTINE_AGENT_RUNNER: source.GO_ROUTINE_AGENT_RUNNER ?? "0",
  };
}

export function selectedEnvironment(keys, source = process.env) {
  const result = {};
  for (const key of new Set([...commonKeys, ...keys])) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}
