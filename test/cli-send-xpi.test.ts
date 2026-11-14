import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnSyncTsScript } from './helpers/ts-runner.js';

const captureCli = fileURLToPath(new URL('./fixtures/send-image-mode-capture.ts', import.meta.url));

describe('cmdSend XPI choice transport', () => {
  it('keeps --as independent in the final card when sandbox prepared content replaces the raw body', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-send-xpi-'));
    try {
      const preparedContentFile = join(dir, 'prepared.md');
      writeFileSync(preparedContentFile, 'prepared body');

      const result = spawnSyncTsScript(captureCli, [
        'send', '--no-mention', '--top-level', '--as', 'independent', 'raw body',
      ], {
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          SESSION_DATA_DIR: join(dir, 'data'),
          BOTS_CONFIG: join(dir, 'bots.json'),
          BOTMUX_LARK_APP_ID: 'cli_test',
          BOTMUX_LARK_APP_SECRET: 'test',
          BOTMUX_SESSION_ID: 'test-send-xpi',
          BOTMUX_CHAT_ID: 'oc_test',
          BOTMUX_SESSION_SCOPE: 'chat',
          BOTMUX_CARD_PREPARED_CONTENT_FILE: preparedContentFile,
        },
        encoding: 'utf8',
        timeout: 30_000,
      });

      expect(result.status, String(result.stderr)).toBe(0);
      const captured = String(result.stdout).split('\n').find(line => line.startsWith('CAPTURE_CARD='));
      expect(captured, String(result.stdout)).toBeTruthy();
      const card = JSON.parse(captured!.slice('CAPTURE_CARD='.length));
      const markdown = card.body.elements
        .filter((element: any) => element.tag === 'markdown')
        .map((element: any) => element.content)
        .join('\n');

      expect(markdown).toContain('prepared body');
      expect(markdown).toContain('[botmux-as:v1:independent]');
      expect(markdown).not.toContain('raw body');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
