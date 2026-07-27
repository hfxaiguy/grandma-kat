import fs from 'node:fs';
import path from 'node:path';

export function createLogger(scriptName) {
  const now = new Date();
  const runId = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const logDir = path.join(process.cwd(), 'logs', scriptName, runId);
  fs.mkdirSync(logDir, { recursive: true });

  let callIndex = 0;

  return {
    runId,
    logDir,
    logLlmCall(stepName, messages, result) {
      callIndex++;
      const padded = String(callIndex).padStart(2, '0');
      const filePath = path.join(logDir, `${padded}_${stepName}.json`);
      const entry = {
        timestamp: new Date().toISOString(),
        step: stepName,
        callIndex,
        messages,
        result: {
          content: result.content,
          reasoning: result.reasoning || null,
          tool_calls: result.tool_calls?.map(tc => ({
            name: tc.function.name,
            arguments: JSON.parse(tc.function.arguments),
          })) || null,
        },
      };
      fs.writeFileSync(filePath, JSON.stringify(entry, null, 2));
      return filePath;
    },
  };
}
